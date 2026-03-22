import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat } from "chat";
import { markdownToTelegramHtml } from "./formatter/html.ts";
import { createIMessageChannel } from "./platform/imessage.ts";
import { createSlackChannel } from "./platform/slack.ts";
import { telegramThread } from "./platform/telegram.ts";
import type { ChannelHandle, PlatformThread } from "./platform/types.ts";
import { createWeChatChannel } from "./platform/wechat/channel.ts";
import type { Platform } from "./session/types.ts";
import { createRetryState } from "./state.ts";

export type { ChannelHandle };

export interface CreateChannelOptions {
	platform: Platform;
	credentials: Record<string, string>;
	channelId: string;
	onMessage: (
		thread: PlatformThread,
		userId: string,
		text: string,
	) => Promise<void>;
}

/**
 * Create and configure a platform channel adapter.
 *
 * Each channel gets its own adapter instance with its own state,
 * preventing dedup key collisions when multiple channels exist.
 */
export function createChannel(options: CreateChannelOptions): ChannelHandle {
	const { platform, credentials, onMessage } = options;

	switch (platform) {
		case "telegram":
			return createTelegramChannel(credentials, onMessage);
		case "slack":
			return createSlackChannel({
				botToken: credentials.SLACK_BOT_TOKEN ?? "",
				appToken: credentials.SLACK_APP_TOKEN ?? "",
				channelId: options.channelId,
				onMessage,
			});
		case "imessage":
			return createIMessageChannel({
				channelId: options.channelId,
				onMessage,
			});
		case "wechat":
			return createWeChatChannel({
				baseUrl: credentials.WECHAT_BASE_URL ?? "https://ilinkai.weixin.qq.com",
				token: credentials.WECHAT_BOT_TOKEN ?? "",
				channelId: options.channelId,
				onMessage,
			});
	}
}

function createTelegramChannel(
	credentials: Record<string, string>,
	onMessage: (
		thread: PlatformThread,
		userId: string,
		text: string,
	) => Promise<void>,
): ChannelHandle {
	// Pass token DIRECTLY — no process.env mutation
	const telegramAdapter = createTelegramAdapter({
		botToken: credentials.TELEGRAM_BOT_TOKEN,
		mode: "auto",
	});

	// Override telegramFetch to add parse_mode: "HTML" to all outgoing messages.
	// This intercepts both regular posts AND streaming edits (from fallbackStream).
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
	const bot = new Chat({
		userName: "bae",
		adapters: {
			telegram: telegramAdapter,
		},
		state: createRetryState(),
		fallbackStreamingPlaceholderText: "...",
	});

	// Wrap Chat SDK callbacks: extract userId/text, wrap Thread → PlatformThread
	const handleChatMessage = async (
		chatThread: Parameters<Parameters<typeof bot.onDirectMessage>[0]>[0],
		message: Parameters<Parameters<typeof bot.onDirectMessage>[0]>[1],
	) => {
		const thread = telegramThread(chatThread);
		const userId = message.author?.userId ?? "";
		const text = message.text ?? "";
		await onMessage(thread, userId, text);
	};

	bot.onDirectMessage(async (thread, message) => {
		await thread.subscribe();
		await handleChatMessage(thread, message);
	});

	bot.onNewMessage(/./, async (thread, message) => {
		await thread.subscribe();
		await handleChatMessage(thread, message);
	});

	bot.onSubscribedMessage(async (thread, message) => {
		await handleChatMessage(thread, message);
	});

	return {
		start: () => bot.initialize(),
		stop: async () => {
			await telegramAdapter.stopPolling();
			await bot.shutdown();
		},
	};
}
