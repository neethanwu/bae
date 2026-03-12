import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { parseEnvFile } from "./env.ts";

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

function resolveWorkspace(workspace: string): string {
	return workspace.startsWith("~")
		? workspace.replace("~", homedir())
		: workspace;
}

function writeConfig(values: {
	botToken: string;
	allowedUsers: string;
	workspace: string;
	existingPort?: string;
}): void {
	const resolvedWorkspace = resolveWorkspace(values.workspace);

	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(resolvedWorkspace, { recursive: true });

	const envContent = [
		`TELEGRAM_BOT_TOKEN=${values.botToken}`,
		`BAE_ALLOWED_USERS=${values.allowedUsers}`,
		`BAE_CWD=${resolvedWorkspace}`,
		`BAE_PORT=${values.existingPort || "3456"}`,
	].join("\n");

	writeFileSync(ENV_FILE, `${envContent}\n`, { mode: 0o600 });
}

export async function runInit(argv: string[] = []): Promise<void> {
	const flags = parseFlags(argv);
	const existing = parseEnvFile(ENV_FILE);

	// Headless mode: all required flags provided
	if (flags.token && flags["allowed-users"]) {
		const botToken = flags.token;

		// Validate token format
		if (!botToken.includes(":")) {
			console.error("Invalid token format (expected id:secret)");
			process.exit(1);
		}

		// Validate token against Telegram API
		const botInfo = await validateToken(botToken);
		if (!botInfo) {
			console.error("Invalid token. Could not connect to Telegram.");
			process.exit(1);
		}
		console.log(`Connected as @${botInfo.username}`);

		// Validate user IDs are numeric
		const userIds = flags["allowed-users"].split(",").map((s) => s.trim());
		if (userIds.some((id) => !/^\d+$/.test(id))) {
			console.error("User IDs must be numeric");
			process.exit(1);
		}

		const workspace =
			flags.workspace || existing.BAE_CWD || join(homedir(), "baesment");

		writeConfig({
			botToken,
			allowedUsers: flags["allowed-users"],
			workspace,
			existingPort: existing.BAE_PORT,
		});

		console.log(`Ready! @${botInfo.username} → ${workspace}`);
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

	const hasExisting = Object.keys(existing).length > 0;

	if (hasExisting) {
		const reconfigure = await p.confirm({
			message: "Existing config found. Reconfigure?",
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
		// Check auth status
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
		initialValue: existing.TELEGRAM_BOT_TOKEN,
		validate: (val) => {
			if (!val || !val.includes(":"))
				return "Invalid token format (expected id:secret)";
		},
	});

	if (p.isCancel(botToken)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	// Validate token
	const botInfo = await validateToken(botToken);
	if (botInfo) {
		p.log.success(`Connected as @${botInfo.username}`);
	} else {
		p.log.error("Invalid token. Could not connect to Telegram.");
		process.exit(1);
	}

	// 4. User restriction
	const hasExistingUsers = !!existing.BAE_ALLOWED_USERS;
	const restrictUsers = await p.confirm({
		message: "Restrict to specific users? (recommended)",
		initialValue: true,
	});

	if (p.isCancel(restrictUsers)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	let allowedUsers = "";
	if (restrictUsers) {
		p.log.info(
			"To find your Telegram user ID, message @userinfobot on Telegram.",
		);

		const userIds = await p.text({
			message: "Your Telegram user ID(s):",
			placeholder: "123456789 (comma-separated for multiple)",
			initialValue: hasExistingUsers ? existing.BAE_ALLOWED_USERS : undefined,
			validate: (val) => {
				if (!val) return "At least one user ID is required";
				const ids = val.split(",").map((s) => s.trim());
				if (ids.some((id) => !/^\d+$/.test(id))) {
					return "User IDs must be numeric";
				}
			},
		});

		if (p.isCancel(userIds)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		allowedUsers = userIds;
	}

	// 5. Workspace
	const defaultCwd = join(homedir(), "baesment");
	const workspace = await p.text({
		message: "Workspace directory (where the agent works):",
		defaultValue: existing.BAE_CWD || defaultCwd,
		placeholder: existing.BAE_CWD || defaultCwd,
	});

	if (p.isCancel(workspace)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	// 6. Write .env
	writeConfig({
		botToken,
		allowedUsers,
		workspace,
		existingPort: existing.BAE_PORT,
	});

	const userCount = allowedUsers
		? allowedUsers.split(",").filter(Boolean).length
		: 0;
	const accessLabel =
		userCount > 0
			? `${userCount} authorized user${userCount > 1 ? "s" : ""}`
			: "unrestricted";

	p.note(
		[
			`Bot:        @${botInfo.username}`,
			`Workspace:  ${workspace}`,
			`Access:     ${accessLabel}`,
		].join("\n"),
		"You're all set!",
	);
	p.outro("Run `bae start` to begin.");
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
