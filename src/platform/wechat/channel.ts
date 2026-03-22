/**
 * WeChat platform adapter (iLink Bot API, long polling).
 *
 * Uses the iLink Bot protocol to bridge WeChat messages to CLI agents.
 * - Long-polls getUpdates for incoming messages
 * - Sends responses via sendMessage
 * - Plain text only (Markdown stripped)
 * - DM-only (no group chat support)
 */

import { nanoid } from "nanoid";
import type {
	ChannelHandle,
	PlatformConfig,
	PlatformThread,
} from "../types.ts";
import {
	getConfig,
	getUpdates,
	sendMessage,
	sendTyping,
	type WeChatApiOpts,
} from "./api.ts";
import type { MessageItem } from "./types.ts";
import { MessageItemType, MessageType } from "./types.ts";

export const WECHAT_CONFIG: PlatformConfig = {
	splitSoft: 3500,
	splitHard: 4000,
};

/**
 * Strip Markdown formatting for plain-text WeChat output.
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
 * Extract text content from a WeChat message's item_list.
 * Checks TEXT items first, then falls back to VOICE transcription.
 */
export function extractText(items?: MessageItem[]): string {
	if (!items) return "";
	for (const item of items) {
		if (item.type === MessageItemType.TEXT && item.text_item?.text) {
			return item.text_item.text;
		}
	}
	for (const item of items) {
		if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
			return item.voice_item.text;
		}
	}
	return "";
}

/** Module-scoped context token cache (WeChat is DM-only). */
const contextTokens = new Map<string, string>();

function wechatThread(opts: WeChatApiOpts, toUserId: string): PlatformThread {
	return {
		id: toUserId,

		async post(text: string) {
			const contextToken = contextTokens.get(toUserId);
			if (!contextToken) {
				throw new Error(
					`[bae:wechat] No context token cached for user ${toUserId}`,
				);
			}
			const clientId = nanoid();
			await sendMessage(opts, {
				msg: {
					from_user_id: "",
					to_user_id: toUserId,
					client_id: clientId,
					message_type: MessageType.BOT,
					message_state: 2, // FINISH
					item_list: [
						{
							type: MessageItemType.TEXT,
							text_item: { text: stripMarkdown(text) },
						},
					],
					context_token: contextToken,
				},
			});
		},

		async postStream(chunks: AsyncIterable<string>) {
			let full = "";
			for await (const chunk of chunks) full += chunk;
			if (full) await this.post(full);
		},

		async startTyping() {
			try {
				const contextToken = contextTokens.get(toUserId);
				if (!contextToken) return;
				const config = await getConfig(opts, toUserId, contextToken);
				if (config.typing_ticket) {
					await sendTyping(opts, {
						ilink_user_id: toUserId,
						typing_ticket: config.typing_ticket,
					});
				}
			} catch {
				// Best effort — silently swallow errors
			}
		},
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

async function monitor(
	opts: WeChatApiOpts,
	onMessage: (
		thread: PlatformThread,
		userId: string,
		text: string,
	) => Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	let getUpdatesBuf = "";
	let consecutiveFailures = 0;

	while (!signal.aborted) {
		try {
			const resp = await getUpdates(opts, getUpdatesBuf);

			// Check API-level errors
			if (resp.ret !== 0 && resp.ret !== undefined) {
				if (resp.errcode === -14) {
					// Session expired — back off significantly
					console.warn(
						"[bae:wechat] Session expired (errcode -14), sleeping 5 min",
					);
					await sleep(5 * 60 * 1000, signal);
					continue;
				}
				consecutiveFailures++;
				const backoff = consecutiveFailures >= 3 ? 30_000 : 2_000;
				console.warn(
					`[bae:wechat] API error ret=${resp.ret} errcode=${resp.errcode}: ${resp.errmsg ?? "unknown"}, backoff ${backoff}ms`,
				);
				await sleep(backoff, signal);
				continue;
			}

			// Success — reset failures
			consecutiveFailures = 0;

			if (resp.get_updates_buf) {
				getUpdatesBuf = resp.get_updates_buf;
			}

			if (resp.msgs) {
				for (const msg of resp.msgs) {
					// Only process user messages
					if (msg.message_type !== MessageType.USER) continue;

					// Cache context token
					if (msg.from_user_id && msg.context_token) {
						contextTokens.set(msg.from_user_id, msg.context_token);
					}

					const text = extractText(msg.item_list);
					if (!text || !msg.from_user_id) continue;

					const thread = wechatThread(opts, msg.from_user_id);
					await onMessage(thread, msg.from_user_id, text);
				}
			}
		} catch (err) {
			if (signal.aborted) return;
			consecutiveFailures++;
			const backoff = consecutiveFailures >= 3 ? 30_000 : 2_000;
			console.error(
				`[bae:wechat] Poll error (${consecutiveFailures} consecutive), backoff ${backoff}ms:`,
				err,
			);
			try {
				await sleep(backoff, signal);
			} catch {
				return; // Aborted during sleep
			}
		}
	}
}

export interface CreateWeChatChannelOptions {
	baseUrl: string;
	token: string;
	channelId: string;
	onMessage: (
		thread: PlatformThread,
		userId: string,
		text: string,
	) => Promise<void>;
}

export function createWeChatChannel(
	options: CreateWeChatChannelOptions,
): ChannelHandle {
	const controller = new AbortController();
	const opts: WeChatApiOpts = {
		baseUrl: options.baseUrl,
		token: options.token,
	};

	return {
		start: async () => {
			console.log("[bae:wechat] Starting long-poll monitor...");
			monitor(opts, options.onMessage, controller.signal).catch((err) => {
				if (!controller.signal.aborted) {
					console.error("[bae:wechat] Monitor exited with error:", err);
				}
			});
		},
		stop: async () => {
			controller.abort();
		},
	};
}
