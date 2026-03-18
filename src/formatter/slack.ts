/**
 * Slack mrkdwn formatter.
 *
 * Converts standard Markdown to Slack mrkdwn for non-streamed messages
 * (command responses, error messages). Streamed content uses the native
 * streaming API which accepts standard Markdown directly.
 *
 * Preserves code blocks and code spans — only transforms non-code content.
 */

/**
 * Convert standard Markdown to Slack mrkdwn.
 * Skips content inside code blocks and inline code spans.
 */
export function markdownToMrkdwn(md: string): string {
	// Extract code blocks and spans to protect them from transformation
	const codeBlocks: string[] = [];
	let processed = md.replace(/```[\s\S]*?```/g, (match) => {
		codeBlocks.push(match);
		return `\x00CB${codeBlocks.length - 1}\x00`;
	});

	const codeSpans: string[] = [];
	processed = processed.replace(/`[^`]+`/g, (match) => {
		codeSpans.push(match);
		return `\x00CS${codeSpans.length - 1}\x00`;
	});

	// Transform non-code content
	processed = processed
		// Bold: **text** or __text__ → *text*
		.replace(/\*\*(.+?)\*\*/g, "*$1*")
		.replace(/__(.+?)__/g, "*$1*")
		// Strikethrough: ~~text~~ → ~text~
		.replace(/~~(.+?)~~/g, "~$1~")
		// Links: [text](url) → <url|text>
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
		// Headers: # text → *text* (Slack has no native headers)
		.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

	// Restore code spans and blocks
	for (let i = codeSpans.length - 1; i >= 0; i--) {
		processed = processed.replace(`\x00CS${i}\x00`, codeSpans[i] ?? "");
	}
	for (let i = codeBlocks.length - 1; i >= 0; i--) {
		processed = processed.replace(`\x00CB${i}\x00`, codeBlocks[i] ?? "");
	}

	return processed;
}
