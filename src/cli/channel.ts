import * as p from "@clack/prompts";
import {
	deleteChannelCredentials,
	readChannelCredentials,
	writeChannelCredentials,
} from "../credentials.ts";
import type { Store } from "../session/store.ts";
import type { Platform } from "../session/types.ts";
import {
	isBaeRunning,
	restartIfRunning,
	startIfNotRunning,
} from "./restart.ts";

export interface ChannelCommandOptions {
	/** Skip auto-restart (caller will handle it). */
	skipRestart?: boolean;
}

async function handlePostChange(): Promise<void> {
	if (isBaeRunning()) {
		restartIfRunning();
	} else {
		const shouldStart = await p.confirm({
			message: "Start Bae now?",
			initialValue: true,
		});
		if (!p.isCancel(shouldStart) && shouldStart) {
			startIfNotRunning();
		} else {
			p.log.info("Run `bae start -d` when you're ready.");
		}
	}
}

export async function channelCommand(
	args: string[],
	store: Store,
	options?: ChannelCommandOptions,
): Promise<void> {
	const sub = args[0];
	const shouldRestart = !options?.skipRestart;

	switch (sub) {
		case "list":
			return listChannels(args.slice(1), store);
		case "add":
			await addChannel(args.slice(1), store);
			if (shouldRestart) await handlePostChange();
			return;
		case "remove":
			await removeChannel(args.slice(1), store);
			if (shouldRestart) await handlePostChange();
			return;
		case "help":
		case "--help":
		case "-h":
		case undefined:
			console.log(`
  bae channel — Manage channels

  Commands:
    list                    List all channels (grouped by workspace)
    add [workspace-slug]    Add a channel (interactive if no flags)
    remove <channel-id>     Remove a channel

  Options (add):
    --platform <name>    Platform: telegram, slack, imessage, wechat, email
    --label <text>       Display label for the channel

  Options (list):
    --workspace <slug>   Filter channels by workspace

  Examples:
    bae channel add research --platform telegram
    bae channel add                                (interactive)
    bae channel list
    bae channel remove chan_abc123
`);
			break;
		default:
			console.error(
				`Unknown channel command: ${sub}\nRun \`bae channel --help\` for usage.`,
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

	// Group channels by workspace
	const grouped = new Map<string, typeof channels>();
	for (const ch of channels) {
		const key = ch.workspaceId;
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key)?.push(ch);
	}

	console.log("\nChannels:\n");
	for (const [wsId, wsChannels] of grouped) {
		console.log(`  Workspace: ${wsId}`);
		for (const ch of wsChannels) {
			const platWidth = 10;
			const users = ch.allowedUsers.join(", ");
			console.log(
				`    ${ch.platform.padEnd(platWidth)}${ch.id}  users: ${users}`,
			);
		}
		console.log();
	}
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

	let workspaceSlug = flags.slug;
	if (!workspaceSlug) {
		const workspaces = store.listWorkspaces();
		if (workspaces.length === 0) {
			console.error(
				"No workspaces configured.\n\n" +
					"  Create one first:  bae workspace add\n" +
					"  Or run:            bae init\n",
			);
			process.exit(1);
		}

		// Always show selector — pre-select cwd match if found
		const { detectCurrentWorkspace } = await import("./context.ts");
		const currentWs = detectCurrentWorkspace(store);

		// Sort so cwd-matching workspace is first (default selection)
		const sorted = currentWs
			? [currentWs, ...workspaces.filter((ws) => ws.id !== currentWs.id)]
			: workspaces;

		const wsChoice = await p.select({
			message: "Add channel to:",
			options: sorted.map((ws) => ({
				value: ws.id,
				label:
					ws.id === currentWs?.id
						? `${ws.id} (${ws.path}) ← this folder`
						: `${ws.id} (${ws.path})`,
			})),
		});
		if (p.isCancel(wsChoice)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}
		workspaceSlug = wsChoice as string;
	}

	const ws = store.getWorkspace(workspaceSlug);
	if (!ws) {
		console.error(`Workspace "${workspaceSlug}" not found.`);
		process.exit(1);
	}

	let platform: Platform;
	const VALID_PLATFORMS = new Set([
		"telegram",
		"slack",
		"imessage",
		"wechat",
		"email",
	]);
	if (flags.platform) {
		if (!VALID_PLATFORMS.has(flags.platform)) {
			console.error(
				`Unsupported platform: "${flags.platform}"\nAvailable: telegram, slack, imessage, wechat, email`,
			);
			process.exit(1);
		}
		platform = flags.platform as Platform;
	} else {
		// Filter out platforms already added to this workspace
		const existingChannels = store.getChannelsByWorkspace(workspaceSlug);
		const existingPlatforms = new Set<string>(
			existingChannels.map((ch) => ch.platform),
		);

		const allPlatforms: { value: string; label: string }[] = [
			{ value: "telegram", label: "Telegram" },
			{ value: "slack", label: "Slack" },
		];
		allPlatforms.push({ value: "wechat", label: "WeChat" });
		allPlatforms.push({ value: "email", label: "Email (AgentMail)" });
		if (process.platform === "darwin") {
			allPlatforms.push({
				value: "imessage",
				label: "iMessage (macOS only)",
			});
		}

		const platformOptions = allPlatforms.filter(
			(p) => !existingPlatforms.has(p.value),
		);

		if (platformOptions.length === 0) {
			console.log(
				"All available platforms are already configured for this workspace.",
			);
			return;
		}

		const platChoice = await p.select({
			message: "Platform:",
			options: platformOptions,
		});
		if (p.isCancel(platChoice)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}
		platform = platChoice as Platform;
	}

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
			const manifestObj = {
				display_information: {
					name: "Bae",
					description: "Bridge to your local coding agent",
				},
				features: {
					bot_user: { display_name: "Bae", always_online: true },
					slash_commands: [
						{ command: "/new", description: "Start a new session" },
					],
				},
				oauth_config: {
					scopes: {
						bot: [
							"chat:write",
							"im:history",
							"im:read",
							"im:write",
							"commands",
						],
					},
				},
				settings: {
					event_subscriptions: { bot_events: ["message.im"] },
					socket_mode_enabled: true,
				},
			};
			const manifest = JSON.stringify(manifestObj, null, 2);

			// Try to copy manifest to clipboard, fallback to temp file
			let copied = false;
			let manifestPath = "";
			try {
				const { execSync: exec } = await import("node:child_process");
				if (process.platform === "darwin") {
					exec("pbcopy", { input: manifest });
					copied = true;
				} else if (process.platform === "win32") {
					exec("clip", { input: manifest });
					copied = true;
				} else {
					exec("xclip -selection clipboard", { input: manifest });
					copied = true;
				}
			} catch {
				// Clipboard not available — write to temp file instead
				try {
					const { writeFileSync: writeFile } = await import("node:fs");
					const { join: joinPath } = await import("node:path");
					const { tmpdir } = await import("node:os");
					manifestPath = joinPath(tmpdir(), "bae-slack-manifest.json");
					writeFile(manifestPath, manifest);
				} catch {
					// Can't write temp file either — user will have to copy from screen
				}
			}

			if (copied) {
				p.log.info(
					"To create a Slack app:\n" +
						"  1. Go to https://api.slack.com/apps → Create New App → From a manifest\n" +
						"  2. Switch to JSON tab and paste (already in your clipboard!)",
				);
			} else if (manifestPath) {
				p.log.info(
					"To create a Slack app:\n" +
						"  1. Go to https://api.slack.com/apps → Create New App → From a manifest\n" +
						`  2. Switch to JSON tab and paste the contents of:\n     ${manifestPath}`,
				);
			} else {
				p.log.info(
					"To create a Slack app:\n" +
						"  1. Go to https://api.slack.com/apps → Create New App → From a manifest\n" +
						"  2. Switch to JSON tab and paste this manifest:",
				);
				p.note(manifest, "Slack App Manifest");
			}

			const created = await p.confirm({
				message:
					"Have you created the Slack app and installed it to your workspace?",
			});
			if (p.isCancel(created) || !created) {
				p.cancel("Cancelled. Create the app first, then try again.");
				process.exit(0);
			}

			// Step 1: App-Level Token
			p.log.info(
				"In your Slack app settings:\n" +
					"  Go to Basic Information → App-Level Tokens → Generate Token\n" +
					"  Name it anything, add the connections:write scope, then copy it.",
			);
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

			// Step 2: Bot OAuth Token
			p.log.info(
				"Now go to Install App (in the sidebar) and copy the Bot User OAuth Token.",
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
			// No API tokens needed — write a marker so startup doesn't skip this channel
			return { BAE_LOCAL_MODE: "true" };
		}
		case "wechat": {
			const { loginWithQr, DEFAULT_BASE_URL } = await import(
				"../platform/wechat/auth.ts"
			);
			p.log.info(
				"WeChat login requires scanning a QR code with your WeChat app.\n" +
					"The QR code will appear in your terminal. If it doesn't render correctly,\n" +
					"a URL fallback will be printed.",
			);
			const result = await loginWithQr(DEFAULT_BASE_URL);
			p.log.success("Connected to WeChat!");
			return {
				WECHAT_BOT_TOKEN: result.token,
				WECHAT_BASE_URL: result.baseUrl,
			};
		}
		case "email": {
			p.log.info(
				"Email uses AgentMail for inbox management.\n" +
					"  1. Get an API key at https://agentmail.to\n" +
					"  2. Create an inbox (or provide an existing inbox ID)",
			);
			const apiKey = await p.text({
				message: "AgentMail API key:",
				validate: (val) => {
					if (!val?.trim()) return "API key is required";
				},
			});
			if (p.isCancel(apiKey)) {
				p.cancel("Cancelled.");
				process.exit(0);
			}
			const inboxId = await p.text({
				message: "Inbox ID (leave blank to auto-create):",
			});
			if (p.isCancel(inboxId)) {
				p.cancel("Cancelled.");
				process.exit(0);
			}
			return {
				AGENTMAIL_API_KEY: apiKey,
				...(inboxId ? { AGENTMAIL_INBOX_ID: inboxId } : {}),
			};
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
		case "wechat": {
			const token = creds.WECHAT_BOT_TOKEN;
			if (!token) throw new Error("Missing WECHAT_BOT_TOKEN");
			try {
				const { getUpdates } = await import("../platform/wechat/api.ts");
				const baseUrl =
					creds.WECHAT_BASE_URL ?? "https://ilinkai.weixin.qq.com";
				await getUpdates({ baseUrl, token }, "");
				p.log.success("WeChat connection verified");
			} catch {
				console.error("Failed to validate WeChat credentials.");
				process.exit(1);
			}
			break;
		}
		case "email": {
			const apiKey = creds.AGENTMAIL_API_KEY;
			if (!apiKey) throw new Error("Missing AGENTMAIL_API_KEY");
			// Basic validation — full validation happens at channel start
			p.log.success("AgentMail credentials saved");
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
		case "wechat":
			// WeChat user IDs: hex string @im.wechat
			return /^[a-f0-9]+@im\.wechat$/i.test(id);
		case "email":
			// Email addresses
			return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
	}
}
