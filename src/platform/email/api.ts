import { AgentMailClient } from "agentmail";
import type { InboxInfo, ValidateResult } from "./types.ts";

/**
 * Create an AgentMail client instance.
 */
export function createClient(apiKey: string): AgentMailClient {
	return new AgentMailClient({ apiKey });
}

/**
 * Validate an API key by attempting to list inboxes.
 * Returns the inbox count on success, or `{ valid: false }` on failure.
 */
export async function validateApiKey(apiKey: string): Promise<ValidateResult> {
	try {
		const client = createClient(apiKey);
		const resp = await client.inboxes.list();
		return { valid: true, inboxCount: resp.inboxes?.length ?? 0 };
	} catch {
		return { valid: false };
	}
}

/**
 * List all inboxes on the account.
 */
export async function listInboxes(
	client: AgentMailClient,
): Promise<InboxInfo[]> {
	const resp = await client.inboxes.list();
	return (resp.inboxes ?? []).map((inbox) => ({
		inboxId: inbox.inboxId,
		email: inbox.email,
	}));
}

/**
 * Create a new inbox, optionally with a specific username prefix.
 * Returns the inbox ID and full email address.
 */
export async function createInbox(
	client: AgentMailClient,
	username?: string,
): Promise<InboxInfo> {
	const inbox = await client.inboxes.create(
		username ? { username } : undefined,
	);
	return { inboxId: inbox.inboxId, email: inbox.email };
}
