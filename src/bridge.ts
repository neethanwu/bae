import { mkdirSync } from "node:fs";
import type { MessageData, Thread } from "chat";
import { ClaudeCodeExecutor } from "./executor/claude.ts";
import { SessionManager } from "./session/manager.ts";
import { SessionStore } from "./session/store.ts";

const MAX_RESPONSE_LENGTH = 4000;
const TYPING_INTERVAL_MS = 4_000; // Telegram typing expires after ~5s

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
console.log(`[bae] Workspace: ${CWD}`);
console.log(`[bae] Allowed users: ${ALLOWED_USERS.join(", ")}`);

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
	platform = "telegram",
): Promise<void> {
	const userId = message.author?.userId ?? "";
	if (!ALLOWED_USERS.includes(userId)) {
		console.log(`[bae] Rejected message from unauthorized user: ${userId}`);
		return;
	}

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
		console.log(`[bae] Session cleared for thread ${thread.id}`);
		await thread.post(
			"Session cleared. Next message starts a fresh conversation.",
		);
		return;
	}

	const startTime = Date.now();
	console.log(
		`[bae] <- ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`,
	);

	// Start typing indicator (repeat every 4s since Telegram expires it)
	await thread.startTyping().catch(() => {});
	const typingInterval = setInterval(() => {
		thread.startTyping().catch(() => {});
	}, TYPING_INTERVAL_MS);

	try {
		const events = await sessionManager.handleMessage(
			platform,
			thread.id,
			text,
		);

		let responseText = "";
		let toolCount = 0;

		for await (const event of events) {
			if (event.kind === "init") {
				console.log(`[bae] Session: ${event.sessionId}`);
			}
			if (event.kind === "text_delta") {
				responseText += event.text;
			}
			if (event.kind === "tool_use") {
				toolCount++;
				console.log(`[bae] Tool: ${event.toolName}`);
			}
			if (event.kind === "result") {
				if (!responseText && event.text) {
					responseText = event.text;
				}
				break;
			}
			if (event.kind === "error") {
				console.error(`[bae] Agent error: ${event.message}`);
				responseText = `Error: ${event.message}`;
				break;
			}
		}

		if (!responseText) {
			responseText = "(no response from agent)";
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		const truncated =
			responseText.length > MAX_RESPONSE_LENGTH
				? `${responseText.slice(0, MAX_RESPONSE_LENGTH)}\n\n... (truncated)`
				: responseText;

		await thread.post(truncated);
		console.log(
			`[bae] -> ${responseText.slice(0, 80)}${responseText.length > 80 ? "..." : ""} (${elapsed}s${toolCount > 0 ? `, ${toolCount} tools` : ""})`,
		);
	} catch (err) {
		console.error("[bae] Error:", err);
		await thread.post(
			"Something went wrong processing your message. Check the server logs for details.",
		);
	} finally {
		clearInterval(typingInterval);
	}
}
