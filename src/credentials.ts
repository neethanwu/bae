import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseEnvFile } from "./cli/env.ts";

const CREDENTIALS_DIR = join(homedir(), ".bae", "credentials");

const CHANNEL_ID_RE = /^chan_[a-z0-9]{10}$/;

/**
 * Resolve a credential file path, guarding against path traversal.
 * Validates channel ID format and ensures the resolved path stays
 * within the credentials directory.
 */
function safeCredentialPath(channelId: string): string {
	if (!CHANNEL_ID_RE.test(channelId)) {
		throw new Error(`Invalid channel ID format: ${channelId}`);
	}
	const resolved = resolve(CREDENTIALS_DIR, `${channelId}.env`);
	if (!resolved.startsWith(CREDENTIALS_DIR + sep)) {
		throw new Error("Path traversal detected in channel ID");
	}
	return resolved;
}

/**
 * Format an env value, quoting if it contains special characters.
 */
function formatEnvValue(value: string): string {
	if (value.includes("\n") || value.includes('"') || value.includes(" ")) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

/**
 * Read credentials for a channel from its env file.
 * Returns an empty object if the file is missing.
 */
export function readChannelCredentials(
	channelId: string,
): Record<string, string> {
	return parseEnvFile(safeCredentialPath(channelId));
}

/**
 * Write credentials for a channel to its env file (mode 0600).
 */
export function writeChannelCredentials(
	channelId: string,
	vars: Record<string, string>,
): void {
	mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
	const content = Object.entries(vars)
		.map(([k, v]) => `${k}=${formatEnvValue(v)}`)
		.join("\n");
	writeFileSync(safeCredentialPath(channelId), `${content}\n`, {
		mode: 0o600,
	});
}

/**
 * Delete the credential file for a channel.
 * Ignores "file not found" but rethrows other errors.
 */
export function deleteChannelCredentials(channelId: string): void {
	try {
		unlinkSync(safeCredentialPath(channelId));
	} catch (err: unknown) {
		if (
			err instanceof Error &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code !== "ENOENT"
		) {
			throw err;
		}
	}
}
