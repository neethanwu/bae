import {
	ERROR_AGENT_MESSAGES,
	ERROR_SPAWN_MESSAGES,
	ERROR_STREAM_MESSAGES,
	handleCommand,
	pick,
} from "./commands.ts";
import { formatToolStatus } from "./formatter/common.ts";
import type {
	Attachment,
	PlatformConfig,
	PlatformThread,
} from "./platform/types.ts";
import { SessionManager } from "./session/manager.ts";
import type { Store } from "./session/store.ts";
import type { AgentEvent } from "./stream/types.ts";

const LOG_PREVIEW_LEN = 80;

export interface BridgeConfig {
	store: Store;
}

export interface BridgeHandle {
	handleMessage(
		thread: PlatformThread,
		userId: string,
		text: string,
		channelId: string,
		config: PlatformConfig,
		attachments?: Attachment[],
	): Promise<void>;
	shutdown(): Promise<void>;
}

/**
 * Create the Bae bridge — central orchestrator between IM and agent.
 */
export async function createBridge(
	config: BridgeConfig,
): Promise<BridgeHandle> {
	const { store } = config;
	const sessionManager = new SessionManager(store);

	async function handleMessage(
		thread: PlatformThread,
		userId: string,
		text: string,
		channelId: string,
		config: PlatformConfig,
		attachments?: Attachment[],
	): Promise<void> {
		// Per-channel auth check
		const channel = store.getChannel(channelId);
		if (!channel) {
			console.error(`[bae] Unknown channel: ${channelId}`);
			return;
		}
		const tag = `[bae:${channel.workspaceId}/${channel.platform}]`;

		if (!channel.allowedUsers.includes(userId)) {
			console.log(`${tag} Rejected message from unauthorized user: ${userId}`);
			return;
		}

		const hasAttachments = attachments && attachments.length > 0;
		if ((!text || text.trim() === "") && !hasAttachments) {
			await thread.post("Send a message, image, or file to get started.");
			return;
		}

		const conversationId = thread.id;

		// Command routing
		const cmdResponse = await handleCommand(
			text,
			sessionManager,
			channelId,
			conversationId,
			channel.platform,
		);
		if (cmdResponse !== null) {
			await thread.post(cmdResponse);
			return;
		}

		const startTime = Date.now();
		console.log(
			`${tag} <- ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`,
		);

		try {
			const result = await sessionManager.handleMessage(
				channelId,
				conversationId,
				text,
				attachments,
			);

			// Steering fast path: message sent to active agent's stdin
			if (result.steered) {
				console.log(`${tag} Steered in ${Date.now() - startTime}ms`);
				// Typing indicator — the long-lived consumer will handle the response
				thread.startTyping().catch(() => {});
				return;
			}

			// Start typing immediately — gives user feedback while agent initializes (~5s)
			thread.startTyping().catch(() => {});

			// Start long-lived event consumer in background.
			// Must NOT await: some SDKs hold a thread lock while our handler
			// runs. If we block here, subsequent messages (steering) get LOCK_FAILED.
			// The consumer runs for the entire process lifetime and handles all turns.
			console.log(`${tag} Spawned in ${Date.now() - startTime}ms`);
			consumeAllTurns(thread, result.events, config, tag).catch(async (err) => {
				console.error(`${tag} consumeAllTurns error:`, err);
				await thread.post(pick(ERROR_STREAM_MESSAGES)).catch(() => {});
			});
		} catch (err) {
			console.error(`${tag} Error:`, err);
			await thread.post(pick(ERROR_SPAWN_MESSAGES));
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
 * Streams text in real-time via PlatformThread.postStream() (each platform
 * implements this differently — Telegram uses edit-in-place, Slack uses
 * native streaming API). When the message approaches the platform's split
 * threshold, ends the current stream and starts a new message.
 */
async function consumeAllTurns(
	thread: PlatformThread,
	events: AsyncIterable<AgentEvent>,
	config: PlatformConfig,
	tag: string,
): Promise<void> {
	const { splitSoft, splitHard } = config;
	let turnStartTime = Date.now();
	let typingInterval: ReturnType<typeof setInterval> | undefined;

	// Per-turn state
	let hasText = false;
	let logPreview = "";
	let toolCount = 0;
	let messageCount = 0;
	let resultEvent: Extract<AgentEvent, { kind: "result" }> | null = null;

	// Streaming state — buffered push stream for thread.postStream(AsyncIterable)
	let buffer: (string | null)[] = [];
	let streamResolve: ((value: undefined) => void) | null = null;
	let currentStreamLength = 0;
	let postPromise: Promise<unknown> | null = null;
	let isStreaming = false;
	let streamText = ""; // accumulated text for reliable ``` fence tracking

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
		streamText += text;
		currentStreamLength += text.length;
		buffer.push(text);
		streamResolve?.(undefined);
		streamResolve = null;
	}

	function isInCodeFence(): boolean {
		const count = (streamText.match(/```/g) || []).length;
		return count % 2 === 1;
	}

	/** Close an open code fence before splitting, reopen after. */
	function splitStream() {
		const wasInFence = isInCodeFence();
		if (wasInFence) {
			pushChunk("\n```");
		}
		endStream();
		return wasInFence;
	}

	function startNewStreamWithFence(wasInFence: boolean) {
		startNewStream();
		if (wasInFence) {
			pushChunk("```\n");
		}
	}

	function endStream() {
		buffer.push(null);
		streamResolve?.(undefined);
		streamResolve = null;
	}

	function startNewStream() {
		currentStreamLength = 0;
		streamText = "";
		buffer = [];
		streamResolve = null;
		const stream = createStream();
		postPromise = thread.postStream(stream);
		messageCount++;
	}

	function startTyping() {
		clearInterval(typingInterval);
		thread.startTyping().catch(() => {});
		typingInterval = setInterval(() => {
			thread.startTyping().catch(() => {});
		}, 4000);
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
		streamText = "";
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
			// End the active stream — platform handles the final update
			endStream();
			await postPromise;
		}

		// Flush buffered content (email batches all posts into one reply)
		await thread.flush?.();

		const costStr = resultEvent?.costUsd
			? `, $${resultEvent.costUsd.toFixed(4)}`
			: "";
		console.log(
			`${tag} -> ${logPreview}${logPreview.length >= LOG_PREVIEW_LEN ? "..." : ""} (${(elapsed / 1000).toFixed(1)}s${costStr}${toolCount > 0 ? `, ${toolCount} tools` : ""}${messageCount > 1 ? `, ${messageCount} messages` : ""})`,
		);
	}

	// Show typing while agent initializes
	startTyping();

	try {
		for await (const event of events) {
			if (event.kind === "init") {
				console.log(`${tag} Session: ${event.sessionId}`);
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

				// Smart split: prefer paragraph breaks to avoid cutting tables/code blocks.
				// Soft zone (splitSoft+): split at \n\n if the chunk has one.
				// Hard zone (splitHard+): split at any \n, or force-cut if none.
				const wouldReachHard =
					currentStreamLength + event.text.length >= splitHard;

				if (currentStreamLength >= splitHard || wouldReachHard) {
					// At or approaching hard limit — find best split point in chunk
					const remaining = Math.max(0, splitHard - currentStreamLength);
					const searchArea = event.text.slice(0, remaining);
					const breakIdx = searchArea.lastIndexOf("\n");

					if (breakIdx >= 0) {
						pushChunk(event.text.slice(0, breakIdx));
						const wasInFence = splitStream();
						console.log(
							`${tag} Split at ${currentStreamLength} chars (fence: ${wasInFence})`,
						);
						await postPromise;
						startNewStreamWithFence(wasInFence);
						pushChunk(event.text.slice(breakIdx + 1));
					} else if (remaining > 0) {
						pushChunk(event.text.slice(0, remaining));
						const wasInFence = splitStream();
						console.log(
							`${tag} Split at ${currentStreamLength} chars (fence: ${wasInFence})`,
						);
						await postPromise;
						startNewStreamWithFence(wasInFence);
						pushChunk(event.text.slice(remaining));
					} else {
						const wasInFence = splitStream();
						console.log(
							`${tag} Split at ${currentStreamLength} chars (fence: ${wasInFence})`,
						);
						await postPromise;
						startNewStreamWithFence(wasInFence);
						pushChunk(event.text);
					}
				} else if (
					currentStreamLength > splitSoft &&
					event.text.includes("\n\n")
				) {
					// Soft zone — split at last paragraph break
					const breakIdx = event.text.lastIndexOf("\n\n");
					pushChunk(event.text.slice(0, breakIdx));
					const wasInFence = splitStream();
					console.log(
						`${tag} Split at ${currentStreamLength} chars (fence: ${wasInFence})`,
					);
					await postPromise;
					startNewStreamWithFence(wasInFence);
					pushChunk(event.text.slice(breakIdx + 2));
				} else {
					pushChunk(event.text);
				}
			}

			if (event.kind === "tool_use") {
				toolCount++;
				const status = formatToolStatus(event.toolName, event.input);
				console.log(`${tag} Tool: ${status}`);

				// End any active stream before tool execution
				if (isStreaming) {
					endStream();
					await postPromise;
					isStreaming = false;
				}
				// Discard intermediate text before tool use (email only sends final response)
				thread.discard?.();
				startTyping();
			}

			if (event.kind === "result") {
				resultEvent = event;

				// Detect auth errors — surface actionable message to user
				const resultLower = event.text?.toLowerCase() ?? "";
				if (
					resultLower.includes("not logged in") ||
					resultLower.includes("/login")
				) {
					console.error(
						`${tag} Agent auth error detected. Run \`claude auth login\` on the host machine.`,
					);
					stopTyping();
					if (isStreaming) {
						endStream();
						await postPromise;
						isStreaming = false;
					}
					await thread.post(
						"Bae's agent isn't logged in. The owner needs to run `claude auth login` on the host machine. Try again after that.",
					);
					// Return to exit the event loop and clean up the handle.
					// This prevents future messages from being steered to the
					// broken process (which would show "typing..." for minutes).
					return;
				}

				if (!hasText && event.text) {
					hasText = true;
					logPreview = event.text.slice(0, LOG_PREVIEW_LEN);
				}

				stopTyping();
				await finalizeTurn();
				resetTurnState();
				// Don't restart typing here — it fires a Telegram typing action
				// that lingers ~5s after the reply. Typing resumes on next init/tool_use.
			}

			if (event.kind === "error") {
				console.error(`${tag} Agent error: ${event.message}`);
				stopTyping();
				if (isStreaming) {
					endStream();
					await postPromise;
				}
				await thread.post(pick(ERROR_AGENT_MESSAGES));
				resetTurnState();
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
