import { describe, expect, test } from "bun:test";
import { parseEnvContent } from "./env.ts";

describe("parseEnvContent", () => {
	test("parses basic KEY=VALUE", () => {
		expect(parseEnvContent("FOO=bar")).toEqual({ FOO: "bar" });
	});

	test("parses multiple lines", () => {
		const content = "A=1\nB=2\nC=3";
		expect(parseEnvContent(content)).toEqual({ A: "1", B: "2", C: "3" });
	});

	test("skips empty lines and comments", () => {
		const content = "# comment\n\nFOO=bar\n  # indented comment\nBAZ=qux";
		expect(parseEnvContent(content)).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	test("handles export prefix", () => {
		expect(parseEnvContent("export FOO=bar")).toEqual({ FOO: "bar" });
	});

	test("strips double quotes", () => {
		expect(parseEnvContent('FOO="hello world"')).toEqual({
			FOO: "hello world",
		});
	});

	test("strips single quotes", () => {
		expect(parseEnvContent("FOO='hello world'")).toEqual({
			FOO: "hello world",
		});
	});

	test("preserves # inside quoted values", () => {
		expect(parseEnvContent('FOO="value with # hash"')).toEqual({
			FOO: "value with # hash",
		});
	});

	test("strips inline comments from unquoted values", () => {
		expect(parseEnvContent("FOO=bar # this is a comment")).toEqual({
			FOO: "bar",
		});
	});

	test("handles empty values", () => {
		expect(parseEnvContent("FOO=")).toEqual({ FOO: "" });
	});

	test("handles values with = sign", () => {
		expect(parseEnvContent("FOO=bar=baz")).toEqual({ FOO: "bar=baz" });
	});

	test("skips lines without =", () => {
		expect(parseEnvContent("INVALID\nFOO=bar")).toEqual({ FOO: "bar" });
	});

	test("trims whitespace around keys and values", () => {
		expect(parseEnvContent("  FOO  =  bar  ")).toEqual({ FOO: "bar" });
	});

	test("handles real bae .env format", () => {
		const content = [
			"TELEGRAM_BOT_TOKEN=123456:ABC-DEF",
			"BAE_ALLOWED_USERS=111,222",
			"BAE_CWD=/Users/test/baesment",
			"BAE_PORT=3456",
		].join("\n");

		expect(parseEnvContent(content)).toEqual({
			TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
			BAE_ALLOWED_USERS: "111,222",
			BAE_CWD: "/Users/test/baesment",
			BAE_PORT: "3456",
		});
	});
});
