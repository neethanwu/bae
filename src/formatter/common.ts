/**
 * Platform-agnostic formatting utilities.
 * Used for console logging and shared display logic.
 */

const TOOL_NAMES: Record<string, string> = {
	Read: "Reading",
	Write: "Writing",
	Edit: "Editing",
	Bash: "Running",
	Glob: "Searching",
	Grep: "Searching",
	WebSearch: "Searching web",
	WebFetch: "Fetching",
	Agent: "Delegating",
};

/**
 * Format a tool use event into a human-readable status string.
 */
export function formatToolStatus(
	toolName: string,
	input: Record<string, unknown>,
): string {
	const prefix = TOOL_NAMES[toolName] ?? `Using ${toolName}`;

	if (input.file_path) {
		return `${prefix} ${shortenPath(String(input.file_path))}`;
	}
	if (input.command) {
		return `${prefix}: ${truncate(String(input.command), 60)}`;
	}
	if (input.pattern) {
		return `${prefix} for "${truncate(String(input.pattern), 40)}"`;
	}
	return `${prefix}...`;
}

/**
 * Format a metadata footer for the final message.
 */
export function formatMetadata(durationMs: number, costUsd?: number): string {
	const durationStr =
		durationMs < 1000
			? `${durationMs}ms`
			: `${(durationMs / 1000).toFixed(1)}s`;
	const costStr = costUsd && costUsd > 0 ? ` · $${costUsd.toFixed(4)}` : "";
	return `\n\n✓ Done (${durationStr}${costStr})`;
}

export function shortenPath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 3) return path;
	return `.../${parts.slice(-2).join("/")}`;
}

export function truncate(str: string, maxLen: number): string {
	return str.length > maxLen ? `${str.slice(0, maxLen - 3)}...` : str;
}
