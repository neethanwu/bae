import * as p from "@clack/prompts";
import {
	deleteChannelCredentials,
	readChannelCredentials,
	writeChannelCredentials,
} from "../credentials.ts";
import type { Store } from "../session/store.ts";
import type { Platform } from "../session/types.ts";

export async function channelCommand(
	args: string[],
	store: Store,
): Promise<void> {
	const sub = args[0];

	switch (sub) {
		case "list":
			return listChannels(args.slice(1), store);
		case "add":
			return addChannel(args.slice(1), store);
		case "remove":
			return removeChannel(args.slice(1), store);
		default:
			console.error(
				`Unknown channel command: ${sub}\nUsage: bae channel [list|add|remove]`,
			);
			process.exit(1);
	}
}

function listChannels(args: string[], store: Store): void {
	let workspaceFilter: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--workspace" && args[i + 1]) {
			workspaceFilter = args[++i];
		}
	}

	const channels = workspaceFilter
		? store.getChannelsByWorkspace(workspaceFilter)
		: store.listChannels();

	if (channels.length === 0) {
		console.log("No channels configured. Run `bae init` or `bae channel add`.");
		return;
	}

	// Calculate column widths for alignment
	const rows = channels.map((ch) => ({
		id: ch.id,
		workspace: ch.workspaceId,
		platform: ch.platform,
		label: ch.label ?? "-",
		users: ch.allowedUsers.join(", "),
	}));

	const idWidth = Math.max(...rows.map((r) => r.id.length));
	const wsWidth = Math.max(...rows.map((r) => r.workspace.length));
	const platWidth = Math.max(...rows.map((r) => r.platform.length));
	const labelWidth = Math.max(...rows.map((r) => r.label.length));

	console.log();
	for (const r of rows) {
		console.log(
			`  ${r.id.padEnd(idWidth)}  ${r.workspace.padEnd(wsWidth)}  ${r.platform.padEnd(platWidth)}  ${r.label.padEnd(labelWidth)}  users: ${r.users}`,
		);
	}
	console.log();
}

function parseChannelFlags(argv: string[]): {
	slug?: string;
	platform?: string;
	label?: string;
	channelId?: string;
	force?: boolean;
} {
	const result: ReturnType<typeof parseChannelFlags> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;
		if (arg === "--force" || arg === "-f") {
			result.force = true;
		} else if (arg === "--platform" && argv[i + 1]) {
			result.platform = argv[++i];
		} else if (arg === "--label" && argv[i + 1]) {
			result.label = argv[++i];
		} else if (!arg.startsWith("-") && !result.slug) {
			result.slug = arg;
		}
	}
	return result;
}

