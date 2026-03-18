/**
 * Public API facade for Bae.
 *
 * External consumers import from here.
 * CLI and channel entry points import internals directly.
 */

export type { BridgeConfig, BridgeHandle } from "./bridge.ts";
export { createBridge } from "./bridge.ts";
export type { ChannelHandle, CreateChannelOptions } from "./channel.ts";
export { createChannel } from "./channel.ts";
export { ClaudeCodeExecutor } from "./executor/claude.ts";
export type {
	ExecuteOptions,
	ExecuteResult,
	Executor,
} from "./executor/types.ts";
export type {
	ChannelHandle as PlatformChannelHandle,
	PlatformConfig,
	PlatformThread,
} from "./platform/types.ts";
export { SessionManager } from "./session/manager.ts";
export { Store } from "./session/store.ts";
export type {
	Channel,
	ExecutorType,
	Platform,
	Session,
	Workspace,
} from "./session/types.ts";
