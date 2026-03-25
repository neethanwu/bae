import { describe, expect, test } from "bun:test";
import { extractEmail, stripMarkdown } from "./channel.ts";

describe("stripMarkdown", () => {
	test("removes bold markers", () => {
		expect(stripMarkdown("**bold text**")).toBe("bold text");
	});

	test("removes underscore bold", () => {
		expect(stripMarkdown("__bold__")).toBe("bold");
	});

	test("removes italic markers without affecting bold", () => {
		expect(stripMarkdown("*italic*")).toBe("italic");
		expect(stripMarkdown("**bold**")).toBe("bold");
	});

	test("removes strikethrough", () => {
		expect(stripMarkdown("~~deleted~~")).toBe("deleted");
	});

	test("converts links to text (url) format", () => {
		expect(stripMarkdown("[Google](https://google.com)")).toBe(
			"Google (https://google.com)",
		);
	});

	test("removes heading markers", () => {
		expect(stripMarkdown("# Heading")).toBe("Heading");
		expect(stripMarkdown("## Sub")).toBe("Sub");
		expect(stripMarkdown("### Third")).toBe("Third");
		expect(stripMarkdown("###### Sixth")).toBe("Sixth");
	});

	test("handles mixed formatting", () => {
		const input = "**bold** and *italic* with [link](http://x.com)";
		const expected = "bold and italic with link (http://x.com)";
		expect(stripMarkdown(input)).toBe(expected);
	});

	test("passes through plain text unchanged", () => {
		expect(stripMarkdown("hello world")).toBe("hello world");
	});
});

describe("extractEmail", () => {
	test("returns bare email unchanged", () => {
		expect(extractEmail("user@example.com")).toBe("user@example.com");
	});

	test("extracts email from display name format", () => {
		expect(extractEmail("John Doe <john@example.com>")).toBe(
			"john@example.com",
		);
	});

	test("trims whitespace from bare email", () => {
		expect(extractEmail("  user@example.com  ")).toBe("user@example.com");
	});

	test("handles empty angle brackets by falling back to trimmed input", () => {
		expect(extractEmail("Name <>")).toBe("Name <>");
	});

	test("returns trimmed input for malformed string without angles", () => {
		expect(extractEmail("  not-an-email  ")).toBe("not-an-email");
	});
});
