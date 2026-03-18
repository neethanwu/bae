import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type DB, openDatabase } from "./db.ts";
import {
	type Channel,
	type ChannelRow,
	channelId,
	type ExecutorType,
	type Platform,
	type Session,
	type SessionRow,
	toChannel,
	toSession,
	toWorkspace,
	type Workspace,
	type WorkspaceRow,
} from "./types.ts";

export type { Channel, ExecutorType, Platform, Session, Workspace };

const SCHEMA_V1 = `
	CREATE TABLE IF NOT EXISTS workspaces (
		id          TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		path        TEXT NOT NULL UNIQUE,
		executor    TEXT NOT NULL DEFAULT 'claude-code'
			CHECK(executor IN ('claude-code')),
		created_at  TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE TABLE IF NOT EXISTS channels (
		id            TEXT PRIMARY KEY
			CHECK(id GLOB 'chan_[a-z0-9]*'),
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		platform      TEXT NOT NULL,
		label         TEXT,
		allowed_users TEXT NOT NULL
			CHECK(length(trim(allowed_users)) > 0),
		created_at    TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE(workspace_id, platform)
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id                INTEGER PRIMARY KEY AUTOINCREMENT,
		channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
		conversation_id   TEXT NOT NULL,
		agent_session_id  TEXT,
		status            TEXT NOT NULL DEFAULT 'idle'
			CHECK(status IN ('idle', 'running')),
		created_at        TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE(channel_id, conversation_id)
	);

	CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);
	CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);
`;

export class Store {
	private db!: DB;
	private ready: Promise<void>;

	constructor(dbPath?: string) {
		const dir = dbPath ? dirname(dbPath) : join(homedir(), ".bae");
		mkdirSync(dir, { recursive: true, mode: 0o700 });

		const path = dbPath ?? join(dir, "bae.db");

		this.ready = openDatabase(path).then((db) => {
			this.db = db;
			this.init();
		});
	}

	private init(): void {
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("busy_timeout = 5000");

		// Verify foreign keys are actually enabled
		const fk = this.db.queryGet<{ foreign_keys: number }>(
			"PRAGMA foreign_keys",
		);
		if (!fk || fk.foreign_keys !== 1) {
			throw new Error("Failed to enable foreign keys");
		}

		// Schema versioning — read via queryGet (pragma() returns void)
		const row = this.db.queryGet<{ user_version: number }>(
			"PRAGMA user_version",
		);
		const version = row?.user_version ?? 0;

		if (version < 1) {
			// Drop old sessions table from pre-migration schema (breaking change, zero users)
			this.db.exec("DROP TABLE IF EXISTS sessions");

			this.db.exec("BEGIN");
			try {
				this.db.exec(SCHEMA_V1);
				this.db.exec("PRAGMA user_version = 1");
				this.db.exec("COMMIT");
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw err;
			}
		}

		// Reset any sessions stuck in "running" from a previous crash
		this.db.run(
			"UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE status = 'running'",
		);
	}

	async waitReady(): Promise<void> {
		await this.ready;
	}

	// --- Workspace operations ---

	createWorkspace(opts: {
		id: string;
		name: string;
		path: string;
		executor?: ExecutorType;
	}): Workspace {
		const normalizedPath = normalizePath(opts.path);
		const executor = opts.executor ?? "claude-code";
		const row = this.db.queryGet<WorkspaceRow>(
			`INSERT INTO workspaces (id, name, path, executor)
			 VALUES (?, ?, ?, ?)
			 RETURNING *`,
			opts.id,
			opts.name,
			normalizedPath,
			executor,
		);
		if (!row) throw new Error("Failed to create workspace");
		return toWorkspace(row);
	}

	getWorkspace(id: string): Workspace | undefined {
		const row = this.db.queryGet<WorkspaceRow>(
			"SELECT * FROM workspaces WHERE id = ?",
			id,
		);
		return row ? toWorkspace(row) : undefined;
	}

	listWorkspaces(): Workspace[] {
		return this.db
			.queryAll<WorkspaceRow>("SELECT * FROM workspaces ORDER BY id")
			.map(toWorkspace);
	}

