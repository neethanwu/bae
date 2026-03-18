import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { writeChannelCredentials } from "../credentials.ts";
import { Store } from "../session/store.ts";
import type { Platform } from "../session/types.ts";
import { parseEnvFile } from "./env.ts";
import { slugFromPath } from "./workspace.ts";

const BAE_DIR = join(homedir(), ".bae");
const ENV_FILE = join(BAE_DIR, ".env");

function parseFlags(argv: string[]): Record<string, string> {
	const flags: Record<string, string> = {};
	for (const arg of argv) {
		const match = arg.match(/^--([a-z-]+)=(.+)$/);
		if (match?.[1] && match[2]) {
			flags[match[1]] = match[2];
		}
	}
	return flags;
}

/**
 * Write global non-secret config (~/.bae/.env).
 * Only BAE_PORT goes here now — credentials and workspace config live in DB + credential files.
 */
function writeGlobalConfig(port: string): void {
	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(ENV_FILE, `BAE_PORT=${port}\n`, { mode: 0o600 });
}

/**
 * Create workspace + channel in the store, and write the credential file.
 * Idempotent: if workspace/channel already exist, updates them.
 */
async function setupWorkspaceAndChannel(opts: {
	store: Store;
	workspacePath: string;
	botToken: string;
	allowedUsers: string[];
	platform: Platform;
}): Promise<{ slug: string; channelId: string }> {
	const { store, workspacePath, botToken, allowedUsers, platform } = opts;

	const expanded = workspacePath.startsWith("~/")
		? resolve(homedir(), workspacePath.slice(2))
		: resolve(workspacePath);
	mkdirSync(expanded, { recursive: true });

	const slug = slugFromPath(expanded);

	// Idempotent: check if workspace exists
	let ws = store.getWorkspace(slug);
	if (!ws) {
		ws = store.createWorkspace({ id: slug, name: slug, path: expanded });
	}

	// Idempotent: check if channel exists for this workspace + platform
	const existingChannels = store.getChannelsByWorkspace(slug);
	const existingChannel = existingChannels.find(
		(ch) => ch.platform === platform,
	);

	if (existingChannel) {
		// Update credentials for existing channel
		writeChannelCredentials(existingChannel.id, {
			TELEGRAM_BOT_TOKEN: botToken,
		});
		return { slug, channelId: existingChannel.id };
	}

	// Create new channel
	const channel = store.createChannel({
		workspaceId: slug,
		platform,
		label: `${slug} on ${platform}`,
		allowedUsers,
	});

	writeChannelCredentials(channel.id, { TELEGRAM_BOT_TOKEN: botToken });
	return { slug, channelId: channel.id };
}

