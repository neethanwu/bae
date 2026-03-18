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
	credentials: Record<string, string>;
	allowedUsers: string[];
	platform: Platform;
}): Promise<{ slug: string; channelId: string }> {
	const { store, workspacePath, credentials, allowedUsers, platform } = opts;

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
		writeChannelCredentials(existingChannel.id, credentials);
		return { slug, channelId: existingChannel.id };
	}

	// Create new channel
	const channel = store.createChannel({
		workspaceId: slug,
		platform,
		label: `${slug} on ${platform}`,
		allowedUsers,
	});

	writeChannelCredentials(channel.id, credentials);
	return { slug, channelId: channel.id };
}

export async function runInit(argv: string[] = []): Promise<void> {
	const flags = parseFlags(argv);
	const existing = parseEnvFile(ENV_FILE);

	// Open store for DB operations
	const store = new Store();
	await store.waitReady();

	try {
		// Headless mode — supports both Telegram and Slack
		if (flags.token && flags["allowed-users"]) {
			const platform = (flags.platform ?? "telegram") as Platform;
			const workspace = flags.workspace || join(homedir(), "baesment");
			const port = existing.BAE_PORT || "3456";
			const userIds = flags["allowed-users"].split(",").map((s) => s.trim());

			let credentials: Record<string, string>;
			let displayName: string;

			if (platform === "slack") {
				const botToken = flags["bot-token"] || flags.token;
				const appToken = flags["app-token"];
				if (!botToken?.startsWith("xoxb-")) {
					console.error("Slack bot token must start with xoxb-");
					process.exit(1);
				}
				if (!appToken?.startsWith("xapp-")) {
					console.error(
						"Slack app token (--app-token) is required and must start with xapp-",
					);
					process.exit(1);
				}
				credentials = { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken };
				displayName = "Slack";
			} else {
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
				credentials = { TELEGRAM_BOT_TOKEN: botToken };
				displayName = `@${botInfo.username}`;
			}

			writeGlobalConfig(port);
			const { slug } = await setupWorkspaceAndChannel({
				store,
				workspacePath: workspace,
				credentials,
				allowedUsers: userIds,
				platform,
			});

			console.log(`Ready! ${displayName} → ${workspace} (workspace: ${slug})`);
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

		// 2. Platform selection
		const platformOptions: { value: string; label: string }[] = [
			{ value: "telegram", label: "Telegram" },
			{ value: "slack", label: "Slack" },
		];
		if (process.platform === "darwin") {
			platformOptions.push({
				value: "imessage",
				label: "iMessage (macOS only)",
			});
		}

		const platformChoice = await p.select({
			message: "Platform:",
			options: platformOptions,
		});

		if (p.isCancel(platformChoice)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		const platform = platformChoice as Platform;

		// 3. Collect credentials (platform-specific)
		let credentials: Record<string, string> = {};
		let displayName: string = platform;

		if (platform === "telegram") {
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

			credentials = { TELEGRAM_BOT_TOKEN: botToken };
			displayName = `@${botInfo.username}`;
		} else if (platform === "slack") {
			p.log.info(
				"To create a Slack app:\n" +
					"  1. Go to https://api.slack.com/apps → Create New App → From a manifest\n" +
					"  2. Paste the manifest from slack-manifest.json in the BAE repo\n" +
					"  3. Under Basic Information → App-Level Tokens, generate one with connections:write\n" +
					"  4. Under Install App, install to your workspace\n" +
					"  5. Copy both tokens below",
			);

			const botToken = await p.text({
				message: "Bot OAuth token (xoxb-...):",
				validate: (val) => {
					if (!val?.startsWith("xoxb-")) return "Must start with xoxb-";
				},
			});
			if (p.isCancel(botToken)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}

			const appToken = await p.text({
				message: "App-Level token (xapp-...):",
				validate: (val) => {
					if (!val?.startsWith("xapp-")) return "Must start with xapp-";
				},
			});
			if (p.isCancel(appToken)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}

			// Validate Slack bot token
			try {
				const { WebClient } = await import("@slack/web-api");
				const web = new WebClient(botToken);
				const result = await web.auth.test();
				if (result.ok) {
					p.log.success(`Connected to ${result.team}`);
				}
			} catch {
				p.log.error("Invalid Slack bot token.");
				process.exit(1);
			}

			credentials = { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken };
			displayName = "Slack";
		} else if (platform === "imessage") {
			// iMessage — no credentials needed, validate chat.db access
			p.log.info(
				"iMessage local mode reads from your Mac's Messages database.\n" +
					"Requirements:\n" +
					"  1. macOS with iMessage signed in\n" +
					"  2. Full Disk Access for your terminal\n" +
					"  3. Automation permission for Messages.app",
			);
			p.log.warn(
				"Note: Full Disk Access grants read access to ALL your messages.",
			);

			try {
				const { accessSync, constants } = await import("node:fs");
				accessSync(join(homedir(), "Library/Messages/chat.db"), constants.R_OK);
				p.log.success("Messages database accessible");
			} catch {
				p.log.error(
					"Cannot read Messages database. Full Disk Access is required.",
				);
				try {
					const { execSync } = await import("node:child_process");
					p.log.info("Opening System Settings → Full Disk Access...");
					execSync(
						"open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'",
					);
					p.log.info(
						"Add your terminal app, then restart the terminal and try again.",
					);
				} catch {
					p.log.info(
						"Open manually: System Settings → Privacy & Security → Full Disk Access",
					);
				}
				process.exit(1);
			}

			credentials = {};
			displayName = "iMessage";
		}

		// 4. User restriction
		const userIdHint =
			platform === "telegram"
				? "To find your Telegram user ID, message @userinfobot on Telegram."
				: platform === "slack"
					? "To find your Slack user ID: profile → ⋯ menu → Copy member ID"
					: "Use your phone number (+1234567890) or Apple ID email.";
		p.log.info(userIdHint);

		const placeholders: Record<string, string> = {
			telegram: "123456789 (comma-separated for multiple)",
			slack: "U0123ABCDE (comma-separated for multiple)",
			imessage: "+1234567890 or email@example.com",
		};

		const userIds = await p.text({
			message: "Your user ID(s):",
			placeholder: placeholders[platform] ?? "",
			validate: (val) => {
				if (!val) return "At least one user ID is required";
				const ids = val.split(",").map((s) => s.trim());
				if (platform === "telegram" && ids.some((id) => !/^\d+$/.test(id)))
					return "Telegram user IDs must be numeric";
				if (
					platform === "slack" &&
					ids.some((id) => !/^[UW][A-Z0-9]+$/.test(id))
				)
					return "Slack user IDs must start with U or W";
				if (
					platform === "imessage" &&
					ids.some(
						(id) =>
							!/^\+\d+$/.test(id) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id),
					)
				)
					return "iMessage user IDs must be phone numbers (+1234567890) or email addresses";
			},
		});

		if (p.isCancel(userIds)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		const allowedUsers = userIds
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		if (allowedUsers.length === 0) {
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
			credentials,
			allowedUsers,
			platform,
		});

		const accessLabel = `${allowedUsers.length} authorized user${allowedUsers.length > 1 ? "s" : ""}`;

		p.note(
			[
				`Channel:    ${displayName}`,
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
