/**
 * Process supervisor abstraction.
 *
 * Delegates daemon lifecycle to the best available OS mechanism:
 * - macOS: launchd (LaunchAgent plist)
 * - Linux: systemd (user service unit)
 * - Fallback: detached child process (current behavior)
 */

import { execSync, spawn } from "node:child_process";
import {
	existsSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LaunchdSupervisor } from "./supervisor-launchd.ts";
import { SystemdSupervisor } from "./supervisor-systemd.ts";

const BAE_DIR = join(homedir(), ".bae");
const PID_FILE = join(BAE_DIR, "bae.pid");
const LOG_FILE = join(BAE_DIR, "bae.log");

export interface SupervisorOptions {
	/** Custom port to embed in supervisor config. */
	port?: number;
}

export interface Supervisor {
	/** Write config file + load/enable service. Idempotent. */
	install(options?: SupervisorOptions): void;
	/** Stop + unload/disable + delete config. */
	uninstall(): void;
	/** Start the service (if not running). */
	start(): void;
	/** Stop the service without triggering auto-restart. */
	stop(): void;
	/** Restart the service. */
	restart(): void;
	/** Whether the supervisor config is installed. */
	isInstalled(): boolean;
	/** Whether the supervised process is currently running. */
	isRunning(): boolean;
	/** Supervisor type identifier. */
	readonly type: "launchd" | "systemd" | "spawn";
}

/**
 * Resolve the absolute path to the `bae` binary being executed.
 * Uses process.argv[1] (the script path) which is the most reliable
 * across nvm/fnm/brew installs.
 */
export function resolveBaeBinary(): string {
	try {
		return realpathSync(process.argv[1] ?? "");
	} catch {
		return process.argv[1] ?? "";
	}
}

/**
 * Capture the current PATH for embedding in supervisor config.
 * Includes nvm/fnm/homebrew paths that are active at install time.
 */
export function capturePath(): string {
	return process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
}

/**
 * Detect the best supervisor for the current platform.
 * When running from source (not built by tsup), always returns SpawnSupervisor
 * to avoid installing system services pointing at a dev checkout.
 *
 * @param built - true when running from a tsup-built binary (npm install -g)
 */
export function detectSupervisor(built: boolean): Supervisor {
	if (!built) return new SpawnSupervisor();

	if (process.platform === "darwin") {
		return new LaunchdSupervisor();
	}

	if (process.platform === "linux" && hasSystemd()) {
		return new SystemdSupervisor();
	}

	return new SpawnSupervisor();
}

function hasSystemd(): boolean {
	return existsSync("/run/systemd/system");
}

// ---- Helpers shared across supervisors ----

export function readPidFile(): { pid: number; port: number } | null {
	if (!existsSync(PID_FILE)) return null;
	const raw = readFileSync(PID_FILE, "utf-8").trim();
	const parts = raw.split(":");
	const pid = Number.parseInt(parts[0] ?? "", 10);
	const port = Number.parseInt(parts[1] ?? "", 10) || 19456;
	return Number.isNaN(pid) ? null : { pid, port };
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ---- SpawnSupervisor: fallback using current detached child process ----

/**
 * Fallback supervisor using detached child process spawn.
 * This is the current behavior — no OS-level supervision.
 */
export class SpawnSupervisor implements Supervisor {
	readonly type = "spawn" as const;
	private lastSpawnedPid: number | undefined;

	install(): void {
		// No config file to write for detached spawn
	}

	uninstall(): void {
		// Nothing to uninstall
	}

	start(): void {
		const logFd = openSync(LOG_FILE, "a");
		const child = spawn(
			process.execPath,
			[process.argv[1] ?? "", "start", "--_daemon-child"],
			{ detached: true, stdio: ["ignore", logFd, logFd] },
		);
		child.unref();
		this.lastSpawnedPid = child.pid;
	}

	stop(): void {
		const info = readPidFile();
		if (!info) return;
		if (!isProcessAlive(info.pid)) return;

		process.kill(info.pid, "SIGTERM");

		// Busy-wait for process to exit (up to 5s)
		let waited = 0;
		while (waited < 5000) {
			if (!isProcessAlive(info.pid)) break;
			execSync("sleep 0.1", { stdio: "ignore" });
			waited += 100;
		}

		// Force kill if still alive
		if (waited >= 5000) {
			try {
				process.kill(info.pid, "SIGKILL");
			} catch {}
		}
	}

	restart(): void {
		this.stop();
		// Clean up stale PID file
		try {
			unlinkSync(PID_FILE);
		} catch {}
		this.start();
	}

	isInstalled(): boolean {
		return false; // No config to check
	}

	isRunning(): boolean {
		const info = readPidFile();
		if (!info) return false;
		return isProcessAlive(info.pid);
	}

	getLastSpawnedPid(): number | undefined {
		return this.lastSpawnedPid;
	}
}
