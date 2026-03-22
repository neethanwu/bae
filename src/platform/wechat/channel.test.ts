import { describe, expect, test } from "bun:test";
import { extractText, stripMarkdown } from "./channel.ts";
import { MessageItemType } from "./types.ts";

describe("stripMarkdown", () => {
	test("removes bold markers", () => {
		expect(stripMarkdown("**bold text**")).toBe("bold text");
	});

	test("removes underscore bold", () => {
		expect(stripMarkdown("__bold__")).toBe("bold");
	});

	test("removes italic markers", () => {
		expect(stripMarkdown("*italic*")).toBe("italic");
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
		expect(stripMarkdown("## Heading")).toBe("Heading");
		expect(stripMarkdown("### Sub")).toBe("Sub");
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

describe("extractText", () => {
	test("returns empty string for undefined items", () => {
		expect(extractText(undefined)).toBe("");
	});

	test("returns empty string for empty array", () => {
		expect(extractText([])).toBe("");
	});

	test("extracts text from TEXT item", () => {
		const items = [
			{ type: MessageItemType.TEXT, text_item: { text: "hello" } },
		];
		expect(extractText(items)).toBe("hello");
	});

	test("extracts voice transcription as fallback", () => {
		const items = [
			{ type: MessageItemType.VOICE, voice_item: { text: "transcribed" } },
		];
		expect(extractText(items)).toBe("transcribed");
	});

	test("prefers TEXT over VOICE", () => {
		const items = [
			{ type: MessageItemType.VOICE, voice_item: { text: "voice" } },
			{ type: MessageItemType.TEXT, text_item: { text: "text" } },
		];
		expect(extractText(items)).toBe("text");
	});

	test("returns empty for image-only message", () => {
		const items = [{ type: MessageItemType.IMAGE }];
		expect(extractText(items)).toBe("");
	});

	test("returns empty when text_item has no text", () => {
		const items = [{ type: MessageItemType.TEXT, text_item: {} }];
		expect(extractText(items)).toBe("");
	});
});
