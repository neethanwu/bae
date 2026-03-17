import { ClaudeCodeExecutor } from "../executor/claude.ts";
import type { ExecuteResult, Executor } from "../executor/types.ts";
import type { AgentEvent } from "../stream/types.ts";
import type { Store } from "./store.ts";
import type { ExecutorType } from "./types.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type HandleMessageResult =
	| { steered: false; events: AsyncIterable<AgentEvent> }
	| { steered: true };

/**
 * SessionManager — persistent process with stdin steering.
 *
 * Holds in-memory handles to active agent processes. When a message arrives
 * for a channel+conversation with an active handle, it steers (writes to stdin)
 * instead of spawning a new process.
 */
export class SessionManager {
	private activeHandles: Map<string, ExecuteResult> = new Map();
	private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private idleTimeoutMs: number;

	constructor(
		private store: Store,
		idleTimeoutMs?: number,
	) {
		this.idleTimeoutMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	}

	private handleKey(channelId: string, conversationId: string): string {
		return `${channelId}:${conversationId}`;
	}

	private createExecutor(executorType: ExecutorType): Executor {
		switch (executorType) {
			case "claude-code":
				return new ClaudeCodeExecutor();
			// Phase 3: case "codex": return new CodexExecutor();
		}
	}

	private resetIdleTimer(key: string): void {
		clearTimeout(this.idleTimers.get(key));
		const timer = setTimeout(() => {
			this.killIdle(key);
		}, this.idleTimeoutMs);
		this.idleTimers.set(key, timer);
	}

	private clearIdleTimer(key: string): void {
		clearTimeout(this.idleTimers.get(key));
		this.idleTimers.delete(key);
	}

	private async killIdle(key: string): Promise<void> {
		const handle = this.activeHandles.get(key);
		if (!handle) return;
		console.log(`[session] Idle timeout reached for ${key}, killing process`);
		await handle.kill();
	}

	async handleMessage(
		channelId: string,
		conversationId: string,
		text: string,
	): Promise<HandleMessageResult> {
		const key = this.handleKey(channelId, conversationId);
		const existing = this.activeHandles.get(key);

		// Steering fast path: active process with send() → write to stdin
		if (existing?.send) {
			try {
				existing.send(text);
				this.resetIdleTimer(key);
				return { steered: true };
			} catch {
				// Process crashed between check and send — clean up stale handle
				console.error(
					"[session] Steering failed (process likely crashed), spawning new process",
				);
				this.activeHandles.delete(key);
				this.clearIdleTimer(key);
				// Fall through to spawn a new process below
			}
		}

		// Active process without send() (fallback executor) → reject
		if (existing) {
			return {
				steered: false,
				events: (async function* (): AsyncIterable<AgentEvent> {
					yield {
						kind: "error",
						message: "Still working on your previous message. Please wait.",
					};
				})(),
			};
		}

		// Resolve workspace from channel
		const channel = this.store.getChannel(channelId);
		if (!channel) {
			return {
				steered: false,
				events: (async function* (): AsyncIterable<AgentEvent> {
					yield { kind: "error", message: "Unknown channel." };
				})(),
			};
		}
		const workspace = this.store.getWorkspace(channel.workspaceId);
		if (!workspace) {
			return {
				steered: false,
				events: (async function* (): AsyncIterable<AgentEvent> {
					yield { kind: "error", message: "Unknown workspace." };
				})(),
			};
		}

		const executor = this.createExecutor(workspace.executor);
		const session = this.store.getOrCreateSession(channelId, conversationId);

		const result = executor.execute({
			prompt: text,
			cwd: workspace.path,
			resumeSessionId: session.agentSessionId ?? undefined,
		});

		this.activeHandles.set(key, result);
		this.resetIdleTimer(key);
		this.store.setStatus(session.id, "running");

		// Store agent session ID when init event arrives
		result.sessionId
			.then((id) => {
				this.store.setAgentSessionId(session.id, id);
			})
			.catch((err) => {
				console.error("[session] Failed to get agent session ID:", err);
			});

		// Wrap events to clean up handle on process exit
		const self = this;
		const sessionId = session.id;

		async function* trackEvents(): AsyncIterable<AgentEvent> {
			try {
				for await (const event of result.events) {
					yield event;
				}
			} finally {
				self.activeHandles.delete(key);
				self.clearIdleTimer(key);
				self.store.setStatus(sessionId, "idle");
			}
		}

		return { steered: false, events: trackEvents() };
	}

	/**
	 * Interrupt and kill the active process for a conversation (used by /new).
	 */
	async interruptSession(
		channelId: string,
		conversationId: string,
	): Promise<boolean> {
		const key = this.handleKey(channelId, conversationId);
		const handle = this.activeHandles.get(key);
		if (!handle) return false;

		this.clearIdleTimer(key);
		if (handle.interrupt) {
			await handle.interrupt();
		} else {
			await handle.kill();
		}
		return true;
	}

	clearSession(channelId: string, conversationId: string): void {
		const session = this.store.getOrCreateSession(channelId, conversationId);
		this.store.clearSession(session.id);
	}

	hasActiveHandle(channelId: string, conversationId: string): boolean {
		return this.activeHandles.has(this.handleKey(channelId, conversationId));
	}

	async shutdown(): Promise<void> {
		for (const timer of this.idleTimers.values()) {
			clearTimeout(timer);
		}
		this.idleTimers.clear();

		const kills = [...this.activeHandles.values()].map((h) => h.kill());
		await Promise.allSettled(kills);
		this.activeHandles.clear();
		this.store.close();
	}
}
