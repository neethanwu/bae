import type { MessageData, Thread } from "chat";
import { handleCommand } from "./commands.ts";
import { ClaudeCodeExecutor } from "./executor/claude.ts";
import {
	formatMetadata,
	formatToolStatus,
	splitMessage,
} from "./formatter/telegram.ts";
import { SessionManager } from "./session/manager.ts";
import { SessionStore } from "./session/store.ts";
import type { AgentEvent } from "./stream/types.ts";

const TYPING_INTERVAL_MS = 4_000;
const SPLIT_THRESHOLD = 3500; // Start new message before hitting Telegram's 4096 limit
const LOG_PREVIEW_LEN = 80;

export interface BridgeConfig {
	cwd: string;
	allowedUsers: string[];
	dbPath?: string;
}

export interface BridgeHandle {
	handleMessage(
		thread: Thread,
		message: MessageData,
		platform?: string,
	): Promise<void>;
	shutdown(): void;
}

/**
 * Create the Bae bridge — central orchestrator between IM and agent.
 */
export async function createBridge(
	config: BridgeConfig,
): Promise<BridgeHandle> {
	const store = new SessionStore(config.dbPath);
	await store.waitReady();
	const executor = new ClaudeCodeExecutor();
	const sessionManager = new SessionManager(store, executor, config.cwd);

	console.log(`[bae] Workspace: ${config.cwd}`);
	console.log(`[bae] Allowed users: ${config.allowedUsers.join(", ")}`);

	async function handleMessage(
		thread: Thread,
		message: MessageData,
		platform = "telegram",
	): Promise<void> {
		const userId = message.author?.userId ?? "";
		if (
			config.allowedUsers.length > 0 &&
			!config.allowedUsers.includes(userId)
		) {
			console.log(`[bae] Rejected message from unauthorized user: ${userId}`);
			return;
		}

		const text = message.text;
		if (!text || text.trim() === "") {
			await thread.post("Only text messages are supported.");
			return;
		}

		// Command routing
		const cmdResponse = handleCommand(
			text,
			sessionManager,
			platform,
			thread.id,
		);
		if (cmdResponse !== null) {
			await thread.post(cmdResponse);
			return;
		}

		const startTime = Date.now();
		console.log(
			`[bae] <- ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`,
		);

		// Start typing indicator (repeat every 4s since Telegram expires it)
		await thread.startTyping().catch(() => {});
		const typingInterval = setInterval(() => {
			thread.startTyping().catch(() => {});
		}, TYPING_INTERVAL_MS);

		try {
			const events = await sessionManager.handleMessage(
				platform,
				thread.id,
				text,
			);

			await streamResponse(thread, events, startTime, typingInterval);
		} catch (err) {
			console.error("[bae] Error:", err);
			await thread.post(
				"Something went wrong processing your message. Check the server logs for details.",
			);
		} finally {
			clearInterval(typingInterval);
		}
	}

	function shutdown() {
		console.log("[bae] Shutting down...");
		sessionManager.close();
	}

	return { handleMessage, shutdown };
}

/**
 * Consume agent events and stream them progressively to the IM thread.
 *
 * Uses a "push stream" pattern with a buffered queue: the event loop pushes
 * text chunks into a queue that an async generator consumes. When accumulated
 * text approaches the platform limit (~3500 chars), the generator ends
 * (finalizing the message) and a new one starts for the continuation.
 */
