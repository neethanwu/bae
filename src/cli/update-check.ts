import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_FILE = join(homedir(), ".bae", "update-check.json");
const REGISTRY_URL =
	"https://registry.npmjs.org/-/package/bae-bridge/dist-tags";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

interface UpdateCache {
	lastCheck: number;
	latestVersion: string;
	notifiedVersion?: string;
}

function readCache(): UpdateCache | null {
	try {
		if (!existsSync(CACHE_FILE)) return null;
		return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as UpdateCache;
	} catch {
		return null;
	}
}

function writeCache(cache: UpdateCache): void {
	try {
		mkdirSync(join(homedir(), ".bae"), { recursive: true, mode: 0o700 });
		writeFileSync(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
	} catch {
		// Best-effort — don't crash the CLI
	}
}

/** Compare two semver strings. Returns true if b > a. */
export function isNewerVersion(current: string, latest: string): boolean {
	const a = current.split(".").map(Number);
	const b = latest.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (bv > av) return true;
		if (bv < av) return false;
	}
	return false;
}

/** Returns true if the major version increased. */
function isMajorBump(current: string, latest: string): boolean {
	const a = Number.parseInt(current.split(".")[0] ?? "0", 10);
	const b = Number.parseInt(latest.split(".")[0] ?? "0", 10);
	return b > a;
}

/**
 * Non-blocking update check. Call at CLI entry point.
 * Prints a notice to stderr if a new version is available.
 * Never throws — all errors are silently swallowed.
 */
export function checkForUpdates(currentVersion: string): void {
	try {
		// Opt-out
		if (process.env.BAE_NO_UPDATE_NOTIFIER) return;
		// Only notify on TTYs (not CI, not piped)
		if (!process.stderr.isTTY) return;

		const cache = readCache();

		// If cache has a newer version we haven't notified about, print it
		if (cache?.latestVersion && cache.notifiedVersion !== cache.latestVersion) {
			if (isNewerVersion(currentVersion, cache.latestVersion)) {
				const major = isMajorBump(currentVersion, cache.latestVersion);
				const tag = major ? " (major)" : "";
				process.stderr.write(
					`\nUpdate available: ${currentVersion} → ${cache.latestVersion}${tag}\n` +
						"Run: npm update -g bae-bridge\n\n",
				);
				writeCache({ ...cache, notifiedVersion: cache.latestVersion });
			}
		}

		// Check if we need to fetch (stale or no cache)
		if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) return;

		// Fire-and-forget fetch — never blocks the CLI
		fetchLatestVersion()
			.then((latest) => {
				if (latest) {
					writeCache({
						lastCheck: Date.now(),
						latestVersion: latest,
						notifiedVersion: cache?.notifiedVersion,
					});
				}
			})
			.catch(() => {
				// Silently ignore network errors
			});
	} catch {
		// Never crash the CLI for update checks
	}
}

/**
 * Auto-update bae-bridge if a newer version is available.
 * Runs before the server boots — safe because nothing is live yet.
 * Returns true if an update was applied.
 */
export async function autoUpdate(currentVersion: string): Promise<boolean> {
	try {
		if (process.env.BAE_NO_AUTO_UPDATE) return false;

		const latest = await fetchLatestVersion();
		if (!latest || !isNewerVersion(currentVersion, latest)) return false;

		return installUpdate(currentVersion, latest);
	} catch (e) {
		console.warn(
			`[bae] Auto-update failed: ${e instanceof Error ? e.message : String(e)}`,
		);
		return false;
	}
}

function installUpdate(currentVersion: string, latest: string): boolean {
	try {
		console.log(`[bae] Updating bae-bridge: ${currentVersion} → ${latest}`);
		execSync("npm update -g bae-bridge", { stdio: "pipe", timeout: 60000 });
		console.log("[bae] Updated successfully.");
		return true;
	} catch (e) {
		console.warn(
			`[bae] Update install failed: ${e instanceof Error ? e.message : String(e)}`,
		);
		return false;
	}
}

/**
 * Schedule periodic update checks for a running server.
 * When an update is found, installs it, gracefully shuts down,
 * and re-spawns as a daemon child with the new code.
 */
export function scheduleAutoUpdate(
	currentVersion: string,
	onRestart: () => Promise<void>,
): void {
	if (process.env.BAE_NO_AUTO_UPDATE) return;

	const LIVE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

	const check = async () => {
		try {
			const latest = await fetchLatestVersion();
			if (!latest || !isNewerVersion(currentVersion, latest)) return;

			const updated = installUpdate(currentVersion, latest);
			if (!updated) return;

			console.log("[bae] Restarting with new version...");
			await onRestart();

			// Spawn a new daemon child with the updated code
			const { spawn } = await import("node:child_process");
			const logFd = openSync(join(homedir(), ".bae", "bae.log"), "a");
			const child = spawn(
				process.execPath,
				[process.argv[1] ?? "", "start", "--_daemon-child"],
				{ detached: true, stdio: ["ignore", logFd, logFd] },
			);
			child.unref();
			process.exit(0);
		} catch (e) {
			console.warn(
				`[bae] Live auto-update failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	};

	setInterval(check, LIVE_CHECK_INTERVAL_MS);
}

async function fetchLatestVersion(): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const res = await fetch(REGISTRY_URL, { signal: controller.signal });
		clearTimeout(timeout);
		if (!res.ok) return null;
		const data = (await res.json()) as { latest?: string };
		return data.latest ?? null;
	} catch {
		return null;
	}
}
