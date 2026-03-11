import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat } from "chat";
import { handleMessage } from "./bridge.ts";

const telegramAdapter = createTelegramAdapter({
	mode: "auto", // polling locally, webhook in production (serverless)
});

export const bot = new Chat({
	userName: "bae",
	adapters: {
		telegram: telegramAdapter,
	},
	state: createMemoryState(),
});

// DM-only: every message in a new thread triggers handleMessage
bot.onNewMessage(/./, async (thread, message) => {
	await thread.subscribe();
	await handleMessage(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
	await handleMessage(thread, message);
});

// Start polling (no-op if in webhook mode)
void bot.initialize();
