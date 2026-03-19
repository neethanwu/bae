import {
	type ChildProcess,
	spawn as cpSpawn,
	execSync,
} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "./cli/env.ts";

const BAE_DIR = join(homedir(), ".bae");
const PID_FILE = join(BAE_DIR, "bae.pid");
const ENV_FILE = join(BAE_DIR, ".env");
const LOG_FILE = join(BAE_DIR, "bae.log");
declare const __VERSION__: string;
// __VERSION__ is injected by tsup at build time. When running from source
// (bun src/cli.ts), fall back to reading package.json.
const VERSION =
	typeof __VERSION__ !== "undefined"
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
    bae init                      Guided setup wizard
    bae start [-d]                Start Bae (use -d for background mode)
    bae stop                      Stop running Bae instance
    bae status                    Show running/stopped

    bae workspace list            List workspaces
    bae workspace add <slug>      Add a workspace
    bae workspace remove <slug>   Remove a workspace
    bae workspace set-executor    Change workspace executor

    bae channel list              List channels
    bae channel add <workspace>   Add a channel to a workspace
    bae channel remove <id>       Remove a channel

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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPidAndPort(): { pid: number; port: number } | null {
	if (!existsSync(PID_FILE)) return null;
	const raw = readFileSync(PID_FILE, "utf-8").trim();
	const parts = raw.split(":");
	const pid = Number.parseInt(parts[0] ?? "", 10);
	const port = Number.parseInt(parts[1] ?? "", 10) || 3456;
	return Number.isNaN(pid) ? null : { pid, port };
}

async function start() {
	const flags = new Set(args.slice(1));
	const daemon = flags.has("-d") || flags.has("--daemon");
	const isDaemonChild = flags.has("--_daemon-child");

	// Check for existing instance
	const existing = readPidAndPort();
	if (existing !== null && isProcessAlive(existing.pid)) {
		console.error(`Bae is already running (PID ${existing.pid}).`);
		process.exit(1);
	}
	if (existing !== null) {
		unlinkSync(PID_FILE);
	}

	// Load global config (BAE_PORT only)
	loadEnvFile(ENV_FILE);

	const port = Number(process.env.BAE_PORT) || 3456;

	// Check agent binary exists
	try {
		execSync("claude --version", { stdio: "pipe", timeout: 5000 });
	} catch {
		console.error(
			"claude not found. Install Claude Code first: https://docs.anthropic.com/s/claude-code",
		);
		process.exit(1);
	}

	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });

	// Daemon mode
	if (daemon) {
		const logPath = join(BAE_DIR, "bae.log");
		const logFd = openSync(logPath, "a");

		const child: ChildProcess = cpSpawn(
			process.execPath,
			[process.argv[1] ?? "", "start", "--_daemon-child"],
			{
				detached: true,
				stdio: ["ignore", logFd, logFd],
				env: process.env as Record<string, string>,
			},
		);

		child.unref();
		await new Promise((resolve) => setTimeout(resolve, 500));

		if (child.exitCode !== null) {
			console.error("Bae failed to start. Check ~/.bae/bae.log");
			process.exit(1);
		}

		console.log(`Bae started (PID ${child.pid}). Logs: ~/.bae/bae.log`);
		process.exit(0);
	}

	if (isDaemonChild) {
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
		}
	}

	const store = new Store();
	await store.waitReady();

	const channels = store.listChannels();
	if (channels.length === 0) {
		console.error(
			"No channels configured. Run `bae init` or `bae workspace add` + `bae channel add`.",
		);
		process.exit(1);
	}

	const bridge = await createBridge({ store });

	// Boot all channels in parallel (tokens passed directly — no env var race)
	type ChannelHandleType = Awaited<ReturnType<typeof createChannel>>;
	const channelResults = await Promise.allSettled(
		channels.map(async (channel) => {
			const creds = readChannelCredentials(channel.id);
			// iMessage local mode has no credentials — skip check for it
			if (Object.keys(creds).length === 0 && channel.platform !== "imessage") {
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

	async function shutdown() {
		console.log("[bae] Shutting down...");
		await Promise.allSettled(handles.map((h) => h.stop()));
		await bridge.shutdown();
		try {
			unlinkSync(PID_FILE);
		} catch {}
		process.exit(0);
	}

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

function stop() {
	const info = readPidAndPort();
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
	const info = readPidAndPort();
	if (!info || !isProcessAlive(info.pid)) {
		if (info) {
			try {
				unlinkSync(PID_FILE);
			} catch {}
		}
		console.log("Stopped");
		process.exit(1);
	}

	try {
		const res = await fetch(`http://127.0.0.1:${info.port}/health`);
		if (res.ok) {
			console.log(`Running (PID ${info.pid}, port ${info.port})`);
			process.exit(0);
		}
	} catch {}

	console.log(`Running (PID ${info.pid}) — health check failed`);
	process.exit(0);
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
