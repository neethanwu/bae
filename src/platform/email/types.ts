// Email platform adapter types (AgentMail).
//
// Most types come directly from the `agentmail` SDK.
// This file holds email-adapter-specific types only.

/** Result of validating an AgentMail API key. */
export type ValidateResult =
	| { valid: true; inboxCount: number }
	| { valid: false };

/** Minimal inbox info returned after creation or listing. */
export interface InboxInfo {
	inboxId: string;
	email: string;
}
