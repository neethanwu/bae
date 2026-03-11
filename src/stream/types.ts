/**
 * Unified event types that flow from executor → session manager → bridge → formatter.
 * Each AgentEvent represents one discrete thing that happened in the agent's stream.
 */
export type AgentEvent =
	| { kind: "init"; sessionId: string }
	| { kind: "text_delta"; text: string }
	| { kind: "tool_use"; toolName: string; input: Record<string, unknown> }
	| {
			kind: "result";
			text: string;
			costUsd?: number;
	  }
	| { kind: "error"; message: string };
