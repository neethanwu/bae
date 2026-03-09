import { parseJSONLStream } from "../stream/parser.ts";

interface ContentBlock {
	type: string;
	text?: string;
}

type ClaudeStreamMessage =
	| { type: "system"; subtype: "init"; session_id: string }
	| { type: "assistant"; message: { content: ContentBlock[] } }
	| { type: "result"; result: string }
	| { type: string };

function isClaudeStreamMessage(
	raw: Record<string, unknown>,
): raw is ClaudeStreamMessage {
	return typeof raw.type === "string";
}

function isAssistantMessage(
	msg: ClaudeStreamMessage,
): msg is { type: "assistant"; message: { content: ContentBlock[] } } {
	return (
		msg.type === "assistant" &&
		"message" in msg &&
		typeof msg.message === "object" &&
		msg.message !== null &&
		"content" in msg.message &&
		Array.isArray(msg.message.content)
	);
}

function isResultMessage(
	msg: ClaudeStreamMessage,
): msg is { type: "result"; result: string } {
	return (
		msg.type === "result" && "result" in msg && typeof msg.result === "string"
	);
}

/**
 * Spawn claude -p with the given prompt and collect the response.
 * Phase 0: prompt as CLI argument, new process per message.
 */
export async function execute(prompt: string, cwd: string): Promise<string> {
	const proc = Bun.spawn(
		[
			"claude",
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--",
			prompt,
		],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const TIMEOUT_MS = 120_000;
	const SIGKILL_DELAY_MS = 5_000;
	let timedOut = false;
	let killTimeout: ReturnType<typeof setTimeout> | undefined;

	const timeout = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		killTimeout = setTimeout(() => {
			proc.kill("SIGKILL");
		}, SIGKILL_DELAY_MS);
	}, TIMEOUT_MS);

	// Log stderr in the background
	const stderrReader = new Response(proc.stderr).text().then((text) => {
		if (text.trim()) {
			console.error("[claude stderr]", text.trim());
		}
	});

	let assistantText = "";
	let resultText = "";

	try {
		for await (const raw of parseJSONLStream(proc.stdout)) {
			if (!isClaudeStreamMessage(raw)) continue;
			const msg = raw;

			// Accumulate assistant text blocks
			if (isAssistantMessage(msg)) {
				for (const block of msg.message.content) {
					if (block.type === "text" && typeof block.text === "string") {
						assistantText += block.text;
					}
				}
			}

			// Prefer result.result as the clean final summary
			if (isResultMessage(msg)) {
				resultText = msg.result;
				break;
			}
		}
	} finally {
		clearTimeout(timeout);
		if (killTimeout !== undefined) {
			clearTimeout(killTimeout);
		}
		await stderrReader.catch(() => {});
		await proc.exited;
	}

	const exitCode = proc.exitCode;
	if (timedOut && !resultText && !assistantText) {
		throw new Error("Claude Code timed out after 120 seconds");
	}
	if (exitCode !== 0 && !timedOut) {
		throw new Error(`Claude Code exited with code ${exitCode}`);
	}

	return resultText || assistantText;
}
