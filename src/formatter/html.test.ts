import { describe, expect, test } from "bun:test";
import { markdownToTelegramHtml } from "./html.ts";

describe("markdownToTelegramHtml", () => {
	test("plain text passes through unchanged", () => {
		expect(markdownToTelegramHtml("hello world")).toBe("hello world");
	});

	test("escapes HTML entities", () => {
		expect(markdownToTelegramHtml("a < b > c & d")).toBe(
			"a &lt; b &gt; c &amp; d",
		);
	});

	test("converts bold", () => {
		expect(markdownToTelegramHtml("this is **bold** text")).toBe(
			"this is <b>bold</b> text",
		);
	});

	test("converts italic with asterisks", () => {
		expect(markdownToTelegramHtml("this is *italic* text")).toBe(
			"this is <i>italic</i> text",
		);
	});

	test("converts italic with underscores", () => {
		expect(markdownToTelegramHtml("this is _italic_ text")).toBe(
			"this is <i>italic</i> text",
		);
	});

	test("converts strikethrough", () => {
		expect(markdownToTelegramHtml("this is ~~deleted~~ text")).toBe(
			"this is <s>deleted</s> text",
		);
	});

	test("converts inline code", () => {
		expect(markdownToTelegramHtml("use `console.log()` here")).toBe(
			"use <code>console.log()</code> here",
		);
	});

	test("inline code escapes HTML inside", () => {
		expect(markdownToTelegramHtml("use `<div>` tag")).toBe(
			"use <code>&lt;div&gt;</code> tag",
		);
	});

	test("converts fenced code blocks", () => {
		const input = "before\n```js\nconst x = 1;\n```\nafter";
		const expected =
			'before\n<pre><code class="language-js">const x = 1;</code></pre>\nafter';
		expect(markdownToTelegramHtml(input)).toBe(expected);
	});

	test("code blocks escape HTML inside", () => {
		const input = "```\n<div>hello</div>\n```";
		expect(markdownToTelegramHtml(input)).toBe(
			"<pre><code>&lt;div&gt;hello&lt;/div&gt;</code></pre>",
		);
	});

	test("code blocks suppress inner formatting", () => {
		const input = "```\n**not bold** and *not italic*\n```";
		expect(markdownToTelegramHtml(input)).toBe(
			"<pre><code>**not bold** and *not italic*</code></pre>",
		);
	});

	test("converts links", () => {
		expect(markdownToTelegramHtml("visit [Google](https://google.com)")).toBe(
			'visit <a href="https://google.com">Google</a>',
		);
	});

	test("converts blockquotes", () => {
		const input = "> this is a quote";
		const result = markdownToTelegramHtml(input);
		expect(result).toContain("<blockquote>");
		expect(result).toContain("this is a quote");
		expect(result).toContain("</blockquote>");
	});

	test("bold and italic together", () => {
		expect(markdownToTelegramHtml("**bold** and *italic*")).toBe(
			"<b>bold</b> and <i>italic</i>",
		);
	});

	test("does not treat underscores in words as italic", () => {
		expect(markdownToTelegramHtml("snake_case_var")).toBe("snake_case_var");
	});

	test("multiple code blocks in one message", () => {
		const input = "first:\n```\na\n```\nsecond:\n```\nb\n```";
		const result = markdownToTelegramHtml(input);
		expect(result).toContain("<pre><code>a</code></pre>");
		expect(result).toContain("<pre><code>b</code></pre>");
	});

	test("mixed formatting in a realistic LLM response", () => {
		const input = [
			"Here's the fix:",
			"",
			"```typescript",
			'const x = "hello";',
			"```",
			"",
			"Use `x` in your **main** function.",
		].join("\n");

		const result = markdownToTelegramHtml(input);
		expect(result).toContain(
			'<pre><code class="language-typescript">const x = "hello";</code></pre>',
		);
		expect(result).toContain("<code>x</code>");
		expect(result).toContain("<b>main</b>");
	});
});
