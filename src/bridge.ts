import { mkdirSync } from "node:fs";
import type { MessageData, Thread } from "chat";
import { ClaudeCodeExecutor } from "./executor/claude.ts";
import { SessionManager } from "./session/manager.ts";
import { SessionStore } from "./session/store.ts";

const MAX_RESPONSE_LENGTH = 4000;

const CWD = process.env.BAE_CWD || `${process.env.HOME}/baesment`;
mkdirSync(CWD, { recursive: true });

if (!process.env.BAE_ALLOWED_USERS) {
	console.error(
		"[FATAL] BAE_ALLOWED_USERS is required. Set it to a comma-separated list of Telegram user IDs.",
	);
	process.exit(1);
}
const ALLOWED_USERS = process.env.BAE_ALLOWED_USERS.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
if (ALLOWED_USERS.length === 0) {
	console.error(
		"[FATAL] BAE_ALLOWED_USERS is empty. At least one user ID is required.",
	);
	process.exit(1);
}

// Initialize session stack
const store = new SessionStore();
const executor = new ClaudeCodeExecutor();
const sessionManager = new SessionManager(store, executor, CWD);

// Graceful shutdown
function shutdown() {
	console.log("[bae] Shutting down...");
	sessionManager.close();
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export async function handleMessage(
	thread: Thread,
	message: MessageData,
): Promise<void> {
	const userId = message.author?.userId ?? "";
	if (!ALLOWED_USERS.includes(userId)) return;

	const text = message.text;
	if (!text || text.trim() === "") {
		await thread.post("Only text messages are supported.");
		return;
	}

	// Commands
	if (text === "/start") {
		await thread.post(
			"Bae is ready. Send me a message and I'll pass it to your agent.",
		);
		return;
	}

	if (text === "/new") {
		sessionManager.clearSession("telegram", thread.id);
		await thread.post(
			"Session cleared. Next message starts a fresh conversation.",
		);
		return;
	}

	// Determine platform from thread metadata
	// For now, hardcode "telegram" — multi-platform routing comes in Phase 1c
	const platform = "telegram";

	try {
		const events = await sessionManager.handleMessage(
			platform,
			thread.id,
			text,
		);

		let responseText = "";

		for await (const event of events) {
			if (event.kind === "text_delta") {
				responseText += event.text;
			}
			if (event.kind === "result") {
				// Prefer result text if we got no text_delta events
				if (!responseText && event.text) {
					responseText = event.text;
				}
				break;
			}
			if (event.kind === "error") {
				responseText = `Error: ${event.message}`;
				break;
			}
		}

		if (!responseText) {
			responseText = "(no response from agent)";
		}

		const truncated =
			responseText.length > MAX_RESPONSE_LENGTH
				? `${responseText.slice(0, MAX_RESPONSE_LENGTH)}\n\n... (truncated)`
				: responseText;

		await thread.post(truncated);
	} catch (err) {
		console.error("[bridge] Error handling message:", err);
		await thread.post(
			"Something went wrong processing your message. Check the server logs for details.",
		);
	}
}
