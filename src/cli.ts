import { spawn as cpSpawn, execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "./cli/env.ts";
import {
	detectSupervisor,
	isProcessAlive,
	readPidFile,
} from "./cli/supervisor.ts";
import {
	autoUpdate,
	checkForUpdates,
	scheduleAutoUpdate,
} from "./cli/update-check.ts";

const BAE_DIR = join(homedir(), ".bae");
const PID_FILE = join(BAE_DIR, "bae.pid");
const ENV_FILE = join(BAE_DIR, ".env");
const LOG_FILE = join(BAE_DIR, "bae.log");
declare const __VERSION__: string;
// __VERSION__ is injected by tsup at build time. When running from source
// (bun src/cli.ts), fall back to reading package.json.
const IS_BUILT = typeof __VERSION__ !== "undefined";
const VERSION = IS_BUILT
	? __VERSION__
	: (() => {
			try {
				const pkg = JSON.parse(
					readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"),
				);
				return pkg.version ?? "0.0.0";
			} catch {
				return "0.0.0";
			}
		})();

const args = process.argv.slice(2);
const command = args[0];

// Update check only on long-running commands (start) or status.
// Short commands (--help, --version, stop) should not hold the process open.
if (command === "start" || command === "status") {
	checkForUpdates(VERSION);
}

switch (command) {
	case "start":
		await start();
		break;
	case "stop":
		stop();
		break;
	case "status":
		await status();
		break;
	case "logs":
		logs();
		break;
	case "init":
		await init();
		break;
	case "workspace":
		await workspace();
		break;
	case "channel":
		await channel();
		break;
	case "upgrade":
		await upgrade();
		break;
	case "--version":
	case "-v":
		console.log(`bae ${VERSION}`);
		break;
	case "--help":
	case "-h":
	case undefined:
		printHelp();
		break;
	default:
		console.error(`Unknown command: ${command}`);
		printHelp();
		process.exit(1);
}

function printHelp() {
	console.log(`
  bae — Bridge your messaging apps to CLI coding agents

  Usage:
    bae init                      Guided setup wizard (start here!)
    bae start -d                  Start Bae in the background (recommended)
    bae start                     Start Bae in the foreground
    bae start --port 8080         Use a custom port (default: 19456)
    bae stop                      Stop running Bae instance
    bae status                    Show running/stopped

    bae workspace list            List workspaces
    bae workspace add <slug>      Add a workspace
    bae workspace remove <slug>   Remove a workspace
    bae workspace set-executor    Change workspace executor

    bae channel list              List channels
    bae channel add <workspace>   Add a channel to a workspace
    bae channel remove <id>       Remove a channel

    bae upgrade                   Update to latest version
    bae logs                      Tail daemon log file

  Options:
    --version        Show version
    --help           Show this message
`);
}

function logs() {
	if (!existsSync(LOG_FILE)) {
		console.log("No log file found. Start Bae with -d first.");
		process.exit(1);
	}
	const tail = cpSpawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
	process.on("SIGINT", () => tail.kill());
}

function enableTimestampedLogs() {
	const origLog = console.log;
	const origErr = console.error;
	const origWarn = console.warn;
	const ts = () => new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
	console.log = (...a: unknown[]) => origLog(`[${ts()}]`, ...a);
	console.error = (...a: unknown[]) => origErr(`[${ts()}]`, ...a);
	console.warn = (...a: unknown[]) => origWarn(`[${ts()}]`, ...a);
}

async function start() {
	const startArgs = args.slice(1);
	const flags = new Set(startArgs);
	const daemon = flags.has("-d") || flags.has("--daemon");
	const isDaemonChild = flags.has("--_daemon-child");
	const isSupervised = flags.has("--_supervised");

	// Parse --port <number> from args
	const portFlagIdx = startArgs.indexOf("--port");
	const cliPort =
		portFlagIdx !== -1
			? Number.parseInt(startArgs[portFlagIdx + 1] ?? "", 10)
			: undefined;

	enableTimestampedLogs();

	// Check for existing instance (skip when launched by supervisor)
	if (!isSupervised && !isDaemonChild) {
		const supervisor = detectSupervisor(IS_BUILT);
		if (supervisor.type !== "spawn" && supervisor.isRunning()) {
			console.error("Bae is already running (managed by %s).", supervisor.type);
			process.exit(1);
		}
		const existing = readPidFile();
		if (existing !== null && isProcessAlive(existing.pid)) {
			console.error(`Bae is already running (PID ${existing.pid}).`);
			process.exit(1);
		}
		if (existing !== null) {
			unlinkSync(PID_FILE);
		}
	}

	// Load global config (BAE_PORT only)
	loadEnvFile(ENV_FILE);

	const port = cliPort || Number(process.env.BAE_PORT) || 19456;

	if (cliPort) {
		process.env.BAE_PORT = String(cliPort);
	}

	// Auto-update before booting (parent only — daemon child/supervised uses updated code)
	if (!isDaemonChild && !isSupervised) {
		console.log("[bae] Checking for updates...");
		await autoUpdate(VERSION);
	}

	// Check agent binary exists
	console.log("[bae] Checking Claude Code...");
	try {
		execSync("claude --version", { stdio: "pipe", timeout: 5000 });
	} catch {
		console.error(
			"claude not found. Install Claude Code first: https://docs.anthropic.com/s/claude-code",
		);
		process.exit(1);
	}

	// Preflight: verify Claude Code auth
	console.log("[bae] Verifying auth...");
	try {
		const out = execSync("claude auth status", {
			stdio: "pipe",
			timeout: 5000,
			encoding: "utf-8",
		});
		const status = JSON.parse(out) as { loggedIn?: boolean };
		if (!status.loggedIn) {
			throw new Error("Not logged in");
		}
	} catch {
		console.error(
			"Claude Code is not authenticated. Bae needs a working Claude session.\n\n" +
				"  To fix, run this in your terminal:\n\n" +
				"    claude auth login\n\n" +
				"  Then restart Bae. If you're running headless/remotely, you may\n" +
				"  need to log in from an interactive terminal first.\n",
		);
		process.exit(1);
	}

	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });

	// Daemon mode: delegate to supervisor
	if (daemon) {
		const supervisor = detectSupervisor(IS_BUILT);

		if (supervisor.type !== "spawn") {
			// OS-native supervisor (launchd/systemd)
			try {
				supervisor.install({ port: cliPort });
				supervisor.start();
				console.log(
					`Bae started (managed by ${supervisor.type}). Logs: ~/.bae/bae.log`,
				);
			} catch (err) {
				console.error(
					`[bae] ${supervisor.type} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				console.error("[bae] Falling back to detached spawn...");
				// Fall back to SpawnSupervisor
				const { SpawnSupervisor } = await import("./cli/supervisor.ts");
				const fallback = new SpawnSupervisor();
				fallback.start();
				await new Promise((resolve) => setTimeout(resolve, 500));
				const pid = fallback.getLastSpawnedPid();
				console.log(`Bae started (PID ${pid}). Logs: ~/.bae/bae.log`);
			}
			process.exit(0);
		}

		// SpawnSupervisor fallback (Windows, no-systemd Linux, dev mode)
		const { SpawnSupervisor } = await import("./cli/supervisor.ts");
		const spawn = new SpawnSupervisor();
		spawn.start();
		await new Promise((resolve) => setTimeout(resolve, 500));

		if (!spawn.isRunning() && !spawn.getLastSpawnedPid()) {
			console.error("Bae failed to start. Check ~/.bae/bae.log");
			process.exit(1);
		}

		console.log(
			`Bae started (PID ${spawn.getLastSpawnedPid()}). Logs: ~/.bae/bae.log`,
		);
		process.exit(0);
	}

	// Running as daemon child or supervised process
	if (isDaemonChild || isSupervised) {
		process.on("SIGHUP", () => {});
	}

	// Initialize store and load channels
	const { Store } = await import("./session/store.ts");
	const { readChannelCredentials } = await import("./credentials.ts");
	const { createBridge } = await import("./bridge.ts");
	const { createChannel } = await import("./channel.ts");
	const { startServer } = await import("./server.ts");
	const { TELEGRAM_CONFIG } = await import("./platform/telegram.ts");
	const { SLACK_CONFIG } = await import("./platform/slack.ts");
	const { IMESSAGE_CONFIG } = await import("./platform/imessage.ts");
	const { WECHAT_CONFIG } = await import("./platform/wechat/channel.ts");
	type PlatformConfigType = import("./platform/types.ts").PlatformConfig;
	type PlatformType = import("./session/types.ts").Platform;

	function getPlatformConfig(platform: PlatformType): PlatformConfigType {
		switch (platform) {
			case "telegram":
				return TELEGRAM_CONFIG;
			case "slack":
				return SLACK_CONFIG;
			case "imessage":
				return IMESSAGE_CONFIG;
			case "wechat":
				return WECHAT_CONFIG;
		}
	}

	const store = new Store();
	await store.waitReady();

	const channels = store.listChannels();
	if (channels.length === 0) {
		console.error(
			"No channels configured.\n\n" +
				"  Quick setup:  bae init\n" +
				"  Manual setup: bae workspace add <name> --path <dir>\n" +
				"                bae channel add <workspace> --platform telegram\n",
		);
		process.exit(1);
	}

	const bridge = await createBridge({ store });

	// Boot all channels in parallel (tokens passed directly — no env var race)
	type ChannelHandleType = Awaited<ReturnType<typeof createChannel>>;
	const channelResults = await Promise.allSettled(
		channels.map(async (channel) => {
			const creds = readChannelCredentials(channel.id);
			if (Object.keys(creds).length === 0) {
				console.warn(
					`[bae] Skipping channel ${channel.label ?? channel.id}: no credentials`,
				);
				return null;
			}

			const ws = store.getWorkspace(channel.workspaceId);
			if (!ws) {
				console.warn(
					`[bae] Skipping channel ${channel.id}: workspace "${channel.workspaceId}" not found`,
				);
				return null;
			}

			// Ensure workspace directory exists
			mkdirSync(ws.path, { recursive: true });

			const config = getPlatformConfig(channel.platform);
			const handle = createChannel({
				platform: channel.platform,
				credentials: creds,
				channelId: channel.id,
				onMessage: (thread, userId, text) =>
					bridge.handleMessage(thread, userId, text, channel.id, config),
			});

			await handle.start();
			console.log(
				`[bae] Channel ${channel.label ?? channel.id} (${channel.platform}) → ${ws.path}`,
			);
			return handle;
		}),
	);

	const handles: ChannelHandleType[] = [];
	for (const r of channelResults) {
		if (r.status === "fulfilled" && r.value) {
			handles.push(r.value);
		} else if (r.status === "rejected") {
			console.warn(`[bae] Channel failed to start: ${r.reason}`);
		}
	}

	if (handles.length === 0) {
		console.error("No channels started successfully. Check credentials.");
		process.exit(1);
	}

	await startServer(port);

	writeFileSync(PID_FILE, `${process.pid}:${port}`, { mode: 0o600 });

	const workspaces = store.listWorkspaces();
	console.log(
		`[bae] Running — ${workspaces.length} workspace(s), ${handles.length} channel(s), port ${port}`,
	);
	console.log("[bae] Send a message to your bot to start chatting!");

	async function gracefulStop() {
		console.log("[bae] Shutting down...");
		await Promise.allSettled(handles.map((h) => h.stop()));
		await bridge.shutdown();
		try {
			unlinkSync(PID_FILE);
		} catch {}
	}

	async function shutdown() {
		await gracefulStop();
		process.exit(0);
	}

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	// Periodic auto-update: check every 6h, install + restart if newer
	scheduleAutoUpdate(VERSION, gracefulStop);
}

function stop() {
	const supervisor = detectSupervisor(IS_BUILT);

	// If supervisor is installed, use it to stop cleanly
	if (supervisor.type !== "spawn" && supervisor.isInstalled()) {
		const wasRunning = supervisor.isRunning();
		supervisor.uninstall(); // bootout + delete config — bae start -d reinstalls
		// Clean up PID file
		try {
			unlinkSync(PID_FILE);
		} catch {}
		if (wasRunning) {
			console.log("Bae stopped.");
		} else {
			console.log("Bae is not running.");
		}
		process.exit(wasRunning ? 0 : 1);
	}

	// Fallback: PID-based stop (SpawnSupervisor or legacy daemon)
	const info = readPidFile();
	if (info === null) {
		console.log("Bae is not running.");
		process.exit(1);
	}

	const pid = info.pid;

	if (!isProcessAlive(pid)) {
		unlinkSync(PID_FILE);
		console.log("Bae is not running (cleaned stale PID).");
		process.exit(1);
	}

	process.kill(pid, "SIGTERM");

	let waited = 0;
	const interval = setInterval(() => {
		waited += 100;
		if (!isProcessAlive(pid)) {
			clearInterval(interval);
			try {
				unlinkSync(PID_FILE);
			} catch {}
			console.log("Bae stopped.");
			process.exit(0);
		}
		if (waited >= 5000) {
			clearInterval(interval);
			process.kill(pid, "SIGKILL");
			try {
				unlinkSync(PID_FILE);
			} catch {}
			console.log("Bae stopped (forced).");
			process.exit(0);
		}
	}, 100);
}

async function status() {
	const supervisor = detectSupervisor(IS_BUILT);
	const managed =
		supervisor.type !== "spawn" && supervisor.isInstalled()
			? supervisor.type
			: null;

	const info = readPidFile();
	const alive = info && isProcessAlive(info.pid);

	if (!alive && !(managed && supervisor.isRunning())) {
		if (info) {
			try {
				unlinkSync(PID_FILE);
			} catch {}
		}
		const suffix = managed ? ` (${managed} installed but not running)` : "";
		console.log(`Stopped${suffix}`);
		process.exit(1);
	}

	const port = info?.port ?? 19456;
	const pid = info?.pid;

	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`);
		if (res.ok) {
			const managedSuffix = managed ? `, managed by ${managed}` : "";
			console.log(`Running (PID ${pid ?? "?"}, port ${port}${managedSuffix})`);
			process.exit(0);
		}
	} catch {}

	const managedSuffix = managed ? `, managed by ${managed}` : "";
	console.log(
		`Running (PID ${pid ?? "?"}${managedSuffix}) — health check failed`,
	);
	process.exit(0);
}

async function upgrade() {
	const { autoUpdate } = await import("./cli/update-check.ts");
	const updated = await autoUpdate(VERSION);
	if (!updated) {
		console.log(`bae ${VERSION} is already the latest version.`);
		return;
	}
	const { restartIfRunning } = await import("./cli/restart.ts");
	const restarted = restartIfRunning();
	if (!restarted) {
		console.log("Updated. Run `bae start -d` to use the new version.");
	}
}

async function init() {
	const { runInit } = await import("./cli/init.ts");
	await runInit(args.slice(1));
}

async function workspace() {
	const { Store } = await import("./session/store.ts");
	const { workspaceCommand } = await import("./cli/workspace.ts");
	const store = new Store();
	await store.waitReady();
	try {
		await workspaceCommand(args.slice(1), store);
	} finally {
		store.close();
	}
}

async function channel() {
	const { Store } = await import("./session/store.ts");
	const { channelCommand } = await import("./cli/channel.ts");
	const store = new Store();
	await store.waitReady();
	try {
		await channelCommand(args.slice(1), store);
	} finally {
		store.close();
	}
}
