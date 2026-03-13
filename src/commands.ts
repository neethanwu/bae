import type { SessionManager } from "./session/manager.ts";

/**
 * Handle Bae-level commands that the agent can't handle itself.
 * Minimal by design — Bae is invisible infrastructure, not a chatbot.
 *
 * Returns a response string if the command was handled, or null to pass through to the agent.
 */
export async function handleCommand(
	text: string,
	sessionManager: SessionManager,
	platform: string,
	threadId: string,
): Promise<string | null> {
	// Telegram convention: /start is sent when user first opens the bot
	if (text === "/start") {
		return "Bae is ready. Send me a message and I'll pass it to your agent.";
	}

	// /new kills active process and clears the agent session
	if (text === "/new") {
		const wasActive = await sessionManager.interruptSession(platform, threadId);
		sessionManager.clearSession(platform, threadId);
		return wasActive
			? "Agent interrupted. Session cleared — next message starts fresh."
			: "Session cleared. Next message starts a fresh conversation.";
	}

	// Everything else goes to the agent
	return null;
}
