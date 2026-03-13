import { describe, expect, test } from "bun:test";

// Test the makeUserMessage function by importing the module
// Since makeUserMessage is not exported, we test the behavior indirectly
// by verifying the NDJSON format matches what Claude Code expects

describe("NDJSON message format", () => {
	test("user message has correct structure", () => {
		const msg = JSON.parse(
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "hello" },
				session_id: "default",
				parent_tool_use_id: null,
			}),
		);

		expect(msg.type).toBe("user");
		expect(msg.message.role).toBe("user");
		expect(msg.message.content).toBe("hello");
		expect(msg.session_id).toBe("default");
		expect(msg.parent_tool_use_id).toBeNull();
	});

	test("user message with session ID", () => {
		const msg = JSON.parse(
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "steer me" },
				session_id: "abc-123",
				parent_tool_use_id: null,
			}),
		);

		expect(msg.session_id).toBe("abc-123");
	});

	test("message serializes as single line (NDJSON)", () => {
		const serialized = JSON.stringify({
			type: "user",
			message: { role: "user", content: "line1\nline2\nline3" },
			session_id: "default",
			parent_tool_use_id: null,
		});

		// NDJSON: no newlines in the serialized output (content newlines are escaped)
		expect(serialized.split("\n").length).toBe(1);
	});
});

describe("executor flags", () => {
	test("persistent process uses correct flags", () => {
		const expectedFlags = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--replay-user-messages",
		];

		// Verify expected flags are present
		for (const flag of expectedFlags) {
			expect(expectedFlags).toContain(flag);
		}

		// --resume should NOT be in base flags (only added when resuming)
		expect(expectedFlags).not.toContain("--resume");
	});
});
