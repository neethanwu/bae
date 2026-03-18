import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import * as p from "@clack/prompts";
import type { Store } from "../session/store.ts";
import type { ExecutorType } from "../session/types.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BAE_DIR_PATH = resolve(homedir(), ".bae");

/** Paths that should never be used as a workspace (agent gets full access). */
const BLOCKED_PATHS = new Set([
	"/",
	"/etc",
	"/usr",
	"/var",
	"/System",
	homedir(),
	BAE_DIR_PATH,
]);

export async function workspaceCommand(
	args: string[],
	store: Store,
): Promise<void> {
	const sub = args[0];

	switch (sub) {
		case "list":
			return listWorkspaces(store);
		case "add":
			return addWorkspace(args.slice(1), store);
		case "remove":
			return removeWorkspace(args.slice(1), store);
		case "set-executor":
			return setExecutor(args.slice(1), store);
		default:
			console.error(
				`Unknown workspace command: ${sub}\nUsage: bae workspace [list|add|remove|set-executor]`,
			);
			process.exit(1);
	}
}

function listWorkspaces(store: Store): void {
	const workspaces = store.listWorkspaces();
	if (workspaces.length === 0) {
		console.log(
			"No workspaces configured. Run `bae init` or `bae workspace add`.",
		);
		return;
	}

	// Calculate column widths for alignment
	const rows = workspaces.map((ws) => {
		const channels = store.getChannelsByWorkspace(ws.id);
		return {
			id: ws.id,
			path: ws.path,
			executor: ws.executor,
			channels: `${channels.length} channel${channels.length !== 1 ? "s" : ""}`,
		};
	});

	const idWidth = Math.max(...rows.map((r) => r.id.length));
	const pathWidth = Math.max(...rows.map((r) => r.path.length));

	console.log();
	for (const r of rows) {
		console.log(
			`  ${r.id.padEnd(idWidth)}  ${r.path.padEnd(pathWidth)}  ${r.executor}  ${r.channels}`,
		);
	}
	console.log();
}

function parseWorkspaceFlags(argv: string[]): {
	slug?: string;
	name?: string;
	path?: string;
	executor?: string;
	force?: boolean;
} {
	const result: ReturnType<typeof parseWorkspaceFlags> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;
		if (arg === "--force" || arg === "-f") {
			result.force = true;
		} else if (arg === "--name" && argv[i + 1]) {
			result.name = argv[++i];
		} else if (arg === "--path" && argv[i + 1]) {
			result.path = argv[++i];
		} else if (arg === "--executor" && argv[i + 1]) {
			result.executor = argv[++i];
		} else if (!arg.startsWith("-") && !result.slug) {
			result.slug = arg;
		}
	}
	return result;
}

async function addWorkspace(args: string[], store: Store): Promise<void> {
	const flags = parseWorkspaceFlags(args);

	const slug = flags.slug;
	if (!slug) {
		console.error(
			"Usage: bae workspace add <slug> --name <name> --path <path> [--executor claude-code]",
		);
		process.exit(1);
	}

	if (!SLUG_RE.test(slug)) {
		console.error(
			`Invalid slug "${slug}". Must be lowercase alphanumeric with hyphens, 1-32 chars.`,
		);
		process.exit(1);
	}

	const path = flags.path;
	if (!path) {
		console.error("--path is required");
		process.exit(1);
	}

	// Expand ~ and resolve
	const expanded = path.startsWith("~/")
		? resolve(homedir(), path.slice(2))
		: resolve(path);

	if (BLOCKED_PATHS.has(expanded)) {
		console.error(
			`Path "${expanded}" is blocked for safety. The agent gets full access to the workspace directory.`,
		);
		process.exit(1);
	}

	const name = flags.name ?? slug;
	const executor = (flags.executor ?? "claude-code") as ExecutorType;

	// Create the directory if it doesn't exist
	if (!existsSync(expanded)) {
		mkdirSync(expanded, { recursive: true });
	}

	try {
		const ws = store.createWorkspace({
			id: slug,
			name,
			path: expanded,
			executor,
		});
		console.log(`Workspace "${ws.id}" created at ${ws.path}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("UNIQUE") && msg.includes("path")) {
			console.error(`Path "${expanded}" is already used by another workspace.`);
		} else if (msg.includes("PRIMARY")) {
			console.error(`Workspace "${slug}" already exists.`);
		} else {
			console.error(`Failed to create workspace: ${msg}`);
		}
		process.exit(1);
	}
}

async function removeWorkspace(args: string[], store: Store): Promise<void> {
	const flags = parseWorkspaceFlags(args);
	const slug = flags.slug;
	if (!slug) {
		console.error("Usage: bae workspace remove <slug> [--force]");
		process.exit(1);
	}

	const ws = store.getWorkspace(slug);
	if (!ws) {
		console.error(`Workspace "${slug}" not found.`);
		process.exit(1);
	}

	// Check for running BAE instance
	checkNotRunning();

	if (!flags.force) {
		const channels = store.getChannelsByWorkspace(slug);
		const confirm = await p.confirm({
			message: `Delete workspace "${slug}" (${ws.path}) and its ${channels.length} channel(s)?`,
		});
		if (p.isCancel(confirm) || !confirm) {
			console.log("Cancelled.");
			return;
		}
	}

	// Delete credential files BEFORE DB records (security: avoid orphaned token files)
	const { deleteChannelCredentials } = await import("../credentials.ts");
	const channels = store.getChannelsByWorkspace(slug);
	for (const ch of channels) {
		deleteChannelCredentials(ch.id);
	}

	store.deleteWorkspace(slug);
	console.log(`Workspace "${slug}" deleted.`);
}

async function setExecutor(args: string[], store: Store): Promise<void> {
	const slug = args[0];
	const executor = args[1] as ExecutorType | undefined;

	if (!slug || !executor) {
		console.error("Usage: bae workspace set-executor <slug> <executor>");
		process.exit(1);
	}

	const ws = store.getWorkspace(slug);
	if (!ws) {
		console.error(`Workspace "${slug}" not found.`);
		process.exit(1);
	}

	store.setWorkspaceExecutor(slug, executor);
	store.clearWorkspaceSessions(slug);
	console.log(
		`Workspace "${slug}" executor set to "${executor}". Session history cleared.`,
	);
}

/** Derive a slug from a workspace path basename. */
export function slugFromPath(p: string): string {
	const name = basename(p)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return name || "default";
}

function checkNotRunning(): void {
	const { existsSync: exists, readFileSync } = require("node:fs");
	const { join } = require("node:path");
	const { homedir: home } = require("node:os");
	const pidFile = join(home(), ".bae", "bae.pid");
	if (!exists(pidFile)) return;
	const raw = readFileSync(pidFile, "utf-8").trim();
	const pid = Number.parseInt(raw.split(":")[0] ?? "", 10);
	if (Number.isNaN(pid)) return;
	try {
		process.kill(pid, 0);
		console.error(
			`Bae is running (PID ${pid}). Stop it first with \`bae stop\`.`,
		);
		process.exit(1);
	} catch {
		// Not running — stale PID file, fine to proceed
	}
}
