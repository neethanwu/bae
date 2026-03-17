import { describe, expect, test } from "bun:test";
import { transformClaudeEvent } from "./transformer.ts";

describe("transformClaudeEvent", () => {
	test("system init event", () => {
		const events = transformClaudeEvent({
			type: "system",
			subtype: "init",
			session_id: "abc-123",
		});
		expect(events).toEqual([{ kind: "init", sessionId: "abc-123" }]);
	});

	test("stream_event content_block_delta text", () => {
		const events = transformClaudeEvent({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				delta: { type: "text_delta", text: "Hello " },
			},
		});
		expect(events).toEqual([{ kind: "text_delta", text: "Hello " }]);
	});

	test("stream_event content_block_start tool_use", () => {
		const events = transformClaudeEvent({
			type: "stream_event",
			event: {
				type: "content_block_start",
				content_block: { type: "tool_use", name: "Read" },
			},
		});
		expect(events).toEqual([{ kind: "tool_use", toolName: "Read", input: {} }]);
	});

	test("stream_event message_start is ignored", () => {
		const events = transformClaudeEvent({
			type: "stream_event",
			event: { type: "message_start" },
		});
		expect(events).toEqual([]);
	});

	test("assistant message is skipped (duplicate of stream_event deltas)", () => {
		const events = transformClaudeEvent({
			type: "assistant",
			message: {
				content: [{ type: "text", text: "full response" }],
			},
		});
		expect(events).toEqual([]);
	});

	test("result event with cost", () => {
		const events = transformClaudeEvent({
			type: "result",
			result: "done",
			cost_usd: 0.01,
		});
		expect(events).toEqual([{ kind: "result", text: "done", costUsd: 0.01 }]);
	});

	test("result event without cost", () => {
		const events = transformClaudeEvent({
			type: "result",
			result: "done",
		});
		expect(events).toEqual([
			{ kind: "result", text: "done", costUsd: undefined },
		]);
	});

	test("user event is skipped", () => {
		expect(transformClaudeEvent({ type: "user" })).toEqual([]);
	});

	test("rate_limit_event is skipped", () => {
		expect(transformClaudeEvent({ type: "rate_limit_event" })).toEqual([]);
	});

	test("system hook events are skipped", () => {
		expect(
			transformClaudeEvent({ type: "system", subtype: "hook_started" }),
		).toEqual([]);
	});

	test("unknown type is skipped", () => {
		expect(transformClaudeEvent({ type: "unknown_thing" })).toEqual([]);
	});

	test("missing type is skipped", () => {
		expect(transformClaudeEvent({ foo: "bar" })).toEqual([]);
	});
});
