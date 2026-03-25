/**
 * Email platform adapter (AgentMail, WebSocket).
 *
 * Uses the AgentMail SDK to bridge email messages to CLI agents.
 * - WebSocket connection for real-time inbound email
 * - Replies via AgentMail reply API (auto-threads)
 * - Plain text only (Markdown stripped)
 * - Label-based dedup for reconnection catch-up
 */

import type { AgentMailClient } from "agentmail";
import type {
	ChannelHandle,
	PlatformConfig,
	PlatformThread,
} from "../types.ts";
import { createClient } from "./api.ts";

export const EMAIL_CONFIG: PlatformConfig = {
	splitSoft: 50000,
	splitHard: 60000,
};

/**
 * Strip Markdown formatting for plain-text email output.
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
 * Extract a bare email address from a `from` field that may be
 * either `"user@example.com"` or `"Display Name <user@example.com>"`.
 */
export function extractEmail(from: string): string {
	const match = from.match(/<([^>]+)>/);
	return match?.[1] ?? from.trim();
}

/** Module-scoped map of threadId -> lastMessageId for reply threading. */
const lastMessageIds = new Map<string, string>();

function emailThread(
	client: AgentMailClient,
	inboxId: string,
	threadId: string,
): PlatformThread {
	return {
		id: threadId,

		async post(text: string) {
			const messageId = lastMessageIds.get(threadId);
			if (!messageId) {
				throw new Error(
					`[bae:email] No message ID tracked for thread ${threadId}`,
				);
			}
			await client.inboxes.messages.reply(inboxId, messageId, {
				text: stripMarkdown(text),
			});
			// Mark as replied for dedup on reconnection
			try {
				await client.inboxes.messages.update(inboxId, messageId, {
					addLabels: ["replied"],
					removeLabels: ["unreplied"],
				});
			} catch {
				// Best effort — label update failure should not break the reply
			}
		},

		async postStream(chunks: AsyncIterable<string>) {
			let full = "";
			for await (const chunk of chunks) full += chunk;
			if (full) await this.post(full);
		},

		async startTyping() {
			// Email has no typing indicator — no-op
		},
	};
}

export interface CreateEmailChannelOptions {
	apiKey: string;
	inboxId: string;
	workspaceSlug?: string;
	channelId: string;
	onMessage: (
		thread: PlatformThread,
		userId: string,
		text: string,
	) => Promise<void>;
}

export function createEmailChannel(
	options: CreateEmailChannelOptions,
): ChannelHandle {
	const { apiKey, inboxId, workspaceSlug, onMessage } = options;
	const client = createClient(apiKey);

	type Socket = Awaited<ReturnType<typeof client.websockets.connect>>;
	let socket: Socket | null = null;
	let aborted = false;

	/**
	 * Process a single received message: extract sender, text, thread, and dispatch.
	 */
	async function processMessage(msg: {
		from: string;
		extractedText?: string | null;
		text?: string | null;
		subject?: string | null;
		threadId: string;
		messageId: string;
	}): Promise<void> {
		const body = msg.extractedText || msg.text || "";
		if (!body.trim()) return; // Skip empty / attachment-only emails

		const sender = extractEmail(msg.from);
		lastMessageIds.set(msg.threadId, msg.messageId);

		// Prepend email context so the agent knows the channel and can adapt tone
		const subjectLine = msg.subject ? ` | Subject: "${msg.subject}"` : "";
		const prefixed = `[Email from ${sender}${subjectLine}]\nYour reply will be sent as an email. Keep it concise and well-structured.\n\n${body}`;

		const thread = emailThread(client, inboxId, msg.threadId);
		await onMessage(thread, sender, prefixed);
	}

	/**
	 * Catch up on messages missed during downtime by querying unreplied messages.
	 */
	async function catchUp(): Promise<void> {
		try {
			const resp = await client.inboxes.messages.list(inboxId, {
				labels: ["unreplied"],
			});
			const messages = resp.messages ?? [];
			if (messages.length > 0) {
				console.log(
					`[bae:email] Catching up on ${messages.length} unreplied message(s)`,
				);
				for (const item of messages) {
					try {
						// MessageItem from list doesn't include text/extractedText,
						// so fetch the full message to get the body content.
						const full = await client.inboxes.messages.get(
							inboxId,
							item.messageId,
						);
						await processMessage({
							from: full.from,
							extractedText: full.extractedText ?? null,
							text: full.text ?? null,
							subject: full.subject ?? null,
							threadId: full.threadId,
							messageId: full.messageId,
						});
					} catch (err) {
						console.error(
							"[bae:email] Error processing catch-up message:",
							err,
						);
					}
				}
			}
		} catch (err) {
			console.warn("[bae:email] Catch-up query failed:", err);
		}
	}

	/**
	 * Connect WebSocket and monitor for incoming emails.
	 */
	async function monitor(): Promise<void> {
		if (aborted) return;

		try {
			socket = await client.websockets.connect();
		} catch (err) {
			console.error("[bae:email] WebSocket connect failed:", err);
			return;
		}

		// SDK's connect() resolves after the socket is already open,
		// so subscribe immediately — don't rely on the "open" event.
		console.log("[bae:email] WebSocket connected, subscribing...");
		socket.sendSubscribe({
			type: "subscribe",
			inboxIds: [inboxId],
			eventTypes: ["message.received"],
		});

		socket.on("message", async (event) => {
			try {
				if (event.type === "event" && event.eventType === "message.received") {
					const msg = event.message;
					await processMessage({
						from: msg.from,
						extractedText: msg.extractedText ?? null,
						text: msg.text ?? null,
						subject: msg.subject ?? null,
						threadId: msg.threadId,
						messageId: msg.messageId,
					});
				}
			} catch (err) {
				console.error("[bae:email] Error handling WebSocket event:", err);
			}
		});

		socket.on("close", (event) => {
			if (!aborted) {
				console.warn(
					`[bae:email] WebSocket closed (code=${event.code}, reason=${event.reason || "none"}). SDK will attempt reconnection.`,
				);
			}
		});

		socket.on("error", (err) => {
			if (!aborted) {
				console.error("[bae:email] WebSocket error:", err);
			}
		});
	}

	return {
		start: async () => {
			console.log("[bae:email] Starting email channel...");
			// Ensure display name is set (for inboxes created before this feature)
			if (workspaceSlug) {
				const { ensureDisplayName } = await import("./api.ts");
				await ensureDisplayName(client, inboxId, workspaceSlug);
			}
			// Catch up on any unreplied messages from downtime
			await catchUp();
			// Start WebSocket monitor
			await monitor();
		},
		stop: async () => {
			aborted = true;
			if (socket) {
				try {
					socket.close();
				} catch {
					// Best effort
				}
				socket = null;
			}
			lastMessageIds.clear();
		},
	};
}
