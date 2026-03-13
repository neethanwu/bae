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
	shutdown(): Promise<void>;
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
		const cmdResponse = await handleCommand(
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

		try {
			const result = await sessionManager.handleMessage(
				platform,
				thread.id,
				text,
			);

			// Steering fast path: message sent to active agent's stdin
			if (result.steered) {
				console.log(`[bae] Steered in ${Date.now() - startTime}ms`);
				// Typing indicator — the long-lived consumer will handle the response
				await thread.startTyping().catch(() => {});
				return;
			}

			// New process — start long-lived event consumer.
			// This runs for the entire process lifetime (across all turns).
			// Steered messages' responses are picked up by this same consumer.
			console.log(`[bae] Spawned in ${Date.now() - startTime}ms`);
			await consumeAllTurns(thread, result.events);
		} catch (err) {
			console.error("[bae] Error:", err);
			await thread.post(
				"Something went wrong processing your message. Check the server logs for details.",
			);
		}
	}

	async function shutdown() {
		console.log("[bae] Shutting down...");
		await sessionManager.shutdown();
	}

	return { handleMessage, shutdown };
}

/**
 * Long-lived event consumer — streams ALL turns from a persistent process.
 *
 * Runs for the entire process lifetime. Each turn (text_deltas → result)
 * is streamed to the IM thread as one or more messages. When a steered
 * message's response events arrive, this consumer picks them up automatically.
 */
async function consumeAllTurns(
	thread: Thread,
	events: AsyncIterable<AgentEvent>,
): Promise<void> {
	let turnStartTime = Date.now();
	let typingInterval: ReturnType<typeof setInterval> | undefined;

	// Per-turn state
	let hasText = false;
	let logPreview = "";
	let toolCount = 0;
	let messageCount = 0;
	let resultEvent: Extract<AgentEvent, { kind: "result" }> | null = null;

	// Buffered push stream state
	let buffer: (string | null)[] = [];
	let streamResolve: ((value: undefined) => void) | null = null;
	let currentStreamLength = 0;
	let postPromises: Promise<unknown>[] = [];
	let activePostPromise: Promise<unknown> | null = null;
	let isStreaming = false;

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

	function startNewStream() {
		currentStreamLength = 0;
		buffer = [];
		streamResolve = null;
		const stream = createStream();
		activePostPromise = thread.post(stream);
		postPromises.push(activePostPromise);
		messageCount++;
	}

	function startTyping() {
		clearInterval(typingInterval);
		thread.startTyping().catch(() => {});
		typingInterval = setInterval(() => {
			thread.startTyping().catch(() => {});
		}, TYPING_INTERVAL_MS);
	}

	function stopTyping() {
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function resetTurnState() {
		hasText = false;
		logPreview = "";
		toolCount = 0;
		messageCount = 0;
		resultEvent = null;
		buffer = [];
		streamResolve = null;
		currentStreamLength = 0;
		postPromises = [];
		activePostPromise = null;
		isStreaming = false;
		turnStartTime = Date.now();
	}

	async function finalizeTurn() {
		const elapsed = Date.now() - turnStartTime;
		const footer = formatMetadata(elapsed, resultEvent?.costUsd);

		if (!hasText) {
			if (isStreaming) {
				endStream();
				await Promise.all(postPromises);
			}
			await thread.post("(no response from agent)");
		} else if (!isStreaming) {
			// Text came from result event (no text_deltas streamed)
			const fullText = (resultEvent?.text ?? "") + footer;
			for (const chunk of splitMessage(fullText)) {
				await thread.post(chunk);
				messageCount++;
			}
		} else if (currentStreamLength + footer.length > SPLIT_THRESHOLD) {
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

	// Start typing for the first turn
	startTyping();

	try {
		for await (const event of events) {
			if (event.kind === "init") {
				console.log(
					`[bae] Session: ${event.sessionId} (${Date.now() - turnStartTime}ms)`,
				);
			}

			if (event.kind === "text_delta") {
				if (!hasText) {
					console.log(`[bae] First text at ${Date.now() - turnStartTime}ms`);
					// Stop typing once text starts flowing
					stopTyping();
				}
				hasText = true;
				if (logPreview.length < LOG_PREVIEW_LEN) {
					logPreview += event.text.slice(
						0,
						LOG_PREVIEW_LEN - logPreview.length,
					);
				}

				if (!isStreaming) {
					startNewStream();
					isStreaming = true;
				}

				if (currentStreamLength + event.text.length > SPLIT_THRESHOLD) {
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
				// Re-enable typing during tool use gaps
				startTyping();
			}

			if (event.kind === "result") {
				resultEvent = event;
				if (!hasText && event.text) {
					hasText = true;
					logPreview = event.text.slice(0, LOG_PREVIEW_LEN);
				}

				stopTyping();
				await finalizeTurn();
				resetTurnState();
				// Don't start typing here — it would show indefinitely between turns.
				// Typing is started by the steering fast path in handleMessage,
				// or by the init/text_delta handler when the next turn begins.
			}

			if (event.kind === "error") {
				console.error(`[bae] Agent error: ${event.message}`);
				stopTyping();
				if (isStreaming) {
					endStream();
					await Promise.all(postPromises);
				}
				await thread.post(
					"Something went wrong. Check the server logs for details.",
				);
				// Don't return — process may still be alive and emit future turns.
				// Reset state and continue consuming.
				resetTurnState();
			}
		}
	} finally {
		stopTyping();
		// Flush any in-progress stream on unexpected exit
		if (isStreaming) {
			endStream();
			await Promise.all(postPromises);
		}
	}
}
