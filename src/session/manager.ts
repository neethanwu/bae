import type { Executor } from "../executor/types.ts";
import type { AgentEvent } from "../stream/types.ts";
import type { SessionStore } from "./store.ts";

/**
 * SessionManager — Option B (spawn-per-message).
 * Maps IM threads to agent sessions via the session store.
 * Each message spawns a new process; --resume provides continuity.
 */
export class SessionManager {
	constructor(
		private store: SessionStore,
		private executor: Executor,
		private defaultCwd: string,
	) {}

	async handleMessage(
		platform: string,
		threadId: string,
		text: string,
	): Promise<AsyncIterable<AgentEvent>> {
		const session = this.store.getOrCreate(platform, threadId, this.defaultCwd);

		const result = this.executor.execute({
			prompt: text,
			cwd: session.cwd,
			resumeSessionId: session.agentSessionId ?? undefined,
		});

		this.store.setStatus(session.id, "running");

		// Store agent session ID when init event arrives
		result.sessionId
			.then((id) => {
				this.store.setAgentSessionId(session.id, id);
			})
			.catch((err) => {
				console.error("[session] Failed to get agent session ID:", err);
			});

		// Wrap events to update status on completion
		const store = this.store;
		const sessionId = session.id;

		async function* trackEvents(): AsyncIterable<AgentEvent> {
			try {
				for await (const event of result.events) {
					yield event;
				}
			} finally {
				store.setStatus(sessionId, "idle");
			}
		}

		return trackEvents();
	}

	clearSession(platform: string, threadId: string): void {
		const session = this.store.getOrCreate(platform, threadId, this.defaultCwd);
		this.store.clearSession(session.id);
	}

	close(): void {
		this.store.close();
	}
}
