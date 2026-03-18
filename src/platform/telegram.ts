/**
 * Telegram platform adapter.
 *
 * Wraps the Chat SDK's Thread into a PlatformThread.
 * The Chat SDK handles long polling, message formatting (HTML),
 * and streaming (fallbackStream via edit-in-place).
 */

import type { Thread } from "chat";
import type { PlatformConfig, PlatformThread } from "./types.ts";

/**
 * Wrap a Chat SDK Thread into a PlatformThread.
 */
export function telegramThread(thread: Thread): PlatformThread {
	return {
		id: String(thread.id),
		post: async (text) => {
			await thread.post(text);
		},
		postStream: async (chunks) => {
			await thread.post(chunks); // Chat SDK's fallbackStream
		},
		startTyping: () => thread.startTyping(),
	};
}

export const TELEGRAM_CONFIG: PlatformConfig = {
	splitSoft: 2000,
	splitHard: 2500,
};
