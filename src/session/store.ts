import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Session {
	id: number;
	platform: string;
	threadId: string;
	agentSessionId: string | null;
	cwd: string;
	status: "idle" | "running";
	createdAt: string;
	updatedAt: string;
}

interface SessionRow {
	id: number;
	platform: string;
	thread_id: string;
	agent_session_id: string | null;
	cwd: string;
	status: string;
	created_at: string;
	updated_at: string;
}

function toSession(row: SessionRow): Session {
	return {
		id: row.id,
		platform: row.platform,
		threadId: row.thread_id,
		agentSessionId: row.agent_session_id,
		cwd: row.cwd,
		status: row.status as "idle" | "running",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SessionStore {
	private db: Database;

	constructor(dbPath?: string) {
		const dir = dbPath
			? dirname(dbPath)
			: join(process.env.HOME ?? "~", ".bae");
		mkdirSync(dir, { recursive: true, mode: 0o700 });

		const path = dbPath ?? join(dir, "bae.db");
		this.db = new Database(path);

		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec("PRAGMA busy_timeout = 5000");

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id               INTEGER PRIMARY KEY AUTOINCREMENT,
				platform         TEXT NOT NULL,
				thread_id        TEXT NOT NULL,
				agent_session_id TEXT,
				cwd              TEXT NOT NULL,
				status           TEXT NOT NULL DEFAULT 'idle',
				created_at       TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
				UNIQUE(platform, thread_id)
			)
		`);

		// Reset any sessions stuck in "running" from a previous crash
		this.db.run(
			"UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE status = 'running'",
		);
	}

	getOrCreate(platform: string, threadId: string, defaultCwd: string): Session {
		const existing = this.db
			.query<SessionRow, [string, string]>(
				"SELECT * FROM sessions WHERE platform = ? AND thread_id = ?",
			)
			.get(platform, threadId);

		if (existing) return toSession(existing);

		const result = this.db
			.query<SessionRow, [string, string, string]>(
				`INSERT INTO sessions (platform, thread_id, cwd)
				 VALUES (?, ?, ?)
				 RETURNING *`,
			)
			.get(platform, threadId, defaultCwd);

		if (!result) throw new Error("Failed to create session");
		return toSession(result);
	}

	setAgentSessionId(id: number, sessionId: string): void {
		this.db.run(
			"UPDATE sessions SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?",
			[sessionId, id],
		);
	}

	setStatus(id: number, status: "idle" | "running"): void {
		this.db.run(
			"UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
			[status, id],
		);
	}

	clearSession(id: number): void {
		this.db.run(
			"UPDATE sessions SET agent_session_id = NULL, status = 'idle', updated_at = datetime('now') WHERE id = ?",
			[id],
		);
	}

	close(): void {
		this.db.close();
	}
}
