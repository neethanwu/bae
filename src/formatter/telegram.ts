// Re-export shared formatters for backward compatibility
export { formatMetadata, formatToolStatus } from "./common.ts";

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
