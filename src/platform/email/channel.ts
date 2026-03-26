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
	Attachment,
	ChannelHandle,
	PlatformConfig,
	PlatformThread,
} from "../types.ts";
import {
	MAX_ATTACHMENT_BYTES,
	MAX_TOTAL_ATTACHMENT_BYTES,
	sanitizeFilename,
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
	// Buffer all text within a turn, send as one reply on flush()
	let turnBuffer: string[] = [];

	async function sendReply(text: string): Promise<void> {
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
	}

	return {
		id: threadId,

		async post(text: string) {
			turnBuffer.push(text);
		},

		async postStream(chunks: AsyncIterable<string>) {
			let full = "";
			for await (const chunk of chunks) full += chunk;
			if (full) turnBuffer.push(full);
		},

		async startTyping() {
			// Email has no typing indicator — no-op
		},

		async flush() {
			if (turnBuffer.length === 0) return;
			const combined = turnBuffer.join("\n\n");
			turnBuffer = [];
			await sendReply(combined);
		},

		discard() {
			turnBuffer = [];
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
		attachments?: Attachment[],
	) => Promise<void>;
}

export function createEmailChannel(
	options: CreateEmailChannelOptions,
): ChannelHandle {
	const { apiKey, inboxId, workspaceSlug, onMessage } = options;
	const client = createClient(apiKey);
	const tag = workspaceSlug ? `[bae:${workspaceSlug}/email]` : "[bae:email]";

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
		// biome-ignore lint/suspicious/noExplicitAny: AgentMail Attachment type
		attachments?: any[];
	}): Promise<void> {
		const body = msg.extractedText || msg.text || "";
		const hasAttachments = msg.attachments && msg.attachments.length > 0;
		if (!body.trim() && !hasAttachments) return; // Skip truly empty emails

		const sender = extractEmail(msg.from);
		lastMessageIds.set(msg.threadId, msg.messageId);

		const thread = emailThread(client, inboxId, msg.threadId);

		// Download email attachments
		const attachments = await downloadEmailAttachments(
			msg.attachments,
			msg.messageId,
			thread,
		);

		// Prepend email context so the agent knows the channel and can adapt tone
		const subjectLine = msg.subject ? ` | Subject: "${msg.subject}"` : "";
		const prefixed = `[Email from ${sender}${subjectLine}]\nYour reply will be sent as an email. Keep it concise and well-structured.\n\n${body}`;

		await onMessage(thread, sender, prefixed, attachments);
	}

	/**
	 * Download email attachments via AgentMail API.
	 * Calls getAttachment() right before download for a fresh URL.
	 */
	async function downloadEmailAttachments(
		// biome-ignore lint/suspicious/noExplicitAny: AgentMail Attachment type
		emailAttachments: any[] | undefined,
		messageId: string,
		thread: PlatformThread,
	): Promise<Attachment[] | undefined> {
		if (!emailAttachments?.length) return undefined;

		const results: Attachment[] = [];
		let totalBytes = 0;

		for (const att of emailAttachments) {
			try {
				// Get a fresh download URL right before downloading
				const resp = await client.inboxes.messages.getAttachment(
					inboxId,
					messageId,
					att.attachmentId,
				);

				const fetchResp = await fetch(resp.downloadUrl);
				if (!fetchResp.ok) throw new Error(`HTTP ${fetchResp.status}`);

				const data = Buffer.from(await fetchResp.arrayBuffer());

				if (data.length > MAX_ATTACHMENT_BYTES) {
					const sizeMB = (data.length / 1024 / 1024).toFixed(1);
					console.warn(
						`${tag} Skipped '${att.filename ?? "file"}' (${sizeMB} MB > 10 MB)`,
					);
					await thread
						.post(
							`Skipped '${att.filename ?? "file"}' (${sizeMB} MB) — max attachment size is 10 MB.`,
						)
						.catch(() => {});
					continue;
				}

				totalBytes += data.length;
				if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
					console.warn(`${tag} Total size exceeds 20 MB, stopping`);
					await thread
						.post("Some attachments skipped — total size exceeds 20 MB.")
						.catch(() => {});
					break;
				}

				results.push({
					filename: sanitizeFilename(att.filename ?? "attachment"),
					mimeType: att.contentType ?? "application/octet-stream",
					data,
				});
			} catch (err) {
				const name = att.filename ?? "file";
				console.error(`${tag} Failed to download '${name}':`, err);
				await thread
					.post(`Could not download attachment '${name}'.`)
					.catch(() => {});
			}
		}

		return results.length > 0 ? results : undefined;
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
					`${tag} Catching up on ${messages.length} unreplied message(s)`,
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
							attachments: full.attachments ?? undefined,
						});
					} catch (err) {
						console.error(`${tag} Error processing catch-up message:`, err);
					}
				}
			}
		} catch (err) {
			console.warn(`${tag} Catch-up query failed:`, err);
		}
	}

	/**
	 * Connect WebSocket and monitor for incoming emails.
	 * Retries with exponential backoff on connection failure.
	 */
	async function monitor(): Promise<void> {
		let consecutiveFailures = 0;
		const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

		while (!aborted) {
			try {
				socket = await client.websockets.connect();
				consecutiveFailures = 0;
			} catch {
				consecutiveFailures++;
				const backoff = Math.min(
					1000 * 2 ** Math.min(consecutiveFailures, 8),
					MAX_BACKOFF_MS,
				);
				const backoffSec = Math.round(backoff / 1000);
				console.warn(
					`${tag} WebSocket connect failed (attempt ${consecutiveFailures}), retrying in ${backoffSec}s`,
				);
				await sleep(backoff);
				continue;
			}

			// SDK's connect() resolves after the socket is already open,
			// so subscribe immediately — don't rely on the "open" event.
			console.log(`${tag} WebSocket connected, subscribing...`);
			socket.sendSubscribe({
				type: "subscribe",
				inboxIds: [inboxId],
				eventTypes: ["message.received"],
			});

			// Wait for socket to close before reconnecting
			await new Promise<void>((resolve) => {
				socket?.on("message", async (event) => {
					try {
						if (
							event.type === "event" &&
							event.eventType === "message.received"
						) {
							const msg = event.message;
							await processMessage({
								from: msg.from,
								extractedText: msg.extractedText ?? null,
								text: msg.text ?? null,
								subject: msg.subject ?? null,
								threadId: msg.threadId,
								messageId: msg.messageId,
								attachments: msg.attachments ?? undefined,
							});
						}
					} catch (err) {
						console.error(`${tag} Error handling WebSocket event:`, err);
					}
				});

				socket?.on("close", (event) => {
					if (!aborted) {
						console.warn(
							`${tag} WebSocket closed (code=${event.code}, reason=${event.reason || "none"}), reconnecting...`,
						);
					}
					resolve();
				});

				socket?.on("error", (err) => {
					if (!aborted) {
						console.error(`${tag} WebSocket error:`, err);
					}
				});
			});

			// Brief pause before reconnect after a clean close
			if (!aborted) {
				await sleep(1000);
			}
		}
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	return {
		start: async () => {
			console.log(`${tag} Starting email channel...`);
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
