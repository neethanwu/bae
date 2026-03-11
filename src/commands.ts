import type { SessionManager } from "./session/manager.ts";

/**
 * Handle Bae-level commands that the agent can't handle itself.
 * Minimal by design — Bae is invisible infrastructure, not a chatbot.
 *
 * Returns a response string if the command was handled, or null to pass through to the agent.
 */
export function handleCommand(
	text: string,
	sessionManager: SessionManager,
	platform: string,
	threadId: string,
): string | null {
	// Telegram convention: /start is sent when user first opens the bot
	if (text === "/start") {
		return "Bae is ready. Send me a message and I'll pass it to your agent.";
	}

	// /new clears the agent session — this must live at the Bae level
	// because the agent can't clear its own session ID from Bae's store
	if (text === "/new") {
		sessionManager.clearSession(platform, threadId);
		return "Session cleared. Next message starts a fresh conversation.";
	}

	// Everything else goes to the agent
	return null;
}