async function addChannel(args: string[], store: Store): Promise<void> {
	const flags = parseChannelFlags(args);

	const workspaceSlug = flags.slug;
	if (!workspaceSlug) {
		console.error(
			"Usage: bae channel add <workspace-slug> --platform telegram [--label 'My Bot']",
		);
		process.exit(1);
	}

	const ws = store.getWorkspace(workspaceSlug);
	if (!ws) {
		console.error(`Workspace "${workspaceSlug}" not found.`);
		process.exit(1);
	}

	const platform = (flags.platform ?? "telegram") as Platform;

	// Prompt for platform-specific credentials
	const creds = await promptCredentials(platform);

	// Validate credentials against platform API
	await validateCredentials(platform, creds);

	// Check for duplicate bot token across all channels
	await checkDuplicateCredentials(platform, creds, store);

	// Prompt for allowed users (required)
	const userIdHints: Record<string, string> = {
		telegram: "To find your Telegram user ID, message @userinfobot",
		slack: "To find your Slack user ID: profile → ⋯ menu → Copy member ID",
		imessage: "Use your phone number (+1234567890) or Apple ID email address",
	};
	p.log.info(userIdHints[platform] ?? "Enter allowed user IDs");

	const userIdErrors: Record<string, string> = {
		telegram: "Telegram user IDs must be numeric",
		slack: "Slack user IDs must start with U or W (e.g. U0123ABCDE)",
		imessage:
			"iMessage user IDs must be phone numbers (+1234567890) or email addresses",
	};

	const userIds = await p.text({
		message: "Allowed user ID(s) (comma-separated):",
		validate: (val) => {
			if (!val) return "At least one user ID is required";
			const ids = val.split(",").map((s) => s.trim());
			if (!ids.every((id) => validateUserId(id, platform)))
				return userIdErrors[platform] ?? "Invalid user ID format";
		},
	});

	if (p.isCancel(userIds)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const allowedUsers = userIds
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const label = flags.label ?? `${workspaceSlug} on ${platform}`;

	try {
		const channel = store.createChannel({
			workspaceId: workspaceSlug,
			platform,
			label,
			allowedUsers,
		});

		// Write credentials to file after DB record succeeds
		writeChannelCredentials(channel.id, creds);

		console.log(`Channel ${channel.id} created (${label})`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("UNIQUE")) {
			console.error(
				`Workspace "${workspaceSlug}" already has a ${platform} channel.`,
			);
		} else {
			console.error(`Failed to create channel: ${msg}`);
		}
		process.exit(1);
	}
}

async function removeChannel(args: string[], store: Store): Promise<void> {
	const channelId = args.find((a) => !a.startsWith("-"));
	const force = args.includes("--force") || args.includes("-f");

	if (!channelId) {
		console.error("Usage: bae channel remove <channel-id> [--force]");
		process.exit(1);
	}

	const channel = store.getChannel(channelId);
	if (!channel) {
		console.error(`Channel "${channelId}" not found.`);
		process.exit(1);
	}

	checkNotRunning();

	if (!force) {
		const confirm = await p.confirm({
			message: `Delete channel "${channel.label ?? channelId}" (${channel.platform})?`,
		});
		if (p.isCancel(confirm) || !confirm) {
			console.log("Cancelled.");
			return;
		}
	}

	// Delete credential file BEFORE DB record
	deleteChannelCredentials(channelId);
	store.deleteChannel(channelId);
	console.log(`Channel "${channelId}" deleted.`);
}

/**
 * Check if the same bot token is already used by another channel.
 * Prevents accidentally binding the same bot (e.g., Amy) to two workspaces.
 */
async function checkDuplicateCredentials(
	platform: Platform,
	creds: Record<string, string>,
	store: Store,
): Promise<void> {
	// Determine which credential key identifies the bot/app for this platform
	const tokenKey =
		platform === "telegram"
			? "TELEGRAM_BOT_TOKEN"
			: platform === "slack"
				? "SLACK_BOT_TOKEN"
				: null;
	if (!tokenKey) return;

	const newToken = creds[tokenKey];
	if (!newToken) return;

	const allChannels = store.listChannels();
	for (const ch of allChannels) {
		if (ch.platform !== platform) continue;
		const existingCreds = readChannelCredentials(ch.id);
		if (existingCreds[tokenKey] === newToken) {
			console.error(
				`This token is already used by channel "${ch.label ?? ch.id}" (workspace: ${ch.workspaceId}).`,
			);
			console.error(`Each ${platform} app can only be bound to one workspace.`);
			process.exit(1);
		}
	}
}

async function promptCredentials(
	platform: Platform,
): Promise<Record<string, string>> {
	switch (platform) {
		case "telegram": {
			p.log.info(
				"To create a Telegram bot:\n" +
					"  1. Open Telegram and message @BotFather\n" +
					"  2. Send /newbot and follow the prompts\n" +
					"  3. Copy the bot token",
			);
			const token = await p.text({
				message: "Bot token:",
				placeholder: "123456:ABC-DEF...",
				validate: (val) => {
					if (!val || !val.includes(":"))
						return "Invalid token format (expected id:secret)";
				},
			});
			if (p.isCancel(token)) {
				p.cancel("Cancelled.");
				process.exit(0);
			}
			return { TELEGRAM_BOT_TOKEN: token };
		}
		case "slack": {
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
				p.cancel("Cancelled.");
				process.exit(0);
			}
			const appToken = await p.text({
				message: "App-Level token (xapp-...):",
				validate: (val) => {
					if (!val?.startsWith("xapp-")) return "Must start with xapp-";
				},
			});
			if (p.isCancel(appToken)) {
				p.cancel("Cancelled.");
				process.exit(0);
			}
			return { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken };
		}
		case "imessage": {
			if (process.platform !== "darwin") {
				console.error("iMessage local mode is only available on macOS.");
				process.exit(1);
			}
			p.log.info(
				"iMessage local mode reads from your Mac's Messages database.\n" +
					"Requirements:\n" +
					"  1. macOS with iMessage signed in\n" +
					"  2. Full Disk Access for your terminal (System Settings → Privacy & Security)\n" +
					"  3. Automation permission for Messages.app (granted on first send)",
			);
			p.log.warn(
				"Note: Full Disk Access grants read access to ALL your messages, not just conversations with this channel.",
			);
			// No credentials needed for local mode
			return {};
		}
	}
}

