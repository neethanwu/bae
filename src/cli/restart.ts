/**
 * Restart/start helpers for CLI commands that modify config.
 *
 * Uses the OS-native supervisor if installed (launchd/systemd),
 * falls back to legacy detached spawn otherwise.
 */

import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	isProcessAlive,
	readPidFile,
	SpawnSupervisor,
	type Supervisor,
} from "./supervisor.ts";
import { LaunchdSupervisor } from "./supervisor-launchd.ts";
import { SystemdSupervisor } from "./supervisor-systemd.ts";

const BAE_DIR = join(homedir(), ".bae");
const PID_FILE = join(BAE_DIR, "bae.pid");

/**
 * Get the installed supervisor, if any.
 * Checks for installed plist/unit files rather than platform detection,
 * so this works without knowing the VERSION (dev mode check).
 */
function getInstalledSupervisor(): Supervisor | null {
	if (process.platform === "darwin") {
		const s = new LaunchdSupervisor();
		if (s.isInstalled()) return s;
	}
	if (process.platform === "linux" && existsSync("/run/systemd/system")) {
		const s = new SystemdSupervisor();
		if (s.isInstalled()) return s;
	}
	return null;
}

/**
 * Get the OS-native supervisor for this platform, even if not installed yet.
 * Returns null only if the platform doesn't support a native supervisor.
 */
function getAvailableSupervisor(): Supervisor | null {
	if (process.platform === "darwin") return new LaunchdSupervisor();
	if (process.platform === "linux" && existsSync("/run/systemd/system"))
		return new SystemdSupervisor();
	return null;
}

/**
 * Check if Bae is currently running (via supervisor or PID file).
 */
export function isBaeRunning(): boolean {
	const supervisor = getInstalledSupervisor();
	if (supervisor?.isRunning()) return true;
	const info = readPidFile();
	return !!(info && isProcessAlive(info.pid));
}

/**
 * If bae is running, restart it so config changes take effect.
 * Uses supervisor if installed, otherwise falls back to legacy spawn.
 * On restart, migrates to OS-native supervisor if available.
 * Returns true if a restart was performed.
 */
export function restartIfRunning(): boolean {
	const installed = getInstalledSupervisor();

	if (installed?.isRunning()) {
		console.log("Restarting Bae to apply changes...");
		installed.restart();
		console.log("Bae restarted — changes applied.");
		return true;
	}

	// Check for legacy PID-based process
	const info = readPidFile();
	if (!info || !isProcessAlive(info.pid)) return false;

	console.log("Restarting Bae to apply changes...");

	// Kill the legacy process
	process.kill(info.pid, "SIGTERM");
	let waited = 0;
	while (waited < 5000) {
		if (!isProcessAlive(info.pid)) break;
		execSync("sleep 0.1", { stdio: "ignore" });
		waited += 100;
	}

	if (waited >= 5000) {
		try {
			process.kill(info.pid, "SIGKILL");
		} catch {}
	}

	try {
		unlinkSync(PID_FILE);
	} catch {}

	// Migrate to OS-native supervisor if available
	const supervisor = getAvailableSupervisor();
	if (supervisor) {
		supervisor.start();
		console.log(
			`Bae restarted (managed by ${supervisor.type}) — changes applied.`,
		);
		return true;
	}

	// Legacy fallback
	const fallback = new SpawnSupervisor();
	fallback.start();
	console.log(
		`Bae restarted (PID ${fallback.getLastSpawnedPid()}) — changes applied.`,
	);
	return true;
}

/**
 * Start bae as a daemon if it's not already running.
 * Always uses the OS-native supervisor (launchd/systemd) when available
 * for crash recovery and sleep survival. Falls back to legacy spawn only
 * on platforms without a native supervisor.
 * Returns true if started.
 */
export function startIfNotRunning(): boolean {
	// Check if already running via installed supervisor
	const installed = getInstalledSupervisor();
	if (installed?.isRunning()) return false;

	// Check if already running via PID
	const info = readPidFile();
	if (info && isProcessAlive(info.pid)) return false;

	// Prefer OS-native supervisor (auto-installs if not yet installed)
	const supervisor = getAvailableSupervisor();
	if (supervisor) {
		supervisor.start(); // LaunchdSupervisor.start() calls install() if needed
		console.log(
			`Bae started (managed by ${supervisor.type}). Logs: ~/.bae/bae.log`,
		);
		return true;
	}

	// Legacy fallback (no native supervisor available)
	const fallback = new SpawnSupervisor();
	fallback.start();
	console.log(
		`Bae started (PID ${fallback.getLastSpawnedPid()}). Logs: ~/.bae/bae.log`,
	);
	return true;
}
