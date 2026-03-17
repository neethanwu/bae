import { createMemoryState } from "@chat-adapter/state-memory";

const RETRY_INTERVAL_MS = 50;
const MAX_RETRIES = 20; // 50ms × 20 = 1s max wait

/**
 * Memory state adapter with lock retry.
 *
 * The default Chat SDK memory adapter fails immediately if a lock is held.
 * Since our handlers return in <10ms, a brief retry loop is sufficient
 * to handle the race between concurrent message processing.
 */
export function createRetryState() {
	const inner = createMemoryState();

	return new Proxy(inner, {
		get(target, prop, receiver) {
			if (prop === "acquireLock") {
				return async (threadId: string, ttlMs: number) => {
					for (let i = 0; i < MAX_RETRIES; i++) {
						const lock = await target.acquireLock(threadId, ttlMs);
						if (lock) return lock;
						await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
					}
					return null; // Give up after max retries
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
