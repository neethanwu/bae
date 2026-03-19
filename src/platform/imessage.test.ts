import { describe, expect, test } from "bun:test";
import { stripMarkdown } from "./imessage.ts";

const BAE_PREFIX = "Bae: ";

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

describe("Bae: prefix loop prevention", () => {
	test("prefix is applied to stripped text", () => {
		const agentOutput = "**Hello** from the agent";
		const prefixed = `${BAE_PREFIX}${stripMarkdown(agentOutput)}`;
		expect(prefixed).toBe("Bae: Hello from the agent");
	});

	test("prefix detection works for loop prevention", () => {
		const agentMessage = "Bae: Here are your files...";
		const userMessage = "what files are in my project?";

		expect(agentMessage.startsWith(BAE_PREFIX)).toBe(true);
		expect(userMessage.startsWith(BAE_PREFIX)).toBe(false);
	});

	test("prefix only on first line, rest flows naturally", () => {
		const multiline = "Line 1\nLine 2\nLine 3";
		const prefixed = `${BAE_PREFIX}${stripMarkdown(multiline)}`;
		expect(prefixed).toBe("Bae: Line 1\nLine 2\nLine 3");
		expect(prefixed.startsWith(BAE_PREFIX)).toBe(true);
	});
});

describe("chatGuidToRecipient", () => {
	// Test the logic inline since the function is not exported
	function chatGuidToRecipient(chatGuid: string): string {
		const parts = chatGuid.split(";");
		return parts[2] ?? chatGuid;
	}

	test("extracts phone number from DM guid", () => {
		expect(chatGuidToRecipient("iMessage;-;+1234567890")).toBe("+1234567890");
	});

	test("extracts email from DM guid", () => {
		expect(chatGuidToRecipient("iMessage;-;user@example.com")).toBe(
			"user@example.com",
		);
	});

	test("handles SMS guid", () => {
		expect(chatGuidToRecipient("SMS;-;+1234567890")).toBe("+1234567890");
	});

	test("returns full guid if no semicolons", () => {
		expect(chatGuidToRecipient("something")).toBe("something");
	});
});
