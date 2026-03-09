import type { MessageData, Thread } from "chat";
import { execute } from "./executor/claude.ts";

const MAX_RESPONSE_LENGTH = 4000;

const CWD = process.env.BAE_CWD || `${process.env.HOME}/bae-workspace`;

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

const activeThreads = new Set<string>();

export async function handleMessage(
	thread: Thread,
	message: MessageData,
): Promise<void> {
	// Security: reject unauthorized users
	const userId = message.author?.userId ?? "";
	if (!ALLOWED_USERS.includes(userId)) {
		return;
	}

	const text = message.text;

	// Guard: non-text or empty messages
	if (!text || text.trim() === "") {
		await thread.post("Only text messages are supported.");
		return;
	}

	// Guard: /start command
	if (text === "/start") {
		await thread.post(
			"Bae is ready. Send me a message and I'll pass it to Claude Code.",
		);
		return;
	}

	// Concurrency guard: one request per thread at a time
	const threadId = thread.id;
	if (activeThreads.has(threadId)) {
		await thread.post("Still processing your previous message, please wait.");
		return;
	}
	activeThreads.add(threadId);

	try {
		const response =
			(await execute(text, CWD)) || "(no response from Claude Code)";

		const truncated =
			response.length > MAX_RESPONSE_LENGTH
				? `${response.slice(0, MAX_RESPONSE_LENGTH)}\n\n... (truncated)`
				: response;

		await thread.post(truncated);
	} catch (err) {
		console.error("[bridge] Error handling message:", err);
		await thread.post(
			"Something went wrong processing your message. Check the server logs for details.",
		);
	} finally {
		activeThreads.delete(threadId);
	}
}
