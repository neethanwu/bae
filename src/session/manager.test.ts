import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	ExecuteOptions,
	ExecuteResult,
	Executor,
} from "../executor/types.ts";
import type { AgentEvent } from "../stream/types.ts";
import { SessionManager } from "./manager.ts";
import { SessionStore } from "./store.ts";

// In-memory session store for testing
function createTestStore(): SessionStore {
	return new SessionStore(":memory:");
}

// Controllable mock executor
function createMockExecutor(opts?: { supportsSend?: boolean }): {
	executor: Executor;
	emitEvent: (event: AgentEvent) => void;
	endStream: () => void;
	lastSendText: () => string | undefined;
	sendCallCount: () => number;
	killCallCount: () => number;
	interruptCallCount: () => number;
} {
	let emitResolve: ((value: undefined) => void) | null = null;
	const eventQueue: AgentEvent[] = [];
	let done = false;
	let lastSent: string | undefined;
	let sendCalls = 0;
	let killCalls = 0;
	let interruptCalls = 0;

	const supportsSend = opts?.supportsSend ?? true;

	function emitEvent(event: AgentEvent) {
		eventQueue.push(event);
		emitResolve?.(undefined);
		emitResolve = null;
	}

	function endStream() {
		done = true;
		emitResolve?.(undefined);
		emitResolve = null;
	}

	async function* events(): AsyncIterable<AgentEvent> {
		while (true) {
			while (eventQueue.length === 0 && !done) {
				await new Promise<void>((resolve) => {
					emitResolve = resolve;
				});
			}
			while (eventQueue.length > 0) {
				const next = eventQueue.shift();
				if (next) yield next;
			}
			if (done) break;
		}
	}

	const executor: Executor = {
		execute(_options: ExecuteOptions): ExecuteResult {
			const result: ExecuteResult = {
				events: events(),
				sessionId: Promise.resolve("test-session-id"),
				async kill() {
					killCalls++;
					endStream();
				},
			};

			if (supportsSend) {
				result.send = (text: string) => {
					lastSent = text;
					sendCalls++;
				};
				result.interrupt = async () => {
					interruptCalls++;
					endStream();
				};
			}

			return result;
		},
	};

	return {
		executor,
		emitEvent,
		endStream,
		lastSendText: () => lastSent,
		sendCallCount: () => sendCalls,
		killCallCount: () => killCalls,
		interruptCallCount: () => interruptCalls,
	};
}

describe("SessionManager", () => {
	let store: SessionStore;

	beforeEach(async () => {
		store = createTestStore();
		await store.waitReady();
	});

	afterEach(() => {
		store.close();
	});

	test("first message spawns a new process", async () => {
		const { executor, emitEvent, endStream } = createMockExecutor();
		const manager = new SessionManager(store, executor, "/tmp/test");

		const result = await manager.handleMessage("telegram", "thread1", "hello");
		expect(result.steered).toBe(false);
		if (result.steered) return;

		// Consume one event to verify stream works
		emitEvent({ kind: "init", sessionId: "abc" });
		emitEvent({ kind: "result", text: "done", costUsd: 0.01 });
		endStream();

		const collected: AgentEvent[] = [];
		for await (const e of result.events) {
			collected.push(e);
		}
		expect(collected).toHaveLength(2);
		expect(collected[0]?.kind).toBe("init");
		expect(collected[1]?.kind).toBe("result");
	});

	test("second message to same thread steers via send()", async () => {
		const { executor, emitEvent, lastSendText, sendCallCount } =
			createMockExecutor();
		const manager = new SessionManager(store, executor, "/tmp/test");

		// First message — spawns process
		const result1 = await manager.handleMessage("telegram", "t1", "first");
		expect(result1.steered).toBe(false);

		// Start consuming events (keeps the process "alive")
		if (!result1.steered) {
			emitEvent({ kind: "init", sessionId: "abc" });

			// Second message — steers
			const result2 = await manager.handleMessage("telegram", "t1", "steer me");
			expect(result2.steered).toBe(true);
			expect(lastSendText()).toBe("steer me");
			expect(sendCallCount()).toBe(1);
		}
	});

	test("different threads get separate processes", async () => {
		const { executor } = createMockExecutor();
		const manager = new SessionManager(store, executor, "/tmp/test");

		const r1 = await manager.handleMessage("telegram", "t1", "hello");
		const r2 = await manager.handleMessage("telegram", "t2", "world");

		expect(r1.steered).toBe(false);
		expect(r2.steered).toBe(false);
	});

	test("handle cleaned up after process exits", async () => {
		const { executor, emitEvent, endStream } = createMockExecutor();
		const manager = new SessionManager(store, executor, "/tmp/test");

		const result = await manager.handleMessage("telegram", "t1", "hello");
		expect(manager.hasActiveHandle("telegram", "t1")).toBe(true);

		if (!result.steered) {
			emitEvent({ kind: "result", text: "done", costUsd: 0 });
			endStream();

			// Drain the events to trigger cleanup
			for await (const _e of result.events) {
				// consume
			}
		}

		expect(manager.hasActiveHandle("telegram", "t1")).toBe(false);
	});

	test("/new interrupts active process", async () => {
		const { executor, emitEvent, interruptCallCount } = createMockExecutor();
		const manager = new SessionManager(store, executor, "/tmp/test");

		const result = await manager.handleMessage("telegram", "t1", "hello");
		expect(result.steered).toBe(false);

		// Start consuming in background
		if (!result.steered) {
			emitEvent({ kind: "init", sessionId: "abc" });

			// Interrupt
			const wasActive = await manager.interruptSession("telegram", "t1");
			expect(wasActive).toBe(true);
			expect(interruptCallCount()).toBe(1);
		}
	});

	test("interrupt returns false for inactive thread", async () => {
		const { executor } = createMockExecutor();
		const manager = new SessionManager(store, executor, "/tmp/test");

		const wasActive = await manager.interruptSession("telegram", "t1");
		expect(wasActive).toBe(false);
	});

	test("crash recovery: stale handle on send() failure spawns new process", async () => {
		const { executor } = createMockExecutor();
		const manager = new SessionManager(store, executor, "/tmp/test");

		// Spawn first process
		const result1 = await manager.handleMessage("telegram", "t1", "hello");
		expect(result1.steered).toBe(false);

		// Simulate a crash by making send() throw
		if (!result1.steered) {
			// Manually mess with the handle to simulate crash
			// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
			const handle = (manager as any).activeHandles.get("telegram:t1");
			if (handle) {
				handle.send = () => {
					throw new Error("stdin closed");
				};
			}

			// Next message should catch the error and spawn a new process
			const result2 = await manager.handleMessage("telegram", "t1", "retry");
			expect(result2.steered).toBe(false); // spawned new process, not steered
		}
	});
});
