import { describe, expect, test } from "bun:test";
import { stripMarkdown } from "./imessage.ts";

describe("stripMarkdown", () => {
	test("removes bold markers", () => {
		expect(stripMarkdown("**bold text**")).toBe("bold text");
		expect(stripMarkdown("__also bold__")).toBe("also bold");
	});

	test("removes strikethrough", () => {
		expect(stripMarkdown("~~deleted~~")).toBe("deleted");
	});

	test("converts links to text (url) format", () => {
		expect(stripMarkdown("[Google](https://google.com)")).toBe(
			"Google (https://google.com)",
		);
	});

	test("removes header markers", () => {
		expect(stripMarkdown("# Heading 1")).toBe("Heading 1");
		expect(stripMarkdown("## Heading 2")).toBe("Heading 2");
		expect(stripMarkdown("### Heading 3")).toBe("Heading 3");
	});

	test("preserves code blocks", () => {
		const input = "```\nconst x = 42;\n```";
		expect(stripMarkdown(input)).toBe("```\nconst x = 42;\n```");
	});

	test("preserves inline code", () => {
		expect(stripMarkdown("use `const x = 1`")).toBe("use `const x = 1`");
	});

	test("handles mixed formatting", () => {
		const input = "**bold** and ~~strike~~ and [link](https://example.com)";
		expect(stripMarkdown(input)).toBe(
			"bold and strike and link (https://example.com)",
		);
	});

	test("passes through plain text unchanged", () => {
		expect(stripMarkdown("just plain text")).toBe("just plain text");
	});

	test("preserves blockquotes", () => {
		expect(stripMarkdown("> quoted text")).toBe("> quoted text");
	});

	test("preserves lists", () => {
		expect(stripMarkdown("- item 1\n- item 2")).toBe("- item 1\n- item 2");
	});
});
