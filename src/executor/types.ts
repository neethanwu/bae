import type { AgentEvent } from "../stream/types.ts";

export interface ExecuteOptions {
	prompt: string;
	cwd: string;
	resumeSessionId?: string;
	timeout?: number;
}

export interface ExecuteResult {
	events: AsyncIterable<AgentEvent>;
	sessionId: Promise<string>;
	kill(): Promise<void>;
}

export interface Executor {
	readonly name: string;
	execute(options: ExecuteOptions): ExecuteResult;
}