export async function runInit(argv: string[] = []): Promise<void> {
	const flags = parseFlags(argv);
	const existing = parseEnvFile(ENV_FILE);

	// Open store for DB operations
	const store = new Store();
	await store.waitReady();

	try {
		// Headless mode
		if (flags.token && flags["allowed-users"]) {
			const botToken = flags.token;
			if (!botToken.includes(":")) {
				console.error("Invalid token format (expected id:secret)");
				process.exit(1);
			}

			const botInfo = await validateToken(botToken);
			if (!botInfo) {
				console.error("Invalid token. Could not connect to Telegram.");
				process.exit(1);
			}
			console.log(`Connected as @${botInfo.username}`);

			const userIds = flags["allowed-users"].split(",").map((s) => s.trim());
			if (userIds.some((id) => !/^\d+$/.test(id))) {
				console.error("User IDs must be numeric");
				process.exit(1);
			}

			const workspace = flags.workspace || join(homedir(), "baesment");
			const port = existing.BAE_PORT || "3456";

			writeGlobalConfig(port);
			const { slug } = await setupWorkspaceAndChannel({
				store,
				workspacePath: workspace,
				botToken,
				allowedUsers: userIds,
				platform: "telegram",
			});

			console.log(
				`Ready! @${botInfo.username} → ${workspace} (workspace: ${slug})`,
			);
			console.log("Run `bae start` to begin.");
			return;
		}

		// Interactive mode
		console.log(`
 ██████╗  █████╗ ███████╗
 ██╔══██╗██╔══██╗██╔════╝
 ██████╔╝███████║█████╗
 ██╔══██╗██╔══██║██╔══╝
 ██████╔╝██║  ██║███████╗
 ╚═════╝ ╚═╝  ╚═╝╚══════╝
`);
		p.intro("Bae Setup");

		const workspaces = store.listWorkspaces();
		if (workspaces.length > 0) {
			const reconfigure = await p.confirm({
				message: `Found ${workspaces.length} workspace(s). Reconfigure?`,
				initialValue: true,
			});
			if (p.isCancel(reconfigure) || !reconfigure) {
				p.outro("Run `bae start` to begin.");
				return;
			}
		}

		// 1. Detect agent CLI
		const agentInfo = detectAgent();
		if (agentInfo) {
			p.log.success(`${agentInfo.name} found (${agentInfo.version})`);
			try {
				execSync("claude auth status", { stdio: "pipe", timeout: 5000 });
				p.log.success("claude authenticated");
			} catch {
				p.log.warn("claude may not be authenticated. Run: claude auth login");
			}
		} else {
			p.log.warn(
				"No agent CLI found. Install one first (e.g. npm install -g @anthropic-ai/claude-code)",
			);
		}

		// 2. Platform
		p.note("Slack and Discord support coming soon.", "Other platforms");

		// 3. Collect bot token
		p.log.info(
			"To create a Telegram bot:\n" +
				"  1. Open Telegram and message @BotFather\n" +
				"  2. Send /newbot and follow the prompts\n" +
				"  3. Copy the bot token",
		);

		const botToken = await p.text({
			message: "Bot token:",
			placeholder: "123456:ABC-DEF...",
			validate: (val) => {
				if (!val || !val.includes(":"))
					return "Invalid token format (expected id:secret)";
			},
		});

		if (p.isCancel(botToken)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		const botInfo = await validateToken(botToken);
		if (botInfo) {
			p.log.success(`Connected as @${botInfo.username}`);
		} else {
			p.log.error("Invalid token. Could not connect to Telegram.");
			process.exit(1);
		}

		// 4. User restriction
		const restrictUsers = await p.confirm({
			message: "Restrict to specific users? (recommended)",
			initialValue: true,
		});

		if (p.isCancel(restrictUsers)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		let allowedUsers: string[] = [];
		if (restrictUsers) {
			p.log.info(
				"To find your Telegram user ID, message @userinfobot on Telegram.",
			);

			const userIds = await p.text({
				message: "Your Telegram user ID(s):",
				placeholder: "123456789 (comma-separated for multiple)",
				validate: (val) => {
					if (!val) return "At least one user ID is required";
					const ids = val.split(",").map((s) => s.trim());
					if (ids.some((id) => !/^\d+$/.test(id)))
						return "User IDs must be numeric";
				},
			});

			if (p.isCancel(userIds)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}

			allowedUsers = userIds
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}

		if (allowedUsers.length === 0) {
			p.log.warn(
				"No user restrictions set. Anyone who finds your bot can use it.",
			);
			// Still need at least a placeholder — the DB enforces non-empty
			// For unrestricted mode, we'd need a schema change. For now, require at least one.
			p.log.error("At least one user ID is required for security.");
			process.exit(1);
		}

		// 5. Workspace
		const defaultCwd = join(homedir(), "baesment");
		const workspace = await p.text({
			message: "Workspace directory (where the agent works):",
			defaultValue: defaultCwd,
			placeholder: defaultCwd,
		});

		if (p.isCancel(workspace)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		// 6. Write config
		const port = existing.BAE_PORT || "3456";
		writeGlobalConfig(port);

		const { slug } = await setupWorkspaceAndChannel({
			store,
			workspacePath: workspace,
			botToken,
			allowedUsers,
			platform: "telegram",
		});

		const accessLabel = `${allowedUsers.length} authorized user${allowedUsers.length > 1 ? "s" : ""}`;

		p.note(
			[
				`Bot:        @${botInfo.username}`,
				`Workspace:  ${workspace} (${slug})`,
				`Access:     ${accessLabel}`,
			].join("\n"),
			"You're all set!",
		);
		p.outro("Run `bae start` to begin.");
	} finally {
		store.close();
	}
}

interface AgentInfo {
	name: string;
	version: string;
}

function detectAgent(): AgentInfo | null {
	try {
		const output = execSync("claude --version 2>&1", {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
		const match = output.match(/(\d+\.\d+[.\d]*)/);
		return {
			name: "Claude Code",
			version: match?.[1] ?? output.slice(0, 30),
		};
	} catch {
		return null;
	}
}

interface TelegramBotInfo {
	username: string;
}

async function validateToken(token: string): Promise<TelegramBotInfo | null> {
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
		if (!res.ok) return null;
		const data = (await res.json()) as {
			ok: boolean;
			result?: { username: string };
		};
		if (!data.ok || !data.result) return null;
		return { username: data.result.username };
	} catch {
		return null;
	}
}
