import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { MessageData, Thread } from "chat";
import { Chat } from "chat";
import { markdownToTelegramHtml } from "./formatter/html.ts";
import type { Platform } from "./session/types.ts";
import { createRetryState } from "./state.ts";

export interface BotHandle {
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface CreateBotOptions {
	platform: Platform;
	credentials: Record<string, string>;
	channelId: string;
	onMessage: (thread: Thread, message: MessageData) => Promise<void>;
}

/**
 * Create and configure a Chat SDK bot for a single channel.
 *
 * Each channel gets its own Chat instance with its own adapter and state,
 * preventing dedup key collisions when multiple bots are in the same group.
 */
export function createBot(options: CreateBotOptions): BotHandle {
	const { platform, credentials, onMessage } = options;

	if (platform === "telegram") {
		return createTelegramBot(credentials, onMessage);
	}

	throw new Error(`Unsupported platform: ${platform}`);
}

function createTelegramBot(
	credentials: Record<string, string>,
	onMessage: (thread: Thread, message: MessageData) => Promise<void>,
): BotHandle {
	// Pass token DIRECTLY — no process.env mutation
	const telegramAdapter = createTelegramAdapter({
		botToken: credentials.TELEGRAM_BOT_TOKEN,
		mode: "auto",
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
		// biome-ignore lint/suspicious/noExplicitAny: internal SDK request options (AbortSignal)
		request?: any,
	) => {
		if (
			(method === "sendMessage" || method === "editMessageText") &&
			params.text
		) {
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
				return await origFetch(method, params, request);
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);

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
				if (err instanceof Error && err.message?.includes("400")) {
					params.text = originalText;
					delete params.parse_mode;
					try {
						return await origFetch(method, params, request);
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
		return origFetch(method, params, request);
	};

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

	// Separate state adapter per instance — prevents dedup key collisions
	// when multiple bots are in the same Telegram group
	const bot = new Chat({
		userName: "bae",
		adapters: {
			telegram: telegramAdapter,
		},
		state: createRetryState(),
		fallbackStreamingPlaceholderText: "...",
	});

	bot.onDirectMessage(async (thread, message) => {
		await thread.subscribe();
		await onMessage(thread, message);
	});

	bot.onNewMessage(/./, async (thread, message) => {
		await thread.subscribe();
		await onMessage(thread, message);
	});

	bot.onSubscribedMessage(async (thread, message) => {
		await onMessage(thread, message);
	});

	return {
		start: () => bot.initialize(),
		stop: async () => {
			// Chat.shutdown() does NOT stop polling — must call adapter method directly
			await telegramAdapter.stopPolling();
			await bot.shutdown();
		},
	};
}
