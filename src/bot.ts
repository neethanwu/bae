import crypto from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat } from "chat";
import { handleMessage } from "./bridge.ts";

const WEBHOOK_SECRET =
	process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN || crypto.randomUUID();

export const bot = new Chat({
	userName: "bae",
	adapters: {
		telegram: createTelegramAdapter({
			secretToken: WEBHOOK_SECRET,
		}),
	},
	state: createMemoryState(),
});

if (!process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN) {
	console.warn(
		"[warn] TELEGRAM_WEBHOOK_SECRET_TOKEN not set. Generated temporary secret:",
		WEBHOOK_SECRET,
	);
	console.warn(
		"[warn] Pass this as secret_token when registering the webhook with Telegram.",
	);
}

export { WEBHOOK_SECRET };

bot.onNewMention(async (thread, message) => {
	await thread.subscribe();
	await handleMessage(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
	await handleMessage(thread, message);
});