	setWorkspaceExecutor(id: string, executor: ExecutorType): void {
		this.db.run(
			"UPDATE workspaces SET executor = ?, updated_at = datetime('now') WHERE id = ?",
			executor,
			id,
		);
	}

	deleteWorkspace(id: string): void {
		this.db.run("DELETE FROM workspaces WHERE id = ?", id);
	}

	// --- Channel operations ---

	createChannel(opts: {
		workspaceId: string;
		platform: Platform;
		label?: string;
		allowedUsers: string[];
	}): Channel {
		const id = channelId();
		const allowedUsersStr = opts.allowedUsers.join(",");
		const row = this.db.queryGet<ChannelRow>(
			`INSERT INTO channels (id, workspace_id, platform, label, allowed_users)
			 VALUES (?, ?, ?, ?, ?)
			 RETURNING *`,
			id,
			opts.workspaceId,
			opts.platform,
			opts.label ?? null,
			allowedUsersStr,
		);
		if (!row) throw new Error("Failed to create channel");
		return toChannel(row);
	}

	getChannel(id: string): Channel | undefined {
		const row = this.db.queryGet<ChannelRow>(
			"SELECT * FROM channels WHERE id = ?",
			id,
		);
		return row ? toChannel(row) : undefined;
	}

	getChannelsByWorkspace(workspaceId: string): Channel[] {
		return this.db
			.queryAll<ChannelRow>(
				"SELECT * FROM channels WHERE workspace_id = ? ORDER BY platform",
				workspaceId,
			)
			.map(toChannel);
	}

	listChannels(): Channel[] {
		return this.db
			.queryAll<ChannelRow>(
				"SELECT * FROM channels ORDER BY workspace_id, platform",
			)
			.map(toChannel);
	}

	deleteChannel(id: string): void {
		this.db.run("DELETE FROM channels WHERE id = ?", id);
	}

	// --- Session operations ---

	getOrCreateSession(channelId: string, conversationId: string): Session {
		const existing = this.db.queryGet<SessionRow>(
			"SELECT * FROM sessions WHERE channel_id = ? AND conversation_id = ?",
			channelId,
			conversationId,
		);

		if (existing) return toSession(existing);

		const row = this.db.queryGet<SessionRow>(
			`INSERT INTO sessions (channel_id, conversation_id)
			 VALUES (?, ?)
			 RETURNING *`,
			channelId,
			conversationId,
		);

		if (!row) throw new Error("Failed to create session");
		return toSession(row);
	}

	setAgentSessionId(sessionId: number, agentSessionId: string): void {
		this.db.run(
			"UPDATE sessions SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?",
			agentSessionId,
			sessionId,
		);
	}

	setStatus(sessionId: number, status: "idle" | "running"): void {
		this.db.run(
			"UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
			status,
			sessionId,
		);
	}

	clearSession(sessionId: number): void {
		this.db.run(
			"UPDATE sessions SET agent_session_id = NULL, status = 'idle', updated_at = datetime('now') WHERE id = ?",
			sessionId,
		);
	}

	clearWorkspaceSessions(workspaceId: string): void {
		this.db.run(
			`UPDATE sessions SET agent_session_id = NULL, updated_at = datetime('now')
			 WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)`,
			workspaceId,
		);
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Normalize a workspace path to an absolute canonical form.
 * Resolves ~ to homedir, resolves relative paths, strips trailing /.
 * Uses realpathSync to resolve symlinks and macOS case-insensitivity.
 */
function normalizePath(p: string): string {
	// Expand ~ to homedir
	let expanded = p;
	if (expanded.startsWith("~/") || expanded === "~") {
		expanded = join(homedir(), expanded.slice(1));
	}
	const abs = resolve(expanded);

	// Use realpathSync if the path exists (resolves symlinks + macOS case)
	// Fall back to resolve() for not-yet-created directories
	const canonical = existsSync(abs) ? realpathSync(abs) : abs;

	// Strip trailing /
	return canonical.endsWith("/") && canonical.length > 1
		? canonical.slice(0, -1)
		: canonical;
}
