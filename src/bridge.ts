import type { MessageData, Thread } from "chat";
import { handleCommand } from "./commands.ts";
import { ClaudeCodeExecutor } from "./executor/claude.ts";
import { formatToolStatus } from "./formatter/telegram.ts";
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
				thread.startTyping().catch(() => {});
				return;
			}

			// Start typing immediately — gives user feedback while agent initializes (~5s)
			thread.startTyping().catch(() => {});

			// Start long-lived event consumer in background.
			// Must NOT await: the Chat SDK holds a thread lock while our handler
			// runs. If we block here, subsequent messages (steering) get LOCK_FAILED.
			// The consumer runs for the entire process lifetime and handles all turns.
			console.log(`[bae] Spawned in ${Date.now() - startTime}ms`);
			consumeAllTurns(thread, result.events).catch(async (err) => {
				console.error("[bae] consumeAllTurns error:", err);
				await thread
					.post(
						"Oops, I hit a snag and lost my train of thought. Try sending your message again!",
					)
					.catch(() => {});
			});
		} catch (err) {
			console.error("[bae] Error:", err);
			await thread.post(
				"I couldn't process that one. Try rephrasing or send /new to start fresh.",
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
 * Long-lived event consumer — handles ALL turns from a persistent process.
 *
 * Streams text to Telegram in real-time via the Chat SDK's fallbackStream
 * (post placeholder → edit every 500ms with accumulated text). When the
 * message approaches Telegram's 4096 char limit, ends the current stream
 * and starts a new message for the overflow.
 *
 * When a steered message's response events arrive, this consumer picks
 * them up automatically.
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

	// Streaming state — buffered push stream for thread.post(AsyncIterable)
	let buffer: (string | null)[] = [];
	let streamResolve: ((value: undefined) => void) | null = null;
	let currentStreamLength = 0;
	let postPromise: Promise<unknown> | null = null;
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
		postPromise = thread.post(stream);
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
		postPromise = null;
		isStreaming = false;
		turnStartTime = Date.now();
	}

	async function finalizeTurn() {
		const elapsed = Date.now() - turnStartTime;

		if (!hasText) {
			if (isStreaming) {
				endStream();
				await postPromise;
			}
			await thread.post("(no response from agent)");
		} else if (isStreaming) {
			// End the active stream — fallbackStream does the final edit
			endStream();
			await postPromise;
		}

		const costStr = resultEvent?.costUsd
			? `, $${resultEvent.costUsd.toFixed(4)}`
			: "";
		console.log(
			`[bae] -> ${logPreview}${logPreview.length >= LOG_PREVIEW_LEN ? "..." : ""} (${(elapsed / 1000).toFixed(1)}s${costStr}${toolCount > 0 ? `, ${toolCount} tools` : ""}${messageCount > 1 ? `, ${messageCount} messages` : ""})`,
		);
	}

	// Show typing while agent initializes
	startTyping();

	try {
		for await (const event of events) {
			if (event.kind === "init") {
				console.log(`[bae] Session: ${event.sessionId}`);
			}

			if (event.kind === "text_delta") {
				if (!hasText) {
					turnStartTime = Date.now();
					stopTyping();
				}
				hasText = true;
				if (logPreview.length < LOG_PREVIEW_LEN) {
					logPreview += event.text.slice(
						0,
						LOG_PREVIEW_LEN - logPreview.length,
					);
				}

				// Start streaming on first text chunk
				if (!isStreaming) {
					startNewStream();
					isStreaming = true;
				}

				// Would this chunk push us over the Telegram limit?
				if (currentStreamLength + event.text.length > SPLIT_THRESHOLD) {
					// End current message, start a new one
					endStream();
					await postPromise;
					startNewStream();
				}

				pushChunk(event.text);
			}

			if (event.kind === "tool_use") {
				toolCount++;
				const status = formatToolStatus(event.toolName, event.input);
				console.log(`[bae] Tool: ${status}`);

				// End any active stream before tool execution
				if (isStreaming) {
					endStream();
					await postPromise;
					isStreaming = false;
				}
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
				// Ready for next turn (steered messages)
				startTyping();
			}

			if (event.kind === "error") {
				console.error(`[bae] Agent error: ${event.message}`);
				stopTyping();
				if (isStreaming) {
					endStream();
					await postPromise;
				}
				await thread.post(
					"Something went wrong on my end. Send /new to start a fresh session.",
				);
				resetTurnState();
				startTyping();
			}
		}
	} finally {
		stopTyping();
		if (isStreaming) {
			endStream();
			await postPromise;
		}
	}
}