async function streamResponse(
	thread: Thread,
	events: AsyncIterable<AgentEvent>,
	startTime: number,
	typingInterval: ReturnType<typeof setInterval>,
): Promise<void> {
	let hasText = false;
	let logPreview = "";
	let toolCount = 0;
	let messageCount = 0;
	let resultEvent: Extract<AgentEvent, { kind: "result" }> | null = null;

	// Buffered push stream: queue ensures no chunks are dropped
	let buffer: (string | null)[] = [];
	let streamResolve: ((value: undefined) => void) | null = null;
	let currentStreamLength = 0;

	async function* createStream(): AsyncGenerator<string> {
		while (true) {
			while (buffer.length === 0) {
				await new Promise<void>((resolve) => {
					streamResolve = resolve;
				});
			}
			const chunk = buffer.shift() ?? null;
			if (chunk === null) break;
			yield chunk;
		}
	}

	function pushChunk(text: string) {
		currentStreamLength += text.length;
		buffer.push(text);
		streamResolve?.(undefined);
		streamResolve = null;
	}

	function endStream() {
		buffer.push(null);
		streamResolve?.(undefined);
		streamResolve = null;
	}

	// Collect post promises to await at the end (non-blocking splits)
	const postPromises: Promise<unknown>[] = [];
	let activePostPromise: Promise<unknown> | null = null;

	function startNewStream() {
		currentStreamLength = 0;
		buffer = [];
		streamResolve = null;
		const stream = createStream();
		activePostPromise = thread.post(stream);
		postPromises.push(activePostPromise);
		messageCount++;
	}

	let isStreaming = false;

	for await (const event of events) {
		if (event.kind === "init") {
			console.log(`[bae] Session: ${event.sessionId}`);
		}

		if (event.kind === "text_delta") {
			hasText = true;
			if (logPreview.length < LOG_PREVIEW_LEN) {
				logPreview += event.text.slice(0, LOG_PREVIEW_LEN - logPreview.length);
			}

			// Start streaming if not yet started
			if (!isStreaming) {
				// Stop typing indicator once text starts flowing
				clearInterval(typingInterval);
				startNewStream();
				isStreaming = true;
			}

			// Check if this chunk would push us past the split threshold
			if (currentStreamLength + event.text.length > SPLIT_THRESHOLD) {
				// End current message, start a new one
				endStream();
				await activePostPromise;
				startNewStream();
			}

			pushChunk(event.text);
		}

		if (event.kind === "tool_use") {
			toolCount++;
			const status = formatToolStatus(event.toolName, event.input);
			console.log(`[bae] Tool: ${status}`);
			// Re-enable typing during tool use gaps (stream pauses while agent works)
			thread.startTyping().catch(() => {});
		}

		if (event.kind === "result") {
			resultEvent = event;
			if (!hasText && event.text) {
				hasText = true;
				logPreview = event.text.slice(0, LOG_PREVIEW_LEN);
			}
			break;
		}

		if (event.kind === "error") {
			console.error(`[bae] Agent error: ${event.message}`);
			if (isStreaming) {
				endStream();
				await Promise.all(postPromises);
			}
			await thread.post(
				"Something went wrong. Check the server logs for details.",
			);
			return;
		}
	}

	// Finalize: append metadata footer and close the stream
	const elapsed = Date.now() - startTime;
	const footer = formatMetadata(elapsed, resultEvent?.costUsd);

	if (!hasText) {
		if (isStreaming) {
			endStream();
			await Promise.all(postPromises);
		}
		await thread.post("(no response from agent)");
		return;
	}

	// If text came from result event (no text_deltas streamed), post it directly
	if (!isStreaming) {
		const fullText = (resultEvent?.text ?? "") + footer;
		// Use splitMessage for safety — result text could exceed platform limit
		for (const chunk of splitMessage(fullText)) {
			await thread.post(chunk);
			messageCount++;
		}
	} else if (currentStreamLength + footer.length > SPLIT_THRESHOLD) {
		// Footer doesn't fit in current stream — post separately
		endStream();
		await Promise.all(postPromises);
		await thread.post(footer.trim());
		messageCount++;
	} else {
		pushChunk(footer);
		endStream();
		await Promise.all(postPromises);
	}

	console.log(
		`[bae] -> ${logPreview}${logPreview.length >= LOG_PREVIEW_LEN ? "..." : ""} (${(elapsed / 1000).toFixed(1)}s${toolCount > 0 ? `, ${toolCount} tools` : ""}${messageCount > 1 ? `, ${messageCount} messages` : ""})`,
	);
}
