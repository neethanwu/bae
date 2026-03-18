/**
 * Slack platform adapter.
 *
 * Uses Socket Mode (outbound WebSocket, no tunnel) for receiving events
 * and the native streaming API (ChatStreamer) for real-time responses.
 * Bypasses the Chat SDK — uses @slack/socket-mode + @slack/web-api directly.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ChannelHandle, PlatformConfig, PlatformThread } from "./types.ts";

export const SLACK_CONFIG: PlatformConfig = {
	splitSoft: 10000,
	splitHard: 12000,
};

// --- Slack PlatformThread ---

const STREAM_UPDATE_INTERVAL_MS = 1000; // chat.update rate: ~50/min → 1 update/sec is safe

/**
 * Create a PlatformThread for Slack.
 *
 * DMs: flat replies (no thread_ts), streaming via post+edit.
 * Groups/channels (future): threaded, streaming via ChatStreamer.
 */
export function slackThread(
	web: WebClient,
	channel: string,
	threadTs: string,
	useThread = false,
): PlatformThread {
	const replyTs = useThread && threadTs ? threadTs : undefined;

	return {
		id: channel, // DM channel ID = conversationId

		async post(text: string) {
			await web.chat.postMessage({
				channel,
				text,
				thread_ts: replyTs,
			});
		},

		async postStream(chunks: AsyncIterable<string>) {
			// DM streaming: post a message then edit it progressively.
			// Similar to Telegram's fallbackStream (edit-in-place).
			// chat.update is Tier 3 (~50/min), so update every ~1s.
			let accumulated = "";
			let messageTs: string | null = null;
			let lastUpdate = 0;

			for await (const chunk of chunks) {
				accumulated += chunk;
				const now = Date.now();

				if (!messageTs) {
					// First chunk — post the initial message
					try {
						const result = await web.chat.postMessage({
							channel,
							text: accumulated,
							thread_ts: replyTs,
						});
						messageTs = result.ts ?? null;
						lastUpdate = now;
					} catch (err) {
						console.error("[bae:slack] Failed to post initial message:", err);
					}
				} else if (now - lastUpdate >= STREAM_UPDATE_INTERVAL_MS) {
					// Subsequent chunks — edit the message
					try {
						await web.chat.update({
							channel,
							ts: messageTs,
							text: accumulated,
						});
						lastUpdate = now;
					} catch (err) {
						// "message not modified" is harmless
						const msg = err instanceof Error ? err.message : "";
						if (!msg.includes("not_modified")) {
							console.error("[bae:slack] Failed to update message:", err);
						}
					}
				}
			}

			// Final update with complete text
			if (messageTs && accumulated) {
				try {
					await web.chat.update({
						channel,
						ts: messageTs,
						text: accumulated,
					});
				} catch {
					// Best effort
				}
			} else if (!messageTs && accumulated) {
				// Never managed to post — send as discrete message
				await web.chat.postMessage({
					channel,
					text: accumulated,
					thread_ts: replyTs,
				});
			}
		},

		async startTyping() {
			// Slack has no typing indicator API for bots in DMs — no-op
		},
	};
}

// --- Slack Channel Adapter ---

export interface CreateSlackChannelOptions {
	botToken: string;
	appToken: string;
	channelId: string;
	onMessage: (
		thread: PlatformThread,
		userId: string,
		text: string,
	) => Promise<void>;
}

export function createSlackChannel(
	options: CreateSlackChannelOptions,
): ChannelHandle {
	const web = new WebClient(options.botToken);
	const socket = new SocketModeClient({ appToken: options.appToken });

	// Message dedup — Socket Mode retries if ack is slow
	const seen = new Map<string, number>();
	const DEDUP_TTL_MS = 60_000;

	function isDuplicate(key: string): boolean {
		const now = Date.now();
		// Prune old entries
		for (const [k, ts] of seen) {
			if (now - ts > DEDUP_TTL_MS) seen.delete(k);
		}
		if (seen.has(key)) return true;
		seen.set(key, now);
		return false;
	}

	// DM messages via Events API
	socket.on("message", async ({ ack, event }) => {
		await ack(); // Must ack within 3 seconds
		if (event.channel_type !== "im") return;
		if (event.bot_id || event.subtype) return;
		if (!event.text || !event.user) return;

		const dedupKey = event.client_msg_id || event.ts;
		if (isDuplicate(dedupKey)) return;

		// DMs: no threading (flat replies). If this is already inside a thread
		// (user replied in a thread), respect it.
		const isInThread = !!event.thread_ts;
		const thread = slackThread(web, event.channel, event.ts, isInThread);
		await options.onMessage(thread, event.user, event.text);
	});

	// /new slash command
	socket.on("slash_commands", async ({ ack, body }) => {
		if (body.command === "/new") {
			await ack({ text: "Starting fresh..." });
			const thread = slackThread(web, body.channel_id, "");
			await options.onMessage(thread, body.user_id, "/new");
		} else {
			await ack();
		}
	});

	// Lifecycle logging
	socket.on("connected", () => console.log("[bae:slack] Connected"));
	socket.on("reconnecting", () => console.log("[bae:slack] Reconnecting..."));
	socket.on("disconnected", () => console.log("[bae:slack] Disconnected"));

	return {
		start: async () => {
			await socket.start();
		},
		stop: async () => {
			await socket.disconnect();
		},
	};
}
