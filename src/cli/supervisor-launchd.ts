/**
 * macOS launchd supervisor.
 *
 * Manages a LaunchAgent plist that keeps the Bae daemon alive.
 * - KeepAlive.SuccessfulExit=false: restarts on crash, not on clean stop
 * - ProcessType=Background: prevents App Nap throttling
 * - RunAtLoad=false: only starts when explicitly requested
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Supervisor, SupervisorOptions } from "./supervisor.ts";
import { capturePath, resolveBaeBinary } from "./supervisor.ts";

const LABEL = "com.bae-bridge";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const DOMAIN_TARGET = `gui/${process.getuid?.() ?? 501}`;

function generatePlist(port?: number): string {
	const baeBinary = resolveBaeBinary();
	const home = homedir();
	const path = capturePath();
	const logPath = join(home, ".bae", "bae.log");

	const portArgs = port
		? `\n    <string>--port</string>\n    <string>${port}</string>`
		: "";

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(baeBinary)}</string>
    <string>start</string>
    <string>--_supervised</string>${portArgs}
  </array>

  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>RunAtLoad</key>
  <false/>

  <key>ProcessType</key>
  <string>Background</string>

  <key>ExitTimeOut</key>
  <integer>10</integer>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Run a launchctl command, trying modern API first, legacy as fallback.
 */
function launchctl(
	action: "bootstrap" | "bootout" | "kickstart",
	options?: { force?: boolean },
): boolean {
	try {
		switch (action) {
			case "bootstrap":
				try {
					execSync(`launchctl bootstrap ${DOMAIN_TARGET} ${PLIST_PATH}`, {
						stdio: "pipe",
					});
				} catch {
					// Fallback to legacy API for older macOS
					execSync(`launchctl load ${PLIST_PATH}`, { stdio: "pipe" });
				}
				return true;

			case "bootout":
				try {
					execSync(`launchctl bootout ${DOMAIN_TARGET}/${LABEL}`, {
						stdio: "pipe",
					});
				} catch {
					execSync(`launchctl unload ${PLIST_PATH}`, {
						stdio: "pipe",
					});
				}
				return true;

			case "kickstart": {
				const flags = options?.force ? "-k" : "";
				try {
					execSync(`launchctl kickstart ${flags} ${DOMAIN_TARGET}/${LABEL}`, {
						stdio: "pipe",
					});
				} catch {
					// Fallback: bootout + bootstrap
					try {
						launchctl("bootout");
					} catch {}
					launchctl("bootstrap");
				}
				return true;
			}
		}
	} catch {
		return false;
	}
}

function validatePlist(): boolean {
	try {
		execSync(`plutil -lint ${PLIST_PATH}`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

export class LaunchdSupervisor implements Supervisor {
	readonly type = "launchd" as const;

	install(options?: SupervisorOptions): void {
		mkdirSync(PLIST_DIR, { recursive: true });

		// Always regenerate to pick up PATH/binary changes
		const plist = generatePlist(options?.port);
		writeFileSync(PLIST_PATH, plist, { mode: 0o644 });

		if (!validatePlist()) {
			throw new Error(`[bae] Generated plist is invalid. Check ${PLIST_PATH}`);
		}
	}

	uninstall(): void {
		if (this.isServiceLoaded()) {
			launchctl("bootout");
		}
		try {
			unlinkSync(PLIST_PATH);
		} catch {}
	}

	start(): void {
		if (!this.isInstalled()) {
			this.install();
		}

		if (this.isServiceLoaded()) {
			// Already loaded — kickstart if not running
			if (!this.isRunning()) {
				launchctl("kickstart");
			}
			return;
		}

		launchctl("bootstrap");
	}

	stop(): void {
		if (!this.isServiceLoaded()) return;
		// bootout unloads the service, so KeepAlive won't restart it.
		// The daemon receives SIGTERM, exits 0, and stays stopped.
		launchctl("bootout");
	}

	restart(): void {
		if (!this.isInstalled()) {
			this.install();
		}

		if (this.isServiceLoaded()) {
			// kickstart -k kills and restarts the service
			launchctl("kickstart", { force: true });
		} else {
			// Not loaded — just start
			launchctl("bootstrap");
		}
	}

	isInstalled(): boolean {
		return existsSync(PLIST_PATH);
	}

	isRunning(): boolean {
		try {
			const output = execSync(`launchctl print ${DOMAIN_TARGET}/${LABEL}`, {
				stdio: "pipe",
				encoding: "utf-8",
			});
			// Check for pid in the output
			return /pid\s*=\s*\d+/.test(output);
		} catch {
			return false;
		}
	}

	private isServiceLoaded(): boolean {
		try {
			execSync(`launchctl print ${DOMAIN_TARGET}/${LABEL}`, {
				stdio: "pipe",
			});
			return true;
		} catch {
			return false;
		}
	}
}
