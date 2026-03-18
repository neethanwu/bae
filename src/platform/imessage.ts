/**
 * iMessage platform adapter (local mode).
 *
 * Uses the Chat SDK's chat-adapter-imessage in local mode:
 * - Reads incoming messages by polling ~/Library/Messages/chat.db (SQLite, read-only)
 * - Sends responses via AppleScript (osascript → Messages.app)
 * - macOS only, requires Full Disk Access for the terminal
 * - No API keys, no hosted services — fully local
 * - Plain text only (no Markdown formatting, no streaming)
 */

import type { MessageData, Thread } from "chat";
import { Chat } from "chat";
import { createiMessageAdapter } from "chat-adapter-imessage";
import { createRetryState } from "../state.ts";
import type { ChannelHandle, PlatformConfig, PlatformThread } from "./types.ts";

export const IMESSAGE_CONFIG: PlatformConfig = {
	// iMessage has no practical message limit (~20k chars)
	splitSoft: 15000,
	splitHard: 18000,
};

/**
 * Wrap a Chat SDK Thread for iMessage.
 * Plain text only — strips Markdown from agent output.
 * No streaming — collects all chunks and posts once.
 */
export function imessageThread(thread: Thread): PlatformThread {
	return {
		id: String(thread.id),
		async post(text: string) {
			await thread.post(stripMarkdown(text));
		},
		async postStream(chunks: AsyncIterable<string>) {
			// iMessage does not support streaming — collect and post once
			let full = "";
			for await (const chunk of chunks) full += chunk;
			if (full) await thread.post(stripMarkdown(full));
		},
		async startTyping() {
			// iMessage has no typing indicator API in local mode — no-op
		},
	};
}

/**
 * Strip Markdown formatting for plain-text iMessage output.
 */
export function stripMarkdown(text: string): string {
	return (
		text
			// Remove bold markers
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/__(.+?)__/g, "$1")
			// Remove italic markers (single * or _)
			.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
			// Remove strikethrough
			.replace(/~~(.+?)~~/g, "$1")
			// Convert links: [text](url) → text (url)
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
			// Remove header markers
			.replace(/^#{1,6}\s+/gm, "")
	);
}

// --- iMessage Channel Adapter ---

export interface CreateIMessageChannelOptions {
	channelId: string;
	onMessage: (
		thread: PlatformThread,
		userId: string,
		text: string,
	) => Promise<void>;
}

export function createIMessageChannel(
	options: CreateIMessageChannelOptions,
): ChannelHandle {
	const adapter = createiMessageAdapter({ local: true });
	const abortController = new AbortController();

	// The iMessage adapter (v0.1.1) targets Chat SDK ^4.14.0 but BAE uses 4.20.2.
	// Some newer interface methods may be missing — cast to avoid type errors.
	// The Chat SDK handles missing methods gracefully at runtime.
	const bot = new Chat({
		userName: "bae",
		// biome-ignore lint/suspicious/noExplicitAny: adapter version compat shim
		adapters: { imessage: adapter as any },
		state: createRetryState(),
	});

	const handleMessage = async (chatThread: Thread, message: MessageData) => {
		const thread = imessageThread(chatThread);
		const userId = message.author?.userId ?? "";
		const text = message.text ?? "";
		await options.onMessage(thread, userId, text);
	};

	bot.onDirectMessage(async (thread, message) => {
		await thread.subscribe();
		await handleMessage(thread, message);
	});

	bot.onNewMessage(/./, async (thread, message) => {
		await thread.subscribe();
		await handleMessage(thread, message);
	});

	bot.onSubscribedMessage(async (thread, message) => {
		await handleMessage(thread, message);
	});

	return {
		start: async () => {
			await bot.initialize();
			// Start gateway listener (SQLite polling) — runs until aborted
			// API: startGatewayListener(options, durationMs?, abortSignal?)
			adapter
				.startGatewayListener(
					{},
					Number.MAX_SAFE_INTEGER,
					abortController.signal,
				)
				.catch((err: unknown) => {
					const name = err instanceof Error ? err.name : "";
					if (name !== "AbortError") {
						console.error("[bae:imessage] Gateway listener error:", err);
					}
				});
			console.log("[bae:imessage] Listening for messages (polling chat.db)");
		},
		stop: async () => {
			abortController.abort();
			await bot.shutdown();
		},
	};
}
