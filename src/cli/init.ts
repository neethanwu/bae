import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { writeChannelCredentials } from "../credentials.ts";
import { Store } from "../session/store.ts";
import type { Platform } from "../session/types.ts";
import { detectCurrentWorkspace } from "./context.ts";
import { parseEnvFile } from "./env.ts";
import { restartIfRunning, startIfNotRunning } from "./restart.ts";
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

function writeGlobalConfig(port: string): void {
	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(ENV_FILE, `BAE_PORT=${port}\n`, { mode: 0o600 });
}

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

	let ws = store.getWorkspace(slug);
	if (!ws) {
		ws = store.createWorkspace({ id: slug, name: slug, path: expanded });
	}

	const existingChannels = store.getChannelsByWorkspace(slug);
	const existingChannel = existingChannels.find(
		(ch) => ch.platform === platform,
	);

	if (existingChannel) {
		writeChannelCredentials(existingChannel.id, credentials);
		return { slug, channelId: existingChannel.id };
	}

	const channel = store.createChannel({
		workspaceId: slug,
		platform,
		label: `${slug} on ${platform}`,
		allowedUsers,
	});

	writeChannelCredentials(channel.id, credentials);
	return { slug, channelId: channel.id };
}

// ── Interactive credential + user ID collection ─────────────────────────

async function collectCredentials(
	platform: Platform,
	opts?: { store?: Store; workspaceSlug?: string },
): Promise<{
	credentials: Record<string, string>;
	displayName: string;
}> {
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
					bot: ["chat:write", "im:history", "im:read", "im:write", "commands"],
				},
			},
			settings: {
				event_subscriptions: { bot_events: ["message.im"] },
				socket_mode_enabled: true,
			},
		};
		const manifest = JSON.stringify(manifestObj, null, 2);

		let copied = false;
		let manifestPath = "";
		try {
			if (process.platform === "darwin") {
				execSync("pbcopy", { input: manifest });
				copied = true;
			} else if (process.platform === "win32") {
				execSync("clip", { input: manifest });
				copied = true;
			} else {
				execSync("xclip -selection clipboard", { input: manifest });
				copied = true;
			}
		} catch {
			try {
				const { writeFileSync: writeFile } = await import("node:fs");
				const { tmpdir } = await import("node:os");
				manifestPath = join(tmpdir(), "bae-slack-manifest.json");
				writeFile(manifestPath, manifest);
			} catch {
				// Can't write temp file either
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
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

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
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

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
	} else if (platform === "wechat") {
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
		credentials = {
			WECHAT_BOT_TOKEN: result.token,
			WECHAT_BASE_URL: result.baseUrl,
		};
		displayName = "WeChat";
	} else if (platform === "email") {
		const { resolveApiKey, resolveInbox } = await import(
			"./email-onboarding.ts"
		);
		const store = opts?.store;
		if (!store) {
			p.log.error("Internal error: store is required for email setup.");
			process.exit(1);
		}
		const apiKey = await resolveApiKey(store);
		const { createClient } = await import("../platform/email/api.ts");
		const client = createClient(apiKey);
		const slug = opts?.workspaceSlug ?? "agent";
		const result = await resolveInbox(client, store, apiKey, slug);
		credentials = {
			AGENTMAIL_API_KEY: apiKey,
			AGENTMAIL_INBOX_ID: result.inboxId,
			AGENTMAIL_WORKSPACE_SLUG: slug,
		};
		displayName = result.email;
	}

	return { credentials, displayName };
}

