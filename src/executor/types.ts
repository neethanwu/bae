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
	/** Write a steering message to the running agent (persistent process only). */
	send?(text: string): void;
	/** Interrupt the current agent turn (persistent process only). */
	interrupt?(): Promise<void>;
}

export interface Executor {
	execute(options: ExecuteOptions): ExecuteResult;
}
