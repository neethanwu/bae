import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";

const BAE_DIR = join(homedir(), ".bae");
const ENV_FILE = join(BAE_DIR, ".env");

export async function runInit(): Promise<void> {
	p.intro("Bae Setup");

	// 1. Detect agent CLI
	const agentInfo = detectAgent();
	if (agentInfo) {
		p.log.success(`${agentInfo.name} found (${agentInfo.version})`);
	} else {
		p.log.warn(
			"No agent CLI found. Install one first (e.g. npm install -g @anthropic-ai/claude-code)",
		);
	}

	// 2. Platform selection
	const platform = await p.select({
		message: "Which messaging platform?",
		options: [
			{ label: "Telegram", value: "telegram" },
			{ label: "Slack (coming soon)", value: "slack", hint: "not yet" },
			{
				label: "Discord (coming soon)",
				value: "discord",
				hint: "not yet",
			},
		],
	});

	if (p.isCancel(platform)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	if (platform !== "telegram") {
		p.log.warn("Only Telegram is supported in this release. Select Telegram.");
		process.exit(1);
	}

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

	// Validate token
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

	let allowedUsers = "";
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
		defaultValue: defaultCwd,
		placeholder: defaultCwd,
	});

	if (p.isCancel(workspace)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	const resolvedWorkspace = workspace.startsWith("~")
		? workspace.replace("~", homedir())
		: workspace;

	// 6. Write .env
	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(resolvedWorkspace, { recursive: true });

	const envContent = [
		`TELEGRAM_BOT_TOKEN=${botToken}`,
		allowedUsers ? `BAE_ALLOWED_USERS=${allowedUsers}` : "",
		`BAE_CWD=${workspace}`,
		"BAE_PORT=3456",
	]
		.filter(Boolean)
		.join("\n");

	// Check for existing .env
	if (existsSync(ENV_FILE)) {
		const overwrite = await p.confirm({
			message: `${ENV_FILE} already exists. Overwrite?`,
			initialValue: false,
		});

		if (p.isCancel(overwrite) || !overwrite) {
			p.log.warn("Keeping existing config.");
			p.outro("Run `bae start` to begin.");
			return;
		}
	}

	writeFileSync(ENV_FILE, `${envContent}\n`, { mode: 0o600 });
	p.log.success(`Config written to ${ENV_FILE}`);

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
		// Extract version from output like "claude 1.2.3" or similar
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
