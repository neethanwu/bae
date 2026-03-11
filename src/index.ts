/**
 * Public API facade for Bae.
 *
 * External consumers import from here.
 * CLI and bot entry points import internals directly.
 */

export type { BotHandle } from "./bot.ts";
export { createBot } from "./bot.ts";
export type { BridgeConfig, BridgeHandle } from "./bridge.ts";
export { createBridge } from "./bridge.ts";
export { ClaudeCodeExecutor } from "./executor/claude.ts";
export type {
	ExecuteOptions,
	ExecuteResult,
	Executor,
} from "./executor/types.ts";
export { SessionManager } from "./session/manager.ts";
export { SessionStore } from "./session/store.ts";
