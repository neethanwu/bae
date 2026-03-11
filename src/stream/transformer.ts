import type { AgentEvent } from "./types.ts";

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
}

interface StreamMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	message?: { content?: ContentBlock[] };
	result?: string;
	cost_usd?: number;
}

/**
 * Transform a raw Claude Code JSONL object into zero or more AgentEvents.
 * Returns an array because one JSONL line (e.g. assistant message) can contain
 * multiple content blocks (text + tool_use in the same message).
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

	// Assistant message — emit text_delta and tool_use for each content block
	if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
		const events: AgentEvent[] = [];
		for (const block of msg.message.content) {
			if (block.type === "text" && typeof block.text === "string") {
				events.push({ kind: "text_delta", text: block.text });
			}
			if (block.type === "tool_use" && typeof block.name === "string") {
				const input =
					block.input != null && typeof block.input === "object"
						? (block.input as Record<string, unknown>)
						: {};
				events.push({
					kind: "tool_use",
					toolName: block.name,
					input,
				});
			}
		}
		return events;
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

	// Skip everything else (user, tool_result, system hooks, etc.)
	return [];
}
