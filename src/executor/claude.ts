import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "../platform/types.ts";
import { sanitizeFilename } from "../platform/types.ts";
import { parseJSONLStream } from "../stream/parser.ts";
import { transformClaudeEvent } from "../stream/transformer.ts";
import type { AgentEvent } from "../stream/types.ts";
import { spawnProcess } from "./process.ts";
import type { ExecuteOptions, ExecuteResult, Executor } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SIGKILL_DELAY_MS = 5_000;
const ATTACHMENTS_DIR = ".bae-attachments";

/** Generate a short random ID for deduplicating filenames. */
function shortId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 6; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

/**
 * Save attachments to the workspace's `.bae-attachments/` directory.
 * Returns an array of saved relative paths.
 */
export function saveAttachments(
	attachments: Attachment[],
	cwd: string,
): string[] {
	const dir = join(cwd, ATTACHMENTS_DIR);
	mkdirSync(dir, { recursive: true });
	ensureGitignore(cwd);

	const paths: string[] = [];
	for (const att of attachments) {
		const safe = sanitizeFilename(att.filename);
		const name = `${shortId()}-${safe}`;
		const fullPath = join(dir, name);
		writeFileSync(fullPath, att.data);
		paths.push(`${ATTACHMENTS_DIR}/${name}`);
	}
	return paths;
}

/**
 * Ensure `.bae-attachments/` is in the workspace's `.gitignore`.
 */
function ensureGitignore(cwd: string): void {
	const gitignorePath = join(cwd, ".gitignore");
	try {
		if (existsSync(gitignorePath)) {
			const content = readFileSync(gitignorePath, "utf-8");
			if (content.includes(ATTACHMENTS_DIR)) return;
			writeFileSync(
				gitignorePath,
				`${content.trimEnd()}\n${ATTACHMENTS_DIR}/\n`,
			);
		} else {
			writeFileSync(gitignorePath, `${ATTACHMENTS_DIR}/\n`);
		}
	} catch {
		// Non-fatal — don't break the message flow over gitignore
	}
}

/**
 * Format a user message as NDJSON for `--input-format stream-json`.
 *
 * When attachments are present:
 * - All files saved to `.bae-attachments/` in the workspace
 * - Images included inline as base64 content blocks
 * - Non-image files referenced by path in the text block
 */
export function makeUserMessage(
	text: string,
	sessionId?: string,
	attachments?: Attachment[],
	cwd?: string,
): string {
	let content: string | unknown[];

	if (attachments?.length && cwd) {
		const savedPaths = saveAttachments(attachments, cwd);
		const contentBlocks: unknown[] = [];

		// Build text block: user text + non-image file path references
		const textParts: string[] = [];
		if (text.trim()) textParts.push(text);

		for (let i = 0; i < attachments.length; i++) {
			const att = attachments[i]!;
			if (att.mimeType.startsWith("image/")) {
				// Image: inline as base64 content block
				contentBlocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: att.mimeType,
						data: att.data.toString("base64"),
					},
				});
			} else {
				// Non-image: reference the saved path
				textParts.push(`[Attached file: ${savedPaths[i]}]`);
			}
		}

		// Always include a text block (first, per Messages API convention)
		const finalText = textParts.length > 0 ? textParts.join("\n") : "(see attached)";
		contentBlocks.unshift({ type: "text", text: finalText });

		content = contentBlocks;
	} else {
		content = text || "(empty message)";
	}

	return JSON.stringify({
		type: "user",
		message: { role: "user", content },
		session_id: sessionId ?? "default",
		parent_tool_use_id: null,
	});
}

/**
 * Claude Code executor — persistent process with stdin steering.
 *
 * Spawns `claude -p --input-format stream-json` with stdin open.
 * The process stays alive across multiple messages in the same thread.
 * Steering messages are written to stdin while the agent is running.
 */
export class ClaudeCodeExecutor implements Executor {
	execute(options: ExecuteOptions): ExecuteResult {
		const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--dangerously-skip-permissions",
			"--replay-user-messages",
		];