async function collectUserIds(platform: Platform): Promise<string[]> {
	const hints: Record<string, string> = {
		telegram:
			"To find your Telegram user ID, message @userinfobot on Telegram.",
		slack: "To find your Slack user ID: profile → ⋯ menu → Copy member ID",
		wechat:
			"Your WeChat user ID was shown during QR login (e.g. abc123@im.wechat).",
		email: "Enter the email address(es) allowed to message this channel.",
	};
	p.log.info(hints[platform] ?? "Enter your user ID for this platform.");

	const placeholders: Record<string, string> = {
		telegram: "123456789 (comma-separated for multiple)",
		slack: "U0123ABCDE (comma-separated for multiple)",
		wechat: "abc123@im.wechat",
		email: "user@example.com (comma-separated for multiple)",
	};

	const userIds = await p.text({
		message: "Your user ID(s):",
		placeholder: placeholders[platform] ?? "",
		validate: (val) => {
			if (!val) return "At least one user ID is required";
			const ids = val.split(",").map((s) => s.trim());
			if (platform === "telegram" && ids.some((id) => !/^\d+$/.test(id)))
				return "Telegram user IDs must be numeric";
			if (platform === "slack" && ids.some((id) => !/^[UW][A-Z0-9]+$/.test(id)))
				return "Slack user IDs must start with U or W";
			if (
				platform === "wechat" &&
				ids.some((id) => !/^[a-f0-9]+@im\.wechat$/i.test(id))
			)
				return "WeChat user IDs must end with @im.wechat";
			if (
				platform === "email" &&
				ids.some((id) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id))
			)
				return "Email user IDs must be valid email addresses";
		},
	});

	if (p.isCancel(userIds)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	const allowed = userIds
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	if (allowed.length === 0) {
		p.log.error("At least one user ID is required for security.");
		process.exit(1);
	}

	return allowed;
}

function selectPlatformOptions(): { value: string; label: string }[] {
	return [
		{ value: "telegram", label: "Telegram" },
		{ value: "slack", label: "Slack" },
		{ value: "wechat", label: "WeChat" },
		{ value: "email", label: "Email (AgentMail)" },
	];
}

// ── Full setup flow (workspace-first) ───────────────────────────────────

async function fullSetupFlow(
	store: Store,
	options?: { defaultPath?: string },
): Promise<void> {
	const existing = parseEnvFile(ENV_FILE);

	// 1. Detect agent
	const agentInfo = detectAgent();
	if (agentInfo) {
		p.log.success(`${agentInfo.name} found (${agentInfo.version})`);
		const authOk = verifyAgentAuth();
		if (authOk) {
			p.log.success("Claude Code authenticated");
		} else {
			p.log.error(
				"Claude Code is not authenticated. Bae won't be able to respond to messages.\n" +
					"  Run this in your terminal:\n\n" +
					"    claude auth login\n\n" +
					"  Then run `bae init` again.",
			);
			process.exit(1);
		}
	} else {
		p.log.warn(
			"No agent CLI found. Install one first (e.g. npm install -g @anthropic-ai/claude-code)",
		);
	}

	// 2. Workspace directory — skip prompt if path already known from selection
	let workspace: string;
	if (options?.defaultPath) {
		workspace = options.defaultPath;
		p.log.step(`Workspace directory: ${workspace}`);
	} else {
		const defaultCwd = process.cwd();
		const input = await p.text({
			message: "Workspace directory (where the agent works):",
			defaultValue: defaultCwd,
			placeholder: defaultCwd,
		});
		if (p.isCancel(input)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}
		workspace = input;
	}

	// 3. Workspace slug
	const defaultSlug = slugFromPath(
		workspace.startsWith("~/")
			? resolve(homedir(), workspace.slice(2))
			: resolve(workspace),
	);
	const slug = await p.text({
		message: "Workspace slug (short name):",
		defaultValue: defaultSlug,
		placeholder: defaultSlug,
		validate: (val) => {
			const v = val || defaultSlug;
			if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(v))
				return "Must be lowercase alphanumeric with hyphens, 1-32 chars";
		},
	});
	if (p.isCancel(slug)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	// 4. Platform
	const platformChoice = await p.select({
		message: "Platform:",
		options: selectPlatformOptions(),
	});
	if (p.isCancel(platformChoice)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}
	const platform = platformChoice as Platform;

	// 5. Credentials
	const { credentials, displayName } = await collectCredentials(platform, {
		store,
		workspaceSlug: slug,
	});

	// 6. User IDs
	const allowedUsers = await collectUserIds(platform);

	// 7. Write config + create workspace + channel
	const port = existing.BAE_PORT || "19456";
	writeGlobalConfig(port);

	const result = await setupWorkspaceAndChannel({
		store,
		workspacePath: workspace,
		credentials,
		allowedUsers,
		platform,
	});

	const channelSummaries: string[] = [`${displayName} (${platform})`];

	// 8. Offer to add more channels
	let addMore = true;
	while (addMore) {
		const addAnother = await p.confirm({
			message: "Add another channel to this workspace?",
			initialValue: false,
		});
		if (p.isCancel(addAnother) || !addAnother) {
			addMore = false;
			break;
		}

		const { channelCommand } = await import("./channel.ts");
		await channelCommand(["add", result.slug], store, { skipRestart: true });
		channelSummaries.push("(added via channel add)");
	}

	const accessLabel = `${allowedUsers.length} authorized user${allowedUsers.length > 1 ? "s" : ""}`;

	p.note(
		[
			`Channel(s): ${channelSummaries.join(", ")}`,
			`Workspace:  ${workspace} (${slug})`,
			`Access:     ${accessLabel}`,
		].join("\n"),
		"You're all set!",
	);
}

