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
 * Build the display name for an inbox.
 * AgentMail display_name is a plain string (no angle brackets or email).
 */
function buildDisplayName(workspaceSlug: string): string {
	return `Bae from ${workspaceSlug}`;
}

/**
 * Create a new inbox, optionally with a specific username prefix.
 * Sets display name to "Bae from <workspace>" for friendly sender identity.
 * Returns the inbox ID and full email address.
 */
export async function createInbox(
	client: AgentMailClient,
	username?: string,
	workspaceSlug?: string,
): Promise<InboxInfo> {
	const displayName = workspaceSlug
		? buildDisplayName(workspaceSlug)
		: undefined;
	const inbox = await client.inboxes.create({
		...(username ? { username } : {}),
		...(displayName ? { displayName } : {}),
	});
	return { inboxId: inbox.inboxId, email: inbox.email };
}
