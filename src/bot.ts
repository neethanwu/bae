import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { MessageData, Thread } from "chat";
import { Chat } from "chat";

export interface BotHandle {
	start(): Promise<void>;
	stop(): void;
}

/**
 * Create and configure the Chat SDK bot.
 *
 * Sets TELEGRAM_BOT_TOKEN in process.env before adapter init
 * (Chat SDK reads it from env internally).
 */
export function createBot(
	botToken: string,
	onMessage: (thread: Thread, message: MessageData) => Promise<void>,
): BotHandle {
	process.env.TELEGRAM_BOT_TOKEN = botToken;

	const telegramAdapter = createTelegramAdapter({
		mode: "auto", // polling locally, webhook in production (serverless)
	});

	const bot = new Chat({
		userName: "bae",
		adapters: {
			telegram: telegramAdapter,
		},
		state: createMemoryState(),
	});

	// DM-only: every message triggers onMessage
	bot.onNewMessage(/./, async (thread, message) => {
		await thread.subscribe();
		await onMessage(thread, message);
	});

	bot.onSubscribedMessage(async (thread, message) => {
		await onMessage(thread, message);
	});

	return {
		start: () => bot.initialize(),
		stop: () => {
			// Chat SDK doesn't expose a stop method — process exit handles cleanup
		},
	};
}