async function validateCredentials(
	platform: Platform,
	creds: Record<string, string>,
): Promise<void> {
	switch (platform) {
		case "telegram": {
			const token = creds.TELEGRAM_BOT_TOKEN;
			if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
			try {
				const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
				if (!res.ok) {
					console.error("Invalid Telegram bot token.");
					process.exit(1);
				}
				const data = (await res.json()) as {
					ok: boolean;
					result?: { username: string };
				};
				if (data.ok && data.result) {
					p.log.success(`Connected as @${data.result.username}`);
				}
			} catch {
				console.error("Failed to validate token: network error.");
				process.exit(1);
			}
			break;
		}
		case "slack": {
			const token = creds.SLACK_BOT_TOKEN;
			if (!token) throw new Error("Missing SLACK_BOT_TOKEN");
			try {
				const { WebClient } = await import("@slack/web-api");
				const web = new WebClient(token);
				const result = await web.auth.test();
				if (result.ok) {
					p.log.success(`Connected to ${result.team}`);
				}
			} catch {
				console.error("Invalid Slack bot token.");
				process.exit(1);
			}
			break;
		}
		case "imessage": {
			// Validate macOS and chat.db access
			if (process.platform !== "darwin") {
				console.error("iMessage requires macOS.");
				process.exit(1);
			}
			try {
				const { accessSync, constants } = await import("node:fs");
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				accessSync(join(homedir(), "Library/Messages/chat.db"), constants.R_OK);
				p.log.success("Messages database accessible");
			} catch {
				console.error(
					"Cannot read Messages database. Full Disk Access is required.",
				);
				// Open System Settings directly to the Full Disk Access page
				try {
					const { execSync } = await import("node:child_process");
					console.log("Opening System Settings → Full Disk Access...");
					execSync(
						"open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'",
					);
					console.log(
						"Add your terminal app, then restart the terminal and try again.",
					);
				} catch {
					console.log(
						"Open manually: System Settings → Privacy & Security → Full Disk Access",
					);
				}
				process.exit(1);
			}
			break;
		}
	}
}

function validateUserId(id: string, platform: Platform): boolean {
	switch (platform) {
		case "telegram":
			return /^\d+$/.test(id);
		case "slack":
			return /^[UW][A-Z0-9]+$/.test(id);
		case "imessage":
			// Phone numbers (+1234567890) or email addresses
			return /^\+\d+$/.test(id) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
	}
}

function checkNotRunning(): void {
	const { existsSync, readFileSync } = require("node:fs");
	const { join } = require("node:path");
	const { homedir } = require("node:os");
	const pidFile = join(homedir(), ".bae", "bae.pid");
	if (!existsSync(pidFile)) return;
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
		// Not running
	}
}
