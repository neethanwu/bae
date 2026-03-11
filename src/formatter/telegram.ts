const MAX_LENGTH = 4096;
const SAFETY_MARGIN = 100;
const EFFECTIVE_LIMIT = MAX_LENGTH - SAFETY_MARGIN;

/**
 * Split a long message into chunks that fit Telegram's 4096-char limit.
 * Never splits inside a code fence. If a code block exceeds the limit,
 * splits at line boundaries within the fence with matching markers.
 */
export function splitMessage(text: string): string[] {
	if (text.length <= EFFECTIVE_LIMIT) return [text];

	const lines = text.split("\n");
	const chunks: string[] = [];
	let currentLines: string[] = [];
	let currentLength = 0;
	let inCodeFence = false;
	let fenceLanguage = "";

	function flushChunk() {
		if (currentLines.length === 0) return;
		chunks.push(currentLines.join("\n"));
		currentLines = [];
		currentLength = 0;
	}

	for (const line of lines) {
		const isFenceLine = line.startsWith("```");
		const lineLen = line.length + 1; // +1 for the newline join separator

		if (isFenceLine) {
			if (inCodeFence) {
				// Closing fence
				inCodeFence = false;
				if (currentLength + lineLen > EFFECTIVE_LIMIT) {
					currentLines.push("```");
					flushChunk();
					currentLines.push(`\`\`\`${fenceLanguage}`, line);
					currentLength = fenceLanguage.length + 3 + 1 + lineLen;
				} else {
					currentLines.push(line);
					currentLength += lineLen;
				}
				fenceLanguage = "";
				continue;
			}
			// Opening fence
			inCodeFence = true;
			fenceLanguage = line.slice(3).trim();
		}

		if (currentLength + lineLen <= EFFECTIVE_LIMIT) {
			currentLines.push(line);
			currentLength += lineLen;
			continue;
		}

		// Would exceed limit — need to split
		if (inCodeFence) {
			currentLines.push("```");
			flushChunk();
			currentLines.push(`\`\`\`${fenceLanguage}`, line);
			currentLength = fenceLanguage.length + 3 + 1 + lineLen;
		} else {
			flushChunk();
			currentLines.push(line);
			currentLength = lineLen;
		}
	}

	if (currentLines.length > 0) {
		if (inCodeFence) {
			currentLines.push("```");
		}
		flushChunk();
	}

	return chunks.map((c) => c.trimEnd());
}

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

function shortenPath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 3) return path;
	return `.../${parts.slice(-2).join("/")}`;
}

function truncate(str: string, maxLen: number): string {
	return str.length > maxLen ? `${str.slice(0, maxLen - 3)}...` : str;
}
