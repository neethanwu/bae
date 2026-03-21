import { execSync, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BAE_DIR = join(homedir(), ".bae");
const PID_FILE = join(BAE_DIR, "bae.pid");
const LOG_FILE = join(BAE_DIR, "bae.log");

function getRunningPid(): number | null {
	if (!existsSync(PID_FILE)) return null;
	const raw = readFileSync(PID_FILE, "utf-8").trim();
	const pid = Number.parseInt(raw.split(":")[0] ?? "", 10);
	if (Number.isNaN(pid)) return null;
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

/**
 * If bae is running, restart it so config changes take effect.
 * Sends SIGTERM, waits for exit, then spawns a new daemon child.
 * Returns true if a restart was performed.
 */
export function restartIfRunning(): boolean {
	const pid = getRunningPid();
	if (pid === null) return false;

	console.log("Restarting bae to apply changes...");

	// Stop the running process
	process.kill(pid, "SIGTERM");
	let waited = 0;
	while (waited < 5000) {
		try {
			process.kill(pid, 0);
		} catch {
			break; // Process exited
		}
		execSync("sleep 0.1", { stdio: "ignore" });
		waited += 100;
	}

	// Force kill if still alive
	if (waited >= 5000) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}

	// Clean up stale PID file
	try {
		unlinkSync(PID_FILE);
	} catch {}

	spawnDaemon();
	console.log(
		`Bae restarted (PID ${lastSpawnedPid}) — up and running with changes applied.`,
	);
	return true;
}

let lastSpawnedPid: number | undefined;

function spawnDaemon(): void {
	const logFd = openSync(LOG_FILE, "a");
	const child = spawn(
		process.execPath,
		[process.argv[1] ?? "", "start", "--_daemon-child"],
		{ detached: true, stdio: ["ignore", logFd, logFd] },
	);
	child.unref();
	lastSpawnedPid = child.pid;
}

/**
 * Start bae as a daemon if it's not already running.
 * Returns true if started.
 */
export function startIfNotRunning(): boolean {
	const pid = getRunningPid();
	if (pid !== null) return false;

	spawnDaemon();
	console.log(`Bae started (PID ${lastSpawnedPid}). Logs: ~/.bae/bae.log`);
	return true;
}
