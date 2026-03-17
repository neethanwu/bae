/**
 * Convert markdown text to Telegram-compatible HTML.
 *
 * Telegram Bot API supports a subset of HTML tags:
 * <b>, <i>, <s>, <code>, <pre>, <a>, <blockquote>
 *
 * Conversion order matters — HTML entities must be escaped FIRST,
 * then code blocks extracted (to prevent inner formatting), then
 * inline formatting applied to the remaining text.
 */

// Placeholder markers for code extraction (unique enough to never appear in text)
const CODE_MARKER = "\u{FFFF}CODE";
const INLINE_MARKER = "\u{FFFF}INLINE";
const MARKER_END = "\u{FFFF}";

export function markdownToTelegramHtml(text: string): string {
	// Extract fenced code blocks before any processing
	const codeBlocks: string[] = [];
	let result = text.replace(
		/```(\w*)\n([\s\S]*?)```/g,
		(_match, lang: string, code: string) => {
			const escaped = escapeHtml(code.replace(/\n$/, ""));
			const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
			codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
			return `${CODE_MARKER}${codeBlocks.length - 1}${MARKER_END}`;
		},
	);

	// Handle unclosed code fence (common during streaming — opening ``` arrived
	// but closing ``` hasn't yet). Treat everything after it as code.
	const unclosedMatch = result.match(/```(\w*)\n([\s\S]*)$/);
	if (unclosedMatch?.[2] != null) {
		const [fullMatch, lang = "", code] = unclosedMatch;
		const escaped = escapeHtml(code.replace(/\n$/, ""));
		const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
		codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
		result =
			result.slice(0, result.length - fullMatch.length) +
			`${CODE_MARKER}${codeBlocks.length - 1}${MARKER_END}`;
	}

	// Extract inline code before escaping (content inside backticks is literal)
	const inlineCodes: string[] = [];
	result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
		inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
		return `${INLINE_MARKER}${inlineCodes.length - 1}${MARKER_END}`;
	});

	// Convert headings: strip markers, bold is applied below via **
	result = result.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

	// Convert horizontal rules to a visual separator
	result = result.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, "———");

	// Protect bullet markers from italic regex: * item should not become italic
	// Replace leading * with • before escapeHtml (which runs before italic conversion)
	result = result.replace(/^(\s*)\* /gm, "$1• ");

	// Convert image references to links: ![alt](url) → [alt](url)
	result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)");

	// Escape HTML entities in remaining text
	result = escapeHtml(result);

	// Convert links: [text](url) → <a href="url">text</a>
	result = result.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		(_match, linkText: string, url: string) =>
			`<a href="${url}">${linkText}</a>`,
	);

	// Convert bold: **text** → <b>text</b>
	result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

	// Convert strikethrough: ~~text~~ → <s>text</s>
	result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// Convert italic: *text* → <i>text</i> (after bold, so ** is consumed first)
	result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");

	// Convert italic: _text_ → <i>text</i> (word-boundary aware to avoid false matches)
	result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

	// Convert blockquotes: lines starting with > → <blockquote>
	result = result.replace(/(?:^|\n)(?:&gt; (.+?)(?:\n|$))+/g, (match) => {
		const lines = match
			.trim()
			.split("\n")
			.map((line) => line.replace(/^&gt; /, ""));
		return `\n<blockquote>${lines.join("\n")}</blockquote>\n`;
	});

	// Restore inline code placeholders
	const inlineRe = new RegExp(`${INLINE_MARKER}(\\d+)${MARKER_END}`, "g");
	result = result.replace(
		inlineRe,
		(_match, index: string) => inlineCodes[Number(index)] ?? "",
	);

	// Restore code block placeholders
	const codeRe = new RegExp(`${CODE_MARKER}(\\d+)${MARKER_END}`, "g");
	result = result.replace(
		codeRe,
		(_match, index: string) => codeBlocks[Number(index)] ?? "",
	);

	return result.trim();
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
