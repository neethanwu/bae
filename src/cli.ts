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
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.1.0";

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
    bae init         Guided setup wizard
    bae start [-d]   Start Bae (use -d for background mode)
    bae stop         Stop running Bae instance
    bae status       Show running/stopped
    bae logs         Tail daemon log file

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

/**
 * Check if a process with given PID is alive.
 */
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
	// Clean stale PID
	if (existing !== null) {
		unlinkSync(PID_FILE);
	}

	// Load env from ~/.bae/.env
	loadEnvFile(ENV_FILE);

	// Validate required config
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	if (!botToken) {
		console.error(
			"TELEGRAM_BOT_TOKEN is not set. Run `bae init` to configure, or set it in ~/.bae/.env",
		);
		process.exit(1);
	}

	// Check agent binary exists
	try {
		execSync("claude --version", { stdio: "pipe", timeout: 5000 });
	} catch {
		console.error(
			"claude not found. Install Claude Code first: https://docs.anthropic.com/s/claude-code",
		);
		process.exit(1);
	}

	const allowedUsersRaw = process.env.BAE_ALLOWED_USERS ?? "";
	const allowedUsers = allowedUsersRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	if (allowedUsers.length === 0) {
		console.error(
			"BAE_ALLOWED_USERS is empty. At least one user ID is required for security.\n" +
				"Run `bae init` to configure, or set BAE_ALLOWED_USERS in ~/.bae/.env",
		);
		process.exit(1);
	}

	const cwd = process.env.BAE_CWD || join(homedir(), "baesment");
	const port = Number(process.env.BAE_PORT) || 3456;

	// Ensure directories exist
	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(cwd, { recursive: true });

	// Daemon mode: re-exec self detached
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

		// Wait briefly to confirm child didn't crash immediately
		await new Promise((resolve) => setTimeout(resolve, 500));

		if (child.exitCode !== null) {
			console.error("Bae failed to start. Check ~/.bae/bae.log");
			process.exit(1);
		}

		console.log(`Bae started (PID ${child.pid}). Logs: ~/.bae/bae.log`);
		process.exit(0);
	}

	// Daemon child ignores SIGHUP so it survives terminal close
	if (isDaemonChild) {
		process.on("SIGHUP", () => {});
	}

	// Initialize components
	const { createBridge } = await import("./bridge.ts");
	const { createBot } = await import("./bot.ts");
	const { startServer } = await import("./server.ts");

	const bridge = await createBridge({ cwd, allowedUsers });

	const bot = createBot(botToken, (thread, message) =>
		bridge.handleMessage(thread, message),
	);

	await startServer(port);
	await bot.start();

	// Write PID:PORT only after successful startup
	writeFileSync(PID_FILE, `${process.pid}:${port}`, { mode: 0o600 });

	console.log(`[bae] Bae running on port ${port}`);

	// Graceful shutdown
	async function shutdown() {
		await bridge.shutdown();
		bot.stop();
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

	// Wait up to 5s for exit
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

	// Check health endpoint
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
