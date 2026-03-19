/**
 * iMessage platform adapter (direct SDK, local mode).
 *
 * Uses @photon-ai/imessage-kit directly (not the Chat SDK community adapter)
 * to support self-messaging ("Note to Self") for personal use.
 *
 * - Polls ~/Library/Messages/chat.db with excludeOwnMessages: false
 * - Sends via AppleScript (osascript → Messages.app)
 * - Agent responses prefixed with "Bae: " for loop prevention
 * - macOS only, requires Full Disk Access
 * - Plain text only (Markdown stripped)
 */

import { execSync } from "node:child_process";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { ChannelHandle, PlatformConfig, PlatformThread } from "./types.ts";

export const IMESSAGE_CONFIG: PlatformConfig = {
	splitSoft: 15000,
	splitHard: 18000,
};

const BAE_PREFIX = "Bae: ";

/**
 * Strip Markdown formatting for plain-text iMessage output.
 */
export function stripMarkdown(text: string): string {
	return text
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/^#{1,6}\s+/gm, "");
}

/**
 * Ensure Messages.app is running (required for AppleScript sending).
 * Launches it if not already open.
 */
async function ensureMessagesApp(): Promise<void> {
	try {
		// Check if Messages is running
		const result = execSync(
			'osascript -e \'tell application "System Events" to (name of processes) contains "Messages"\'',
			{ encoding: "utf-8", timeout: 5000 },
		).trim();
		if (result !== "true") {
			console.log("[bae:imessage] Launching Messages.app...");
			execSync('open -a "Messages"', { timeout: 5000 });
			// Wait for it to start
			await new Promise((r) => setTimeout(r, 2000));
		}
	} catch {
		// Best effort — the SDK will retry or error with a clear message
	}
}

/**
 * Create a PlatformThread for iMessage.
 * All agent responses are prefixed with "Bae: " for loop prevention
 * and visual distinction in self-chat conversations.
 */
function imessageThread(sdk: IMessageSDK, chatId: string): PlatformThread {
	return {
		id: chatId,

		async post(text: string) {
			const prefixed = `${BAE_PREFIX}${stripMarkdown(text)}`;
			await ensureMessagesApp();
			await sdk.send(chatId, prefixed);
		},

		async postStream(chunks: AsyncIterable<string>) {
			// No streaming — collect and post once
			let full = "";
			for await (const chunk of chunks) full += chunk;
			if (full) {
				const prefixed = `${BAE_PREFIX}${stripMarkdown(full)}`;
				await ensureMessagesApp();
				await sdk.send(chatId, prefixed);
			}
		},

		async startTyping() {
			// iMessage has no typing indicator — no-op
		},
	};
}

// --- Channel Adapter ---

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
	const sdk = new IMessageSDK({
		watcher: {
			excludeOwnMessages: false, // Enable self-messaging
			pollInterval: 2000,
		},
	});

	// Message dedup — self-chat produces duplicate entries (sent + iCloud synced)
	// iCloud sync creates a DIFFERENT message ID, so we dedup on content + chatId
	const seen = new Map<string, number>();
	const DEDUP_TTL_MS = 10_000; // 10s window for sync duplicates

	function isDuplicate(message: {
		id: string;
		text: string | null;
		chatId: string;
	}): boolean {
		const now = Date.now();
		// Prune old entries
		for (const [k, ts] of seen) {
			if (now - ts > DEDUP_TTL_MS) seen.delete(k);
		}
		// Key on both message ID (exact dedup) and content+chat (sync dedup)
		const contentKey = `${message.chatId}:${message.text}`;
		if (seen.has(message.id) || seen.has(contentKey)) return true;
		seen.set(message.id, now);
		seen.set(contentKey, now);
		return false;
	}

	return {
		start: async () => {
			// Ensure Messages.app is running at startup
			await ensureMessagesApp();

			await sdk.startWatching({
				onMessage: async (message) => {
					// Loop prevention: skip agent responses (they start with "Bae: ")
					if (message.text?.startsWith(BAE_PREFIX)) return;

					// Skip messages without text
					if (!message.text) return;

					// Dedup: self-chat messages appear twice (sent + iCloud sync)
					if (isDuplicate(message)) return;

					const thread = imessageThread(sdk, message.chatId);
					await options.onMessage(thread, message.sender, message.text);
				},
				onError: (error) => {
					console.error("[bae:imessage] Watcher error:", error);
				},
			});
			console.log(
				"[bae:imessage] Listening for messages (self-messaging enabled)",
			);
		},
		stop: async () => {
			sdk.stopWatching();
		},
	};
}
