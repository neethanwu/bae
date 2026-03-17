import type { AgentEvent } from "./types.ts";

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
}

interface StreamEvent {
	type: string;
	index?: number;
	delta?: { type: string; text?: string };
	content_block?: { type: string; name?: string };
}

interface StreamMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	event?: StreamEvent;
	message?: { content?: ContentBlock[] };
	result?: string;
	cost_usd?: number;
}

/**
 * Transform a raw Claude Code JSONL object into zero or more AgentEvents.
 *
 * With `--include-partial-messages`, Claude Code emits incremental
 * `stream_event` lines wrapping the Anthropic API streaming protocol
 * (content_block_delta, content_block_start, etc.) followed by a
 * complete `assistant` message at the end of each turn.
 *
 * We prefer the incremental `stream_event` deltas for real-time streaming
 * and ignore the duplicate text in the final `assistant` message.
 */
export function transformClaudeEvent(
	raw: Record<string, unknown>,
): AgentEvent[] {
	const msg = raw as unknown as StreamMessage;
	if (typeof msg.type !== "string") return [];

	// Init event — extract session ID
	if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
		return [{ kind: "init", sessionId: msg.session_id }];
	}

	// Incremental streaming events (--include-partial-messages)
	if (msg.type === "stream_event" && msg.event) {
		const ev = msg.event;

		// Text delta — incremental text chunk
		if (
			ev.type === "content_block_delta" &&
			ev.delta?.type === "text_delta" &&
			typeof ev.delta.text === "string"
		) {
			return [{ kind: "text_delta", text: ev.delta.text }];
		}

		// Tool use start — tool name arrives in content_block_start
		if (
			ev.type === "content_block_start" &&
			ev.content_block?.type === "tool_use" &&
			typeof ev.content_block.name === "string"
		) {
			return [
				{
					kind: "tool_use",
					toolName: ev.content_block.name,
					input: {},
				},
			];
		}

		// All other stream events (message_start, content_block_stop, etc.)
		return [];
	}

	// Complete assistant message — when streaming is active, the text was
	// already delivered via stream_event deltas, so we skip it to avoid
	// duplicate delivery. Tool use blocks are also covered by stream_event.
	// This message is kept as a no-op so the result event handles finalization.
	if (msg.type === "assistant") {
		return [];
	}

	// Result event — turn complete
	if (msg.type === "result" && typeof msg.result === "string") {
		return [
			{
				kind: "result",
				text: msg.result,
				costUsd: typeof msg.cost_usd === "number" ? msg.cost_usd : undefined,
			},
		];
	}

	// Skip everything else (user, tool_result, system hooks, rate_limit_event, etc.)
	return [];
}
