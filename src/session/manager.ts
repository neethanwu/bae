import type { ExecuteResult, Executor } from "../executor/types.ts";
import type { AgentEvent } from "../stream/types.ts";
import type { SessionStore } from "./store.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type HandleMessageResult =
	| { steered: false; events: AsyncIterable<AgentEvent> }
	| { steered: true };

/**
 * SessionManager — persistent process with stdin steering.
 *
 * Holds in-memory handles to active agent processes. When a message arrives
 * for a thread with an active handle, it steers (writes to stdin) instead
 * of spawning a new process. The process stays alive across multiple turns.
 */
export class SessionManager {
	private activeHandles: Map<string, ExecuteResult> = new Map();
	private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private idleTimeoutMs: number;

	constructor(
		private store: SessionStore,
		private executor: Executor,
		private defaultCwd: string,
		idleTimeoutMs?: number,
	) {
		this.idleTimeoutMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	}

	private handleKey(platform: string, threadId: string): string {
		return `${platform}:${threadId}`;
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
		// Cleanup happens in trackEvents finally block
	}

	async handleMessage(
		platform: string,
		threadId: string,
		text: string,
	): Promise<HandleMessageResult> {
		const key = this.handleKey(platform, threadId);
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

		// No active handle → spawn persistent process
		const session = this.store.getOrCreate(platform, threadId, this.defaultCwd);

		const result = this.executor.execute({
			prompt: text,
			cwd: session.cwd,
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
	 * Interrupt and kill the active process for a thread (used by /new).
	 * Returns true if there was an active process to interrupt.
	 */
	async interruptSession(platform: string, threadId: string): Promise<boolean> {
		const key = this.handleKey(platform, threadId);
		const handle = this.activeHandles.get(key);
		if (!handle) return false;

		this.clearIdleTimer(key);
		if (handle.interrupt) {
			await handle.interrupt();
		} else {
			await handle.kill();
		}
		// Handle cleanup happens in trackEvents finally block
		return true;
	}

	clearSession(platform: string, threadId: string): void {
		const session = this.store.getOrCreate(platform, threadId, this.defaultCwd);
		this.store.clearSession(session.id);
	}

	hasActiveHandle(platform: string, threadId: string): boolean {
		return this.activeHandles.has(this.handleKey(platform, threadId));
	}

	async shutdown(): Promise<void> {
		// Clear all idle timers
		for (const timer of this.idleTimers.values()) {
			clearTimeout(timer);
		}
		this.idleTimers.clear();

		// Kill all active processes
		const kills = [...this.activeHandles.values()].map((h) => h.kill());
		await Promise.allSettled(kills);
		this.activeHandles.clear();
		this.store.close();
	}
}
