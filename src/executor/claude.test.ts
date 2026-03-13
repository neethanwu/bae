import { describe, expect, test } from "bun:test";
import { makeUserMessage } from "./claude.ts";

describe("makeUserMessage", () => {
	test("default session ID is 'default'", () => {
		const msg = JSON.parse(makeUserMessage("hello"));
		expect(msg.type).toBe("user");
		expect(msg.message).toEqual({ role: "user", content: "hello" });
		expect(msg.session_id).toBe("default");
		expect(msg.parent_tool_use_id).toBeNull();
	});

	test("uses provided session ID", () => {
		const msg = JSON.parse(makeUserMessage("hi", "abc-123"));
		expect(msg.session_id).toBe("abc-123");
	});

	test("serializes as single NDJSON line (no embedded newlines)", () => {
		const serialized = makeUserMessage("line1\nline2\nline3");
		expect(serialized.includes("\n")).toBe(false);
	});

	test("handles special characters in content", () => {
		const msg = JSON.parse(makeUserMessage('he said "hello" & <world>'));
		expect(msg.message.content).toBe('he said "hello" & <world>');
	});
});
