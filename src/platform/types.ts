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

/** A file or image attachment downloaded from a platform. */
export interface Attachment {
	filename: string;
	mimeType: string;
	data: Buffer;
}

/** Max single attachment size in bytes (10 MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Max total attachments size per message in bytes (20 MB). */
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Sanitize a filename to prevent path traversal and filesystem issues.
 * Strips path separators, limits length, replaces dangerous chars.
 */
export function sanitizeFilename(name: string): string {
	let safe = name
		.replace(/[/\\]/g, "_") // strip path separators
		.replace(/[^\w.-]/g, "_") // replace non-alphanumeric (except . - _)
		.replace(/_{2,}/g, "_") // collapse multiple underscores
		.replace(/^\.+/, "_"); // no leading dots (hidden files)
	if (safe.length > 200) {
		const ext = safe.lastIndexOf(".");
		if (ext > 0) {
			safe = safe.slice(0, 196) + safe.slice(ext);
		} else {
			safe = safe.slice(0, 200);
		}
	}
	return safe || "attachment";
}

/** Runtime handle for a connected channel (polling, WebSocket, etc.). */
export interface ChannelHandle {
	start(): Promise<void>;
	stop(): Promise<void>;
}
