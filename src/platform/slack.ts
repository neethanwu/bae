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

/**
 * Create a PlatformThread for Slack.
 *
 * @param useThread - If true, replies go in a thread (for group/channel use).
 *                    If false, replies are top-level DM messages (default for DMs).
 */
export function slackThread(
	web: WebClient,
	channel: string,
	threadTs: string,
	useThread = false,
): PlatformThread {
	const replyTs = useThread && threadTs ? threadTs : undefined;

	// Track a placeholder message for typing indicator
	let typingTs: string | null = null;

	return {
		id: channel, // DM channel ID = conversationId

		async post(text: string) {
			// If we have a typing placeholder, edit it instead of posting new
			if (typingTs) {
				const ts = typingTs;
				typingTs = null;
				await web.chat.update({ channel, ts, text });
				return;
			}
			await web.chat.postMessage({
				channel,
				text,
				thread_ts: replyTs,
			});
		},

		async postStream(chunks: AsyncIterable<string>) {
			// Delete typing placeholder before streaming (stream creates its own message)
			if (typingTs) {
				await web.chat.delete({ channel, ts: typingTs }).catch(() => {});
				typingTs = null;
			}

			let accumulated = "";
			try {
				const streamerOpts: Record<string, unknown> = { channel };
				if (replyTs) streamerOpts.thread_ts = replyTs;
				const streamer = web.chatStream(
					streamerOpts as Parameters<typeof web.chatStream>[0],
				);

				for await (const chunk of chunks) {
					accumulated += chunk;
					await streamer.append({ markdown_text: chunk });
				}

				await streamer.stop();
			} catch (err) {
				console.error("[bae:slack] Streaming failed, falling back:", err);
				let full = accumulated;
				try {
					for await (const chunk of chunks) full += chunk;
				} catch {
					// Iterator may be exhausted
				}
				if (full) {
					await web.chat.postMessage({
						channel,
						text: full,
						thread_ts: replyTs,
					});
				}
			}
		},

		async startTyping() {
			// Post a "..." placeholder as a typing indicator
			// Gets deleted when streaming starts, or edited when a discrete message posts
			if (!typingTs) {
				try {
					const result = await web.chat.postMessage({
						channel,
						text: "...",
						thread_ts: replyTs,
					});
					typingTs = result.ts ?? null;
				} catch {
					// Non-critical — just means no typing indicator
				}
			}
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
