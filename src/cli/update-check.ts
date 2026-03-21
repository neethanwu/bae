import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Runs synchronously before the server boots — safe because nothing is live yet.
 * Returns true if an update was applied.
 */
export async function autoUpdate(currentVersion: string): Promise<boolean> {
	try {
		if (process.env.BAE_NO_AUTO_UPDATE) return false;

		const latest = await fetchLatestVersion();
		if (!latest || !isNewerVersion(currentVersion, latest)) return false;

		console.log(`[bae] Updating bae-bridge: ${currentVersion} → ${latest}`);
		const { execSync } = await import("node:child_process");
		execSync("npm update -g bae-bridge", {
			stdio: "pipe",
			timeout: 60000,
		});
		console.log("[bae] Update complete. Restart bae to use the new version.");
		return true;
	} catch (e) {
		console.warn(
			`[bae] Auto-update failed: ${e instanceof Error ? e.message : String(e)}`,
		);
		return false;
	}
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
