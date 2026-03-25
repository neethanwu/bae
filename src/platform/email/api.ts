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
 * Build the display name string for an inbox.
 * AgentMail format: "Display Name <username@domain.com>"
 */
function buildDisplayName(workspaceSlug: string, email: string): string {
	const label = `Bae from ${workspaceSlug}`;
	return `${label} <${email}>`;
}

/**
 * Create a new inbox, optionally with a specific username prefix.
 * Sets display name to "Bae from <workspace> <addr>" for friendly sender identity.
 * Returns the inbox ID and full email address.
 */
export async function createInbox(
	client: AgentMailClient,
	username?: string,
	workspaceSlug?: string,
): Promise<InboxInfo> {
	// Create first to get the email address, then update display name
	const inbox = await client.inboxes.create({
		...(username ? { username } : {}),
	});
	// Now set display name with the actual email address
	if (workspaceSlug) {
		try {
			const displayName = buildDisplayName(workspaceSlug, inbox.email);
			await client.inboxes.update(inbox.inboxId, { displayName });
		} catch {
			// Best effort — inbox is created regardless
		}
	}
	return { inboxId: inbox.inboxId, email: inbox.email };
}

/**
 * Ensure an existing inbox has the correct display name.
 * Call on channel start to fix inboxes created before this feature.
 */
export async function ensureDisplayName(
	client: AgentMailClient,
	inboxId: string,
	workspaceSlug: string,
): Promise<void> {
	try {
		const inbox = await client.inboxes.get(inboxId);
		const expected = buildDisplayName(workspaceSlug, inbox.email);
		if (inbox.displayName !== expected) {
			await client.inboxes.update(inboxId, { displayName: expected });
			console.log(`[bae:email] Updated inbox display name to "${expected}"`);
		}
	} catch {
		// Best effort — don't block startup
	}
}