// ── Manage workspace submenu ────────────────────────────────────────────

async function manageWorkspace(
	store: Store,
	workspaceId: string,
): Promise<boolean> {
	const channels = store.getChannelsByWorkspace(workspaceId);
	const allPlatforms = ["telegram", "slack", "wechat", "email"];
	const usedPlatforms = new Set<string>(channels.map((ch) => ch.platform));
	const hasAvailable = allPlatforms.some((pl) => !usedPlatforms.has(pl));

	const options: { value: string; label: string }[] = [];
	if (hasAvailable) {
		options.push({ value: "add-channel", label: "Add a channel" });
	} else {
		options.push({
			value: "add-channel",
			label: "Add a channel (all platforms configured)",
		});
	}
	options.push(
		{ value: "reconfigure", label: "Reconfigure from scratch" },
		{ value: "exit", label: "I'm all set" },
	);

	const action = await p.select({
		message: `What would you like to do with "${workspaceId}"?`,
		options,
	});

	if (p.isCancel(action) || action === "exit") {
		return false;
	}

	if (action === "add-channel") {
		const { channelCommand } = await import("./channel.ts");
		await channelCommand(["add", workspaceId], store, { skipRestart: true });
		return true;
	}

	if (action === "reconfigure") {
		const ws = store.getWorkspace(workspaceId);
		await fullSetupFlow(store, { defaultPath: ws?.path });
		return true;
	}

	return false;
}

// ── Main entry point ────────────────────────────────────────────────────

