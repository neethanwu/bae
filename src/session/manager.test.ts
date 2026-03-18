import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent } from "../stream/types.ts";
import { SessionManager } from "./manager.ts";
import { Store } from "./store.ts";

// Test workspace + channel IDs
const TEST_CHANNEL = "chan_test000001";
const TEST_CONVERSATION = "12345";

// In-memory store with a pre-configured workspace + channel
async function createTestStore(): Promise<Store> {
	const store = new Store(":memory:");
	await store.waitReady();

	store.createWorkspace({
		id: "test",
		name: "Test Workspace",
		path: "/tmp/bae-test",
		executor: "claude-code",
	});

	// We need to work around the channel ID being generated internally.
	// For testing, we'll access the db directly to insert a known channel ID.
	// biome-ignore lint/suspicious/noExplicitAny: test-only access to private db
	const db = (store as any).db;
	db.run(
		`INSERT INTO channels (id, workspace_id, platform, label, allowed_users)
		 VALUES (?, ?, ?, ?, ?)`,
		TEST_CHANNEL,
		"test",
		"telegram",
		"test channel",
		"12345",
	);

	return store;
}

describe("SessionManager", () => {
	let store: Store;

	beforeEach(async () => {
		store = await createTestStore();
	});

	afterEach(() => {
		store.close();
	});

	// Note: "first message spawns a new process" requires claude CLI installed.
	// Integration testing of the full spawn path happens manually.
	// Unit tests focus on routing, error handling, and session management.

	test("unknown channel returns error event", async () => {
		const manager = new SessionManager(store);

		const result = await manager.handleMessage(
			"chan_nonexistent",
			TEST_CONVERSATION,
			"hello",
		);
		expect(result.steered).toBe(false);
		if (result.steered) return;

		const events: AgentEvent[] = [];
		for await (const e of result.events) {
			events.push(e);
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("error");
	});

	test("interrupt returns false for inactive conversation", async () => {
		const manager = new SessionManager(store);

		const wasActive = await manager.interruptSession(
			TEST_CHANNEL,
			TEST_CONVERSATION,
		);
		expect(wasActive).toBe(false);
	});

	test("clearSession resets agent session ID", async () => {
		const manager = new SessionManager(store);

		// Create a session
		const session = store.getOrCreateSession(TEST_CHANNEL, TEST_CONVERSATION);
		store.setAgentSessionId(session.id, "some-session-id");

		// Verify it was set
		const before = store.getOrCreateSession(TEST_CHANNEL, TEST_CONVERSATION);
		expect(before.agentSessionId).toBe("some-session-id");

		// Clear it
		manager.clearSession(TEST_CHANNEL, TEST_CONVERSATION);

		// Verify it was cleared
		const after = store.getOrCreateSession(TEST_CHANNEL, TEST_CONVERSATION);
		expect(after.agentSessionId).toBeNull();
	});

	test("hasActiveHandle returns false for no active process", () => {
		const manager = new SessionManager(store);
		expect(manager.hasActiveHandle(TEST_CHANNEL, TEST_CONVERSATION)).toBe(
			false,
		);
	});
});
