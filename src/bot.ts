import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { MessageData, Thread } from "chat";
import { Chat } from "chat";
import { markdownToTelegramHtml } from "./formatter/html.ts";
import { createRetryState } from "./state.ts";

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

	// Override telegramFetch to add parse_mode: "HTML" to all outgoing messages.
	// This intercepts both regular posts AND streaming edits (from fallbackStream).
	// Same approach as OpenClaw: markdown → Telegram HTML, with plain-text fallback.
	// biome-ignore lint/suspicious/noExplicitAny: accessing internal Chat SDK method
	const adapter = telegramAdapter as any;
	if (typeof adapter.telegramFetch !== "function") {
		throw new Error(
			"[bae] Chat SDK Telegram adapter missing telegramFetch — version mismatch?",
		);
	}
	const origFetch = adapter.telegramFetch.bind(adapter);
	adapter.telegramFetch = async (
		method: string,
		// biome-ignore lint/suspicious/noExplicitAny: Telegram API params
		params: any,
	) => {
		if (
			(method === "sendMessage" || method === "editMessageText") &&
			params.text
		) {
			// Guard: skip empty messages — fallbackStream may produce these during markdown healing
			if (!params.text.trim()) {
				console.warn(`[bae:tg] ${method} skipped — empty text after trim`);
				return {
					ok: true,
					result: {
						chat: { id: params.chat_id },
						message_id: params.message_id,
					},
				};
			}
			const originalText = params.text;
			const htmlText = markdownToTelegramHtml(originalText);
			params.text = htmlText;
			params.parse_mode = "HTML";
			console.log(
				`[bae:tg] ${method} (${originalText.length} chars → ${htmlText.length} HTML chars)`,
			);
			try {
				return await origFetch(method, params);
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);

				// "message is not modified" is harmless — Telegram just saw no diff
				if (errMsg.includes("message is not modified")) {
					return {
						ok: true,
						result: {
							chat: { id: params.chat_id },
							message_id: params.message_id,
						},
					};
				}

				console.error(`[bae:tg] ${method} HTML failed: ${errMsg}`);
				console.error(
					`[bae:tg] HTML payload (first 200): ${htmlText.slice(0, 200)}`,
				);
				// Fallback: if Telegram rejects HTML, retry as plain text
				if (err instanceof Error && err.message?.includes("400")) {
					params.text = originalText;
					delete params.parse_mode;
					try {
						return await origFetch(method, params);
					} catch (fallbackErr: unknown) {
						const fbMsg =
							fallbackErr instanceof Error
								? fallbackErr.message
								: String(fallbackErr);
						console.error(
							`[bae:tg] ${method} plain text fallback also failed: ${fbMsg}`,
						);
						throw fallbackErr;
					}
				}
				throw err;
			}
		}
		return origFetch(method, params);
	};

	// Guard: swallow empty-text validation errors from the SDK.
	// thread.post(string) may still trigger fallbackStream internally,
	// and empty markdown can surface during edge cases.
	const origEditMessage = adapter.editMessage.bind(adapter);
	adapter.editMessage = async (...args: unknown[]) => {
		try {
			return await origEditMessage(...args);
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				err.message.includes("Message text cannot be empty")
			) {
				console.warn("[bae:tg] editMessage skipped — empty text");
				return undefined;
			}
			throw err;
		}
	};

	const bot = new Chat({
		userName: "bae",
		adapters: {
			telegram: telegramAdapter,
		},
		state: createRetryState(),
		fallbackStreamingPlaceholderText: "...", // Replaced within ~500ms by first streamed content
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