export async function runInit(argv: string[] = []): Promise<void> {
	const flags = parseFlags(argv);
	const existing = parseEnvFile(ENV_FILE);

	const store = new Store();
	await store.waitReady();

	try {
		// Headless mode — unchanged
		if (flags.token && flags["allowed-users"]) {
			const platform = (flags.platform ?? "telegram") as Platform;
			const workspace = flags.workspace || join(homedir(), "baesment");
			const port = existing.BAE_PORT || "19456";
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
				credentials = {
					SLACK_BOT_TOKEN: botToken,
					SLACK_APP_TOKEN: appToken,
				};
				displayName = "Slack";
			} else if (platform === "email") {
				const apiKey = flags.token;
				if (!apiKey) {
					console.error("AgentMail API key is required (--token)");
					process.exit(1);
				}
				const inboxIdFlag = flags["inbox-id"];
				if (!inboxIdFlag) {
					console.error("Inbox ID is required for email (--inbox-id)");
					process.exit(1);
				}
				const { validateApiKey } = await import("../platform/email/api.ts");
				const result = await validateApiKey(apiKey);
				if (!result.valid) {
					console.error("Invalid AgentMail API key.");
					process.exit(1);
				}
				const wsSlug = flags.workspace
					? slugFromPath(
							resolve(
								flags.workspace.startsWith("~/")
									? resolve(homedir(), flags.workspace.slice(2))
									: flags.workspace,
							),
						)
					: "agent";
				credentials = {
					AGENTMAIL_API_KEY: apiKey,
					AGENTMAIL_INBOX_ID: inboxIdFlag,
					AGENTMAIL_WORKSPACE_SLUG: wsSlug,
				};
				displayName = "Email";
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
			const restarted = restartIfRunning();
			if (!restarted) startIfNotRunning();
			return;
		}

		// ── Interactive mode ────────────────────────────────────────────

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
		const currentWorkspace = detectCurrentWorkspace(store);
		let madeChanges = false;

		if (workspaces.length === 0) {
			// ── Case A: No workspaces → full first-time setup ────────
			await fullSetupFlow(store);
			madeChanges = true;
		} else if (currentWorkspace) {
			// ── Case B: cwd IS a workspace → manage or new ──────────
			const channels = store.getChannelsByWorkspace(currentWorkspace.id);
			const channelList =
				channels.length > 0
					? channels.map((ch) => ch.platform).join(", ")
					: "no channels";

			const action = await p.select({
				message: `This folder is workspace "${currentWorkspace.id}" (${channelList}). What would you like to do?`,
				options: [
					{
						value: "manage",
						label: "Manage this workspace",
					},
					{
						value: "new",
						label: "Set up a new workspace",
					},
					{ value: "exit", label: "I'm all set" },
				],
			});

			if (p.isCancel(action) || action === "exit") {
				p.outro("Run `bae start -d` to begin.");
				return;
			}

			if (action === "manage") {
				madeChanges = await manageWorkspace(store, currentWorkspace.id);
			} else {
				await fullSetupFlow(store);
				madeChanges = true;
			}
		} else {
			// ── Case C: cwd is NOT a workspace, others exist ────────
			const cwd = process.cwd();

			const action = await p.select({
				message: `You're in ${cwd} (not a workspace). What would you like to do?`,
				options: [
					{
						value: "new",
						label: `Set up this folder as a new workspace (${cwd})`,
					},
					{
						value: "manage",
						label: "Manage an existing workspace",
					},
					{ value: "exit", label: "I'm all set" },
				],
			});

			if (p.isCancel(action) || action === "exit") {
				p.outro("Run `bae start -d` to begin.");
				return;
			}

			if (action === "new") {
				await fullSetupFlow(store, { defaultPath: cwd });
				madeChanges = true;
			} else {
				// Always show workspace selector
				const wsChoice = await p.select({
					message: "Select workspace:",
					options: workspaces.map((ws) => ({
						value: ws.id,
						label: `${ws.id} (${ws.path})`,
					})),
				});
				if (p.isCancel(wsChoice)) {
					p.outro("Run `bae start -d` to begin.");
					return;
				}
				madeChanges = await manageWorkspace(store, wsChoice as string);
			}
		}

		const { isBaeRunning } = await import("./restart.ts");
		const running = isBaeRunning();

		if (running && madeChanges) {
			// Running + changes → auto-restart
			restartIfRunning();
		} else if (!running) {
			// Not running → ask to start
			const shouldStart = await p.confirm({
				message: "Start Bae now?",
				initialValue: true,
			});
			if (!p.isCancel(shouldStart) && shouldStart) {
				startIfNotRunning();
			} else {
				p.outro("Run `bae start -d` when you're ready.");
			}
		}
		// Running + no changes → done silently
	} finally {
		store.close();
	}
}

// ── Helper functions (unchanged) ────────────────────────────────────────

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

function verifyAgentAuth(): boolean {
	try {
		const out = execSync("claude auth status", {
			stdio: "pipe",
			timeout: 5000,
			encoding: "utf-8",
		});
		const status = JSON.parse(out) as { loggedIn?: boolean };
		return status.loggedIn === true;
	} catch {
		return false;
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
