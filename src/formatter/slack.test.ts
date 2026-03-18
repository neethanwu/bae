import { describe, expect, test } from "bun:test";
import { markdownToMrkdwn } from "./slack.ts";

describe("markdownToMrkdwn", () => {
	test("converts bold", () => {
		expect(markdownToMrkdwn("**hello**")).toBe("*hello*");
		expect(markdownToMrkdwn("__hello__")).toBe("*hello*");
	});

	test("converts strikethrough", () => {
		expect(markdownToMrkdwn("~~deleted~~")).toBe("~deleted~");
	});

	test("converts links", () => {
		expect(markdownToMrkdwn("[Google](https://google.com)")).toBe(
			"<https://google.com|Google>",
		);
	});

	test("converts headers to bold", () => {
		expect(markdownToMrkdwn("# Heading 1")).toBe("*Heading 1*");
		expect(markdownToMrkdwn("## Heading 2")).toBe("*Heading 2*");
		expect(markdownToMrkdwn("### Heading 3")).toBe("*Heading 3*");
	});

	test("preserves code blocks", () => {
		const input = "text **bold** ```\nconst **x** = 1;\n``` after **bold**";
		const result = markdownToMrkdwn(input);
		expect(result).toContain("```\nconst **x** = 1;\n```");
		expect(result).toContain("text *bold*");
		expect(result).toContain("after *bold*");
	});

	test("preserves inline code", () => {
		const input = "use `**not bold**` in your code";
		const result = markdownToMrkdwn(input);
		// The ** inside backticks should NOT be converted to single *
		expect(result).toContain("`**not bold**`");
		// Outside of code, ** should be converted
		expect(markdownToMrkdwn("**bold** and `**code**`")).toBe(
			"*bold* and `**code**`",
		);
	});

	test("handles mixed formatting", () => {
		const input = "**bold** and ~~strike~~ and [link](https://example.com)";
		const result = markdownToMrkdwn(input);
		expect(result).toBe("*bold* and ~strike~ and <https://example.com|link>");
	});

	test("passes through plain text unchanged", () => {
		expect(markdownToMrkdwn("just plain text")).toBe("just plain text");
	});

	test("passes through blockquotes unchanged", () => {
		expect(markdownToMrkdwn("> quoted text")).toBe("> quoted text");
	});

	test("passes through lists unchanged", () => {
		expect(markdownToMrkdwn("- item 1\n- item 2")).toBe("- item 1\n- item 2");
	});
});
