import { customAlphabet } from "nanoid";

// --- Union types for compile-time exhaustiveness ---

export type ExecutorType = "claude-code";
// Phase 3: "claude-code" | "codex" | "opencode"

export type Platform = "telegram" | "slack" | "imessage";
// Future: | "discord" | "email"

// --- Domain interfaces (public API) ---

export interface Workspace {
	id: string;
	name: string;
	path: string;
	executor: ExecutorType;
	createdAt: string;
	updatedAt: string;
}

export interface Channel {
	id: string;
	workspaceId: string;
	platform: Platform;
	label: string | null;
	allowedUsers: string[];
	createdAt: string;
	updatedAt: string;
}

export interface Session {
	id: number;
	channelId: string;
	conversationId: string;
	agentSessionId: string | null;
	status: "idle" | "running";
	createdAt: string;
	updatedAt: string;
}

// --- DB row types (snake_case, internal to store) ---

export interface WorkspaceRow {
	id: string;
	name: string;
	path: string;
	executor: string;
	created_at: string;
	updated_at: string;
}

export interface ChannelRow {
	id: string;
	workspace_id: string;
	platform: string;
	label: string | null;
	allowed_users: string;
	created_at: string;
	updated_at: string;
}

export interface SessionRow {
	id: number;
	channel_id: string;
	conversation_id: string;
	agent_session_id: string | null;
	status: string;
	created_at: string;
	updated_at: string;
}

// --- Row converters with runtime validation ---

function assertStatus(s: string): "idle" | "running" {
	if (s === "idle" || s === "running") return s;
	throw new Error(`Invalid session status: ${s}`);
}

export function toWorkspace(row: WorkspaceRow): Workspace {
	return {
		id: row.id,
		name: row.name,
		path: row.path,
		executor: row.executor as ExecutorType,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function toChannel(row: ChannelRow): Channel {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		platform: row.platform as Platform,
		label: row.label,
		allowedUsers: row.allowed_users
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function toSession(row: SessionRow): Session {
	return {
		id: row.id,
		channelId: row.channel_id,
		conversationId: row.conversation_id,
		agentSessionId: row.agent_session_id,
		status: assertStatus(row.status),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// --- Channel ID generation ---

const generateId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export function channelId(): string {
	return `chan_${generateId()}`;
}
