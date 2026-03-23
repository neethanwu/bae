/**
 * Linux systemd user service supervisor.
 *
 * Manages a systemd user unit that keeps the Bae daemon alive.
 * - Restart=on-failure: restarts on crash, not on clean stop
 * - WantedBy=default.target: available for auto-start (but not enabled by default)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Supervisor, SupervisorOptions } from "./supervisor.ts";
import { capturePath, resolveBaeBinary } from "./supervisor.ts";

const UNIT_NAME = "bae.service";
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(UNIT_DIR, UNIT_NAME);

function generateUnit(port?: number): string {
	const baeBinary = resolveBaeBinary();
	const path = capturePath();
	const home = homedir();
	const portArg = port ? ` --port ${port}` : "";

	return `[Unit]
Description=Bae Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${baeBinary} start --_supervised${portArg}
WorkingDirectory=${home}
Restart=on-failure
RestartSec=5
Environment=HOME=${home}
Environment=PATH=${path}
TimeoutStopSec=10
SyslogIdentifier=bae

[Install]
WantedBy=default.target
`;
}

function systemctl(...args: string[]): string {
	return execSync(`systemctl --user ${args.join(" ")}`, {
		stdio: "pipe",
		encoding: "utf-8",
	});
}

export class SystemdSupervisor implements Supervisor {
	readonly type = "systemd" as const;

	install(options?: SupervisorOptions): void {
		mkdirSync(UNIT_DIR, { recursive: true });

		const unit = generateUnit(options?.port);
		writeFileSync(UNIT_PATH, unit, { mode: 0o644 });

		// Reload after writing/updating the unit file
		try {
			systemctl("daemon-reload");
		} catch {}
	}

	uninstall(): void {
		try {
			systemctl("stop", UNIT_NAME);
		} catch {}
		try {
			systemctl("disable", UNIT_NAME);
		} catch {}
		try {
			unlinkSync(UNIT_PATH);
		} catch {}
		try {
			systemctl("daemon-reload");
		} catch {}
	}

	start(): void {
		if (!this.isInstalled()) {
			this.install();
		}
		systemctl("start", UNIT_NAME);
	}

	stop(): void {
		try {
			systemctl("stop", UNIT_NAME);
		} catch {}
	}

	restart(): void {
		if (!this.isInstalled()) {
			this.install();
		}
		try {
			systemctl("daemon-reload");
		} catch {}
		systemctl("restart", UNIT_NAME);
	}

	isInstalled(): boolean {
		return existsSync(UNIT_PATH);
	}

	isRunning(): boolean {
		try {
			const output = systemctl("is-active", UNIT_NAME);
			return output.trim() === "active";
		} catch {
			return false;
		}
	}
}