		if (options.resumeSessionId) {
			args.push("--resume", options.resumeSessionId);
		}

		const env = { ...process.env } as Record<string, string | undefined>;
		delete env.CLAUDECODE; // prevent nested session check
		delete env.TELEGRAM_BOT_TOKEN; // don't leak bot token to spawned agents

		const proc = spawnProcess("claude", args, {
			cwd: options.cwd,
			env,
			pipeStdin: true,
		});

		// Write the initial prompt to stdin
		const initialMessage = makeUserMessage(
			options.prompt,
			undefined,
			options.attachments,
			options.cwd,
		);
		proc.stdin?.write(`${initialMessage}\n`);

		// Log stderr in background (bounded to ~4KB)
		const MAX_STDERR = 4096;
		let stderrBuf = "";
		const reader = proc.stderr.getReader();
		(async () => {
			const decoder = new TextDecoder();
			try {
				while (stderrBuf.length < MAX_STDERR) {
					const { done, value } = await reader.read();
					if (done) break;
					stderrBuf += decoder.decode(value, { stream: true });
				}
				reader.cancel();
			} catch {}
			if (stderrBuf.trim()) {
				console.error("[claude stderr]", stderrBuf.trim().slice(0, 500));
			}
		})();

		let sessionResolve: (id: string) => void;
		let sessionReject: (err: Error) => void;
		const sessionId = new Promise<string>((resolve, reject) => {
			sessionResolve = resolve;
			sessionReject = reject;
		});

		let agentSessionId: string | undefined;
		let killed = false;
		let timedOut = false;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

		const resetTimeout = () => {
			clearTimeout(timeout);
			if (!killed) {
				timeout = setTimeout(onTimeout, timeoutMs);
			}
		};

		const onTimeout = () => {
			timedOut = true;
			proc.kill("SIGTERM");
			sigkillTimer = setTimeout(() => {
				if (!killed) proc.kill("SIGKILL");
			}, SIGKILL_DELAY_MS);
		};

		let timeout = setTimeout(onTimeout, timeoutMs);

		/**
		 * Event stream that yields events across multiple turns.
		 * Unlike spawn-per-message, this does NOT return on the first `result`.
		 * The stream ends when the process exits.
		 */
		async function* eventStream(): AsyncIterable<AgentEvent> {
			try {
				let gotInit = false;
				for await (const raw of parseJSONLStream(proc.stdout)) {
					const events = transformClaudeEvent(raw);
					for (const event of events) {
						if (event.kind === "init" && !gotInit) {
							gotInit = true;
							agentSessionId = event.sessionId;
							sessionResolve(event.sessionId);
						}
						yield event;
						// Do NOT return on result — process stays alive for steering
					}
				}
				if (!gotInit) {
					sessionReject(new Error("Process ended without init event"));
				}
			} catch (err) {
				sessionReject(err instanceof Error ? err : new Error(String(err)));
				yield {
					kind: "error",
					message: timedOut
						? `Agent timed out after ${timeoutMs / 1000}s`
						: err instanceof Error
							? err.message
							: String(err),
				};
			} finally {
				clearTimeout(timeout);
				clearTimeout(sigkillTimer);
				await proc.exited;
			}
		}

		async function terminate() {
			killed = true;
			clearTimeout(timeout);
			proc.stdin?.end();
			proc.kill("SIGTERM");
			const killTimer = setTimeout(
				() => proc.kill("SIGKILL"),
				SIGKILL_DELAY_MS,
			);
			await proc.exited;
			clearTimeout(killTimer);
		}

		return {
			events: eventStream(),
			sessionId,

			send(text: string, attachments?: Attachment[]) {
				if (!proc.stdin) {
					throw new Error("Process stdin not available");
				}
				const msg = makeUserMessage(
					text,
					agentSessionId,
					attachments,
					options.cwd,
				);
				proc.stdin.write(`${msg}\n`);
				resetTimeout();
			},

			interrupt: terminate,
			kill: terminate,
		};
	}
}
