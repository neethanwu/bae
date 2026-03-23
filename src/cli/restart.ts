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
 * If bae is running, restart it so config changes take effect.
 * Uses supervisor if installed, otherwise falls back to legacy spawn.
 * Returns true if a restart was performed.
 */
export function restartIfRunning(): boolean {
	const supervisor = getInstalledSupervisor();

	if (supervisor) {
		if (!supervisor.isRunning()) return false;
		console.log("Restarting bae to apply changes...");
		supervisor.restart();
		console.log("Bae restarted — up and running with changes applied.");
		return true;
	}

	// Legacy fallback: PID-based restart
	const info = readPidFile();
	if (!info || !isProcessAlive(info.pid)) return false;

	console.log("Restarting bae to apply changes...");

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

	const fallback = new SpawnSupervisor();
	fallback.start();
	console.log(
		`Bae restarted (PID ${fallback.getLastSpawnedPid()}) — up and running with changes applied.`,
	);
	return true;
}

/**
 * Start bae as a daemon if it's not already running.
 * Uses supervisor if installed, otherwise falls back to legacy spawn.
 * Returns true if started.
 */
export function startIfNotRunning(): boolean {
	const supervisor = getInstalledSupervisor();

	if (supervisor) {
		if (supervisor.isRunning()) return false;
		supervisor.start();
		console.log(
			`Bae started (managed by ${supervisor.type}). Logs: ~/.bae/bae.log`,
		);
		return true;
	}

	// Legacy fallback
	const info = readPidFile();
	if (info && isProcessAlive(info.pid)) return false;

	const fallback = new SpawnSupervisor();
	fallback.start();
	console.log(
		`Bae started (PID ${fallback.getLastSpawnedPid()}). Logs: ~/.bae/bae.log`,
	);
	return true;
}
