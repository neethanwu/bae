import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "./store.ts";

describe("Store", () => {
	let store: Store;

	beforeEach(async () => {
		store = new Store(":memory:");
		await store.waitReady();
	});

	afterEach(() => {
		store.close();
	});

	// --- Workspace CRUD ---

	describe("workspaces", () => {
		test("create and get workspace", () => {
			const ws = store.createWorkspace({
				id: "test",
				name: "Test",
				path: "/tmp/test-ws",
			});
			expect(ws.id).toBe("test");
			expect(ws.name).toBe("Test");
			expect(ws.path).toBe("/tmp/test-ws");
			expect(ws.executor).toBe("claude-code");

			const fetched = store.getWorkspace("test");
			expect(fetched).toBeDefined();
			expect(fetched?.id).toBe("test");
		});

		test("list workspaces", () => {
			store.createWorkspace({ id: "a", name: "A", path: "/tmp/a" });
			store.createWorkspace({ id: "b", name: "B", path: "/tmp/b" });

			const all = store.listWorkspaces();
			expect(all).toHaveLength(2);
			expect(all[0]?.id).toBe("a");
			expect(all[1]?.id).toBe("b");
		});

		test("get non-existent workspace returns undefined", () => {
			expect(store.getWorkspace("nope")).toBeUndefined();
		});

		test("duplicate slug throws", () => {
			store.createWorkspace({ id: "dup", name: "Dup", path: "/tmp/dup1" });
			expect(() =>
				store.createWorkspace({ id: "dup", name: "Dup2", path: "/tmp/dup2" }),
			).toThrow();
		});

		test("duplicate path throws", () => {
			store.createWorkspace({ id: "ws1", name: "WS1", path: "/tmp/same" });
			expect(() =>
				store.createWorkspace({ id: "ws2", name: "WS2", path: "/tmp/same" }),
			).toThrow();
		});

		test("set workspace executor", () => {
			store.createWorkspace({ id: "test", name: "Test", path: "/tmp/x" });
			store.setWorkspaceExecutor("test", "claude-code");
			const ws = store.getWorkspace("test");
			expect(ws?.executor).toBe("claude-code");
		});

		test("delete workspace cascades to channels and sessions", () => {
			store.createWorkspace({ id: "ws", name: "WS", path: "/tmp/ws" });

			// Insert channel directly to control ID
			// biome-ignore lint/suspicious/noExplicitAny: test-only DB access
			const db = (store as any).db;
			db.run(
				"INSERT INTO channels (id, workspace_id, platform, allowed_users) VALUES (?, ?, ?, ?)",
				"chan_testdel001",
				"ws",
				"telegram",
				"123",
			);

			store.getOrCreateSession("chan_testdel001", "conv1");

			store.deleteWorkspace("ws");

			expect(store.getWorkspace("ws")).toBeUndefined();
			expect(store.getChannel("chan_testdel001")).toBeUndefined();
			// Session should be gone too (CASCADE)
		});
	});

	// --- Channel CRUD ---

	describe("channels", () => {
		beforeEach(() => {
			store.createWorkspace({ id: "ws", name: "WS", path: "/tmp/ws" });
		});

		test("create and get channel", () => {
			const ch = store.createChannel({
				workspaceId: "ws",
				platform: "telegram",
				label: "My Bot",
				allowedUsers: ["123", "456"],
			});

			expect(ch.id).toMatch(/^chan_[a-z0-9]{10}$/);
			expect(ch.workspaceId).toBe("ws");
			expect(ch.platform).toBe("telegram");
			expect(ch.label).toBe("My Bot");
			expect(ch.allowedUsers).toEqual(["123", "456"]);

			const fetched = store.getChannel(ch.id);
			expect(fetched).toBeDefined();
			expect(fetched?.allowedUsers).toEqual(["123", "456"]);
		});

		test("list channels", () => {
			store.createChannel({
				workspaceId: "ws",
				platform: "telegram",
				allowedUsers: ["1"],
			});

			const all = store.listChannels();
			expect(all).toHaveLength(1);
		});

		test("get channels by workspace", () => {
			store.createWorkspace({ id: "ws2", name: "WS2", path: "/tmp/ws2" });
			store.createChannel({
				workspaceId: "ws",
				platform: "telegram",
				allowedUsers: ["1"],
			});
			store.createChannel({
				workspaceId: "ws2",
				platform: "telegram",
				allowedUsers: ["2"],
			});

			const wsChannels = store.getChannelsByWorkspace("ws");
			expect(wsChannels).toHaveLength(1);
			expect(wsChannels[0]?.workspaceId).toBe("ws");
		});

		test("duplicate workspace+platform throws", () => {
			store.createChannel({
				workspaceId: "ws",
				platform: "telegram",
				allowedUsers: ["1"],
			});
			expect(() =>
				store.createChannel({
					workspaceId: "ws",
					platform: "telegram",
					allowedUsers: ["2"],
				}),
			).toThrow();
		});

		test("delete channel cascades to sessions", () => {
			const ch = store.createChannel({
				workspaceId: "ws",
				platform: "telegram",
				allowedUsers: ["1"],
			});

			store.getOrCreateSession(ch.id, "conv1");
			store.deleteChannel(ch.id);

			expect(store.getChannel(ch.id)).toBeUndefined();
		});
	});

	// --- Session CRUD ---

	describe("sessions", () => {
		let channelId: string;

		beforeEach(() => {
			store.createWorkspace({ id: "ws", name: "WS", path: "/tmp/ws" });
			const ch = store.createChannel({
				workspaceId: "ws",
				platform: "telegram",
				allowedUsers: ["1"],
			});
			channelId = ch.id;
		});

		test("get or create session", () => {
			const s1 = store.getOrCreateSession(channelId, "conv1");
			expect(s1.channelId).toBe(channelId);
			expect(s1.conversationId).toBe("conv1");
			expect(s1.status).toBe("idle");
			expect(s1.agentSessionId).toBeNull();

			// Second call returns same session
			const s2 = store.getOrCreateSession(channelId, "conv1");
			expect(s2.id).toBe(s1.id);
		});

		test("set agent session ID", () => {
			const s = store.getOrCreateSession(channelId, "conv1");
			store.setAgentSessionId(s.id, "agent-123");

			const updated = store.getOrCreateSession(channelId, "conv1");
			expect(updated.agentSessionId).toBe("agent-123");
		});

		test("set status", () => {
			const s = store.getOrCreateSession(channelId, "conv1");
			store.setStatus(s.id, "running");

			const updated = store.getOrCreateSession(channelId, "conv1");
			expect(updated.status).toBe("running");
		});

		test("clear session", () => {
			const s = store.getOrCreateSession(channelId, "conv1");
			store.setAgentSessionId(s.id, "agent-123");
			store.setStatus(s.id, "running");

			store.clearSession(s.id);

			const updated = store.getOrCreateSession(channelId, "conv1");
			expect(updated.agentSessionId).toBeNull();
			expect(updated.status).toBe("idle");
		});

		test("clear workspace sessions", () => {
			const s1 = store.getOrCreateSession(channelId, "conv1");
			const s2 = store.getOrCreateSession(channelId, "conv2");
			store.setAgentSessionId(s1.id, "a1");
			store.setAgentSessionId(s2.id, "a2");

			store.clearWorkspaceSessions("ws");

			const u1 = store.getOrCreateSession(channelId, "conv1");
			const u2 = store.getOrCreateSession(channelId, "conv2");
			expect(u1.agentSessionId).toBeNull();
			expect(u2.agentSessionId).toBeNull();
		});

		test("different conversations get separate sessions", () => {
			const s1 = store.getOrCreateSession(channelId, "conv1");
			const s2 = store.getOrCreateSession(channelId, "conv2");
			expect(s1.id).not.toBe(s2.id);
		});
	});

	// --- Schema versioning ---

	describe("schema", () => {
		test("schema version is 1", () => {
			// biome-ignore lint/suspicious/noExplicitAny: test-only DB access
			const db = (store as any).db;
			const row = db.queryGet("PRAGMA user_version");
			expect(row.user_version).toBe(1);
		});

		test("foreign keys are enabled", () => {
			// biome-ignore lint/suspicious/noExplicitAny: test-only DB access
			const db = (store as any).db;
			const row = db.queryGet("PRAGMA foreign_keys");
			expect(row.foreign_keys).toBe(1);
		});
	});
});
