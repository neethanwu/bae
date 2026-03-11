import { existsSync, readFileSync } from "node:fs";

/**
 * Parse .env content string into a key-value record.
 * Handles: comments, export prefix, quoted values.
 * Does NOT strip inline comments from quoted values.
 */
export function parseEnvContent(content: string): Record<string, string> {
	const config: Record<string, string> = {};
	for (const line of content.split("\n")) {
		let trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Strip 'export ' prefix
		if (trimmed.startsWith("export ")) trimmed = trimmed.slice(7);

		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let value = trimmed.slice(eqIdx + 1).trim();

		// Strip matching outer quotes (track whether quoted)
		let wasQuoted = false;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
			wasQuoted = true;
		}

		// Only strip inline comments from unquoted values
		if (!wasQuoted) {
			const commentIdx = value.indexOf(" #");
			if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
		}

		config[key] = value;
	}
	return config;
}

/**
 * Parse a .env file into a key-value record.
 */
export function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	return parseEnvContent(readFileSync(path, "utf-8"));
}

/**
 * Load a .env file into process.env (does not override existing vars).
 */
export function loadEnvFile(path: string): void {
	const config = parseEnvFile(path);
	for (const [key, value] of Object.entries(config)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}
