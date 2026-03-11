import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BAE_DIR = join(homedir(), ".bae");
const PID_FILE = join(BAE_DIR, "bae.pid");
const ENV_FILE = join(BAE_DIR, ".env");
const VERSION = "0.1.0";

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
		status();
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
    bae init       Guided setup wizard
    bae start      Start Bae (foreground)
    bae stop       Stop running Bae instance
    bae status     Show running/stopped

  Options:
    --version      Show version
    --help         Show this message
`);
}

/**
 * Load ~/.bae/.env into process.env (simple KEY=VALUE parser).
 */
function loadEnvFile(path: string): void {
	if (!existsSync(path)) return;
	const content = readFileSync(path, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		// Don't override existing env vars
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
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

function readPid(): number | null {
	if (!existsSync(PID_FILE)) return null;
	const raw = readFileSync(PID_FILE, "utf-8").trim();
	const pid = Number.parseInt(raw, 10);
	return Number.isNaN(pid) ? null : pid;
}

async function start() {
	// Check for existing instance
	const existingPid = readPid();
	if (existingPid !== null && isProcessAlive(existingPid)) {
		console.error(`Bae is already running (PID ${existingPid}).`);
		process.exit(1);
	}
	// Clean stale PID
	if (existingPid !== null) {
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

	const allowedUsersRaw = process.env.BAE_ALLOWED_USERS ?? "";
	const allowedUsers = allowedUsersRaw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	const cwd = process.env.BAE_CWD || join(homedir(), "baesment");
	const port = Number(process.env.BAE_PORT) || 3456;

	// Ensure directories exist
	mkdirSync(BAE_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(cwd, { recursive: true });

	// Write PID
	writeFileSync(PID_FILE, String(process.pid));

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

	console.log(`[bae] Bae running on port ${port}`);

	// Graceful shutdown
	function shutdown() {
		bridge.shutdown();
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
	const pid = readPid();
	if (pid === null) {
		console.log("Bae is not running.");
		process.exit(1);
	}

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

function status() {
	const pid = readPid();
	if (pid === null || !isProcessAlive(pid)) {
		if (pid !== null) {
			// Clean stale PID
			try {
				unlinkSync(PID_FILE);
			} catch {}
		}
		console.log("Stopped");
		process.exit(1);
	}
	console.log(`Running (PID ${pid})`);
	process.exit(0);
}

async function init() {
	const { runInit } = await import("./cli/init.ts");
	await runInit();
}
