/**
 * Slack platform adapter.
 *
 * Uses Socket Mode (outbound WebSocket, no tunnel) for receiving events
 * and the native streaming API (ChatStreamer) for real-time responses.
 * Bypasses the Chat SDK — uses @slack/socket-mode + @slack/web-api directly.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type {
	Attachment,
	ChannelHandle,
	PlatformConfig,
	PlatformThread,
} from "./types.ts";
import {
	MAX_ATTACHMENT_BYTES,
	MAX_TOTAL_ATTACHMENT_BYTES,
	sanitizeFilename,
} from "./types.ts";

export const SLACK_CONFIG: PlatformConfig = {
	splitSoft: 10000,
	splitHard: 12000,
};

// --- Slack PlatformThread ---

/**
 * Create a PlatformThread for Slack.
 *
 * Uses native streaming API (chatStream) for responses — no "(edited)" tag,
 * real-time streaming UX. Responses appear as thread replies, which is the
 * standard pattern for AI assistants in Slack (Claude, ChatGPT, etc.).
 */
export function slackThread(
	web: WebClient,
	channel: string,
	threadTs: string,
): PlatformThread {
	return {
		id: channel, // DM channel ID = conversationId

		async post(text: string) {
			await web.chat.postMessage({
				channel,
				text,
				thread_ts: threadTs || undefined,
			});
		},

		async postStream(chunks: AsyncIterable<string>) {
			let accumulated = "";
			try {
				const streamer = web.chatStream({
					channel,
					thread_ts: threadTs,
				});

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
						thread_ts: threadTs || undefined,
					});
				}
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
		attachments?: Attachment[],
	) => Promise<void>;
}

/**
 * Download file attachments from a Slack message.
 * Slack's url_private requires Bearer token authentication.
 */
async function downloadSlackFiles(
	// biome-ignore lint/suspicious/noExplicitAny: Slack event files type
	files: any[] | undefined,
	botToken: string,
	thread: PlatformThread,
): Promise<Attachment[] | undefined> {
	if (!files?.length) return undefined;

	const results: Attachment[] = [];
	let totalBytes = 0;

	for (const file of files) {
		try {
			const url = file.url_private;
			if (!url) continue;

			const resp = await fetch(url, {
				headers: { Authorization: `Bearer ${botToken}` },
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

			const data = Buffer.from(await resp.arrayBuffer());

			if (data.length > MAX_ATTACHMENT_BYTES) {
				const sizeMB = (data.length / 1024 / 1024).toFixed(1);
				console.warn(
					`[bae:slack] Skipped '${file.name ?? "file"}' (${sizeMB} MB > 10 MB)`,
				);
				await thread
					.post(
						`Skipped '${file.name ?? "file"}' (${sizeMB} MB) — max attachment size is 10 MB.`,
					)
					.catch(() => {});
				continue;
			}

			totalBytes += data.length;
			if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
				console.warn("[bae:slack] Total size exceeds 20 MB, stopping");
				await thread
					.post("Some attachments skipped — total size exceeds 20 MB.")
					.catch(() => {});
				break;
			}

			results.push({
				filename: sanitizeFilename(file.name ?? "attachment"),
				mimeType: file.mimetype ?? "application/octet-stream",
				data,
			});
		} catch (err) {
			const name = file.name ?? "file";
			console.error(`[bae:slack] Failed to download '${name}':`, err);
			await thread
				.post(`Could not download attachment '${name}'.`)
				.catch(() => {});
		}
	}

	return results.length > 0 ? results : undefined;
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
		if (event.bot_id) return;
		// Allow file_share subtype for attachment support, filter others
		if (event.subtype && event.subtype !== "file_share") return;

		const hasFiles = event.files?.length > 0;
		if (!event.text && !event.user && !hasFiles) return;
		if (!event.user) return;

		const dedupKey = event.client_msg_id || event.ts;
		if (isDuplicate(dedupKey)) return;

		const thread = slackThread(web, event.channel, event.thread_ts || event.ts);

		// Download file attachments
		const attachments = await downloadSlackFiles(
			event.files,
			options.botToken,
			thread,
		);

		await options.onMessage(thread, event.user, event.text ?? "", attachments);
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
