/**
 * Platform-agnostic interfaces for the bridge layer.
 *
 * Each platform (Telegram, Slack, Discord, etc.) implements these interfaces
 * using its own SDK. The bridge operates exclusively on PlatformThread,
 * never on platform-specific types.
 */

/** A conversation thread on any platform. */
export interface PlatformThread {
	/** Platform-specific conversation identifier (Telegram: chat ID, Slack: DM channel ID). */
	readonly id: string;
	/** Post a text message. */
	post(text: string): Promise<void>;
	/** Post a streaming message. Chunks arrive as an async iterable. */
	postStream(chunks: AsyncIterable<string>): Promise<void>;
	/** Show a typing/working indicator (no-op if platform doesn't support it). */
	startTyping(): Promise<void>;
}

/** Per-platform configuration for the bridge's message handling. */
export interface PlatformConfig {
	/** Soft threshold — start looking for paragraph break splits. */
	splitSoft: number;
	/** Hard threshold — force split. */
	splitHard: number;
}

/** Runtime handle for a connected channel (polling, WebSocket, etc.). */
export interface ChannelHandle {
	start(): Promise<void>;
	stop(): Promise<void>;
}
