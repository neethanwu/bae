/**
 * Cross-runtime SQLite adapter.
 *
 * Uses bun:sqlite on Bun, better-sqlite3 on Node.js.
 * Exposes a unified interface so the rest of the codebase doesn't care
 * which runtime is in use.
 *
 * Adapted from QMD's approach: https://github.com/tobi/qmd
 */

const isBun = typeof globalThis.Bun !== "undefined";

/** Minimal unified interface over bun:sqlite and better-sqlite3. */
export interface DB {
	exec(sql: string): void;
	pragma(directive: string): void;
	queryGet<T>(sql: string, ...params: unknown[]): T | undefined;
	queryAll<T>(sql: string, ...params: unknown[]): T[];
	run(sql: string, ...params: unknown[]): void;
	close(): void;
}

/** Create a new database connection at the given path. */
export async function openDatabase(path: string): Promise<DB> {
	if (isBun) {
		return openBunDatabase(path);
	}
	return openNodeDatabase(path);
}

async function openBunDatabase(path: string): Promise<DB> {
	// String concat prevents tsc from resolving bun:sqlite during Node builds
	const mod = "bun:" + "sqlite";
	const { Database } = await import(/* @vite-ignore */ mod);
	const db = new Database(path);

	return {
		exec: (sql) => db.exec(sql),
		pragma: (directive) => db.exec(`PRAGMA ${directive}`),
		queryGet: <T>(sql: string, ...params: unknown[]) =>
			db.query(sql).get(...params) as T | undefined,
		queryAll: <T>(sql: string, ...params: unknown[]) =>
			db.query(sql).all(...params) as T[],
		run: (sql, ...params) => db.run(sql, ...params),
		close: () => db.close(),
	};
}

async function openNodeDatabase(path: string): Promise<DB> {
	const BetterSqlite3 = (await import("better-sqlite3")).default;
	const db = new BetterSqlite3(path);

	return {
		exec: (sql) => db.exec(sql),
		pragma: (directive) => db.pragma(directive),
		queryGet: <T>(sql: string, ...params: unknown[]) =>
			db.prepare(sql).get(...params) as T | undefined,
		queryAll: <T>(sql: string, ...params: unknown[]) =>
			db.prepare(sql).all(...params) as T[],
		run: (sql, ...params) => db.prepare(sql).run(...params),
		close: () => db.close(),
	};
}
