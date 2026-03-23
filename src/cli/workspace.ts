import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import * as p from "@clack/prompts";
import type { Store } from "../session/store.ts";
import type { ExecutorType } from "../session/types.ts";
import { isBaeRunning, restartIfRunning } from "./restart.ts";

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
		case "help":
		case "--help":
		case "-h":
		case undefined:
			console.log(`
  bae workspace — Manage workspaces

  Commands:
    list                              List all workspaces
    add [slug]                        Add a workspace (interactive if no flags)
    remove <slug>                     Remove a workspace and its channels
    set-executor <slug> <executor>    Change the agent for a workspace

  Options (add):
    --path <directory>    Workspace directory (defaults to current directory)
    --name <name>         Display name (defaults to slug)
    --executor <type>     Agent executor (defaults to claude-code)

  Examples:
    bae workspace add research --path ~/research
    bae workspace add                              (interactive)
    bae workspace list
    bae workspace remove old-project
`);
			break;
		default:
			console.error(
				`Unknown workspace command: ${sub}\nRun \`bae workspace --help\` for usage.`,
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

	// Path first, then slug (smart defaults)
	let path = flags.path;
	if (!path) {
		const pathInput = await p.text({
			message: "Workspace directory:",
			defaultValue: process.cwd(),
			placeholder: process.cwd(),
		});
		if (p.isCancel(pathInput)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}
		path = pathInput;
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

	// Slug with smart default derived from path
	let slug = flags.slug;
	if (!slug) {
		const defaultSlug = slugFromPath(expanded);
		const slugInput = await p.text({
			message: "Workspace slug (short name):",
			defaultValue: defaultSlug,
			placeholder: defaultSlug,
			validate: (val) => {
				const v = val || defaultSlug;
				if (!SLUG_RE.test(v))
					return "Must be lowercase alphanumeric with hyphens, 1-32 chars";
			},
		});
		if (p.isCancel(slugInput)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}
		slug = slugInput;
	}

	if (!SLUG_RE.test(slug)) {
		console.error(
			`Invalid slug "${slug}". Must be lowercase alphanumeric with hyphens, 1-32 chars.`,
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

	// Offer to add a channel
	const addChannel = await p.confirm({
		message: "Add a channel now?",
		initialValue: true,
	});
	if (!p.isCancel(addChannel) && addChannel) {
		const { channelCommand } = await import("./channel.ts");
		await channelCommand(["add", slug], store);
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
	if (isBaeRunning()) restartIfRunning();
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
	if (isBaeRunning()) restartIfRunning();
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
