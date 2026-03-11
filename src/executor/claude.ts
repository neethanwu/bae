import { parseJSONLStream } from "../stream/parser.ts";
import { transformClaudeEvent } from "../stream/transformer.ts";
import type { AgentEvent } from "../stream/types.ts";
import type { ExecuteOptions, ExecuteResult, Executor } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SIGKILL_DELAY_MS = 5_000;

/**
 * Claude Code executor — Option B (spawn-per-message with --resume).
 * Each call to execute() spawns a new `claude -p` process.
 * Conversation continuity is maintained via `--resume <sessionId>`.
 */
export class ClaudeCodeExecutor implements Executor {
	execute(options: ExecuteOptions): ExecuteResult {
		const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

		const args = [
			"claude",
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		];

		if (options.resumeSessionId) {
			args.push("--resume", options.resumeSessionId);
		}

		args.push("--", options.prompt);

		const env = { ...process.env } as Record<string, string>;
		delete env.CLAUDECODE; // prevent nested session check

		const proc = Bun.spawn(args, {
			cwd: options.cwd,
			stdout: "pipe",
			stderr: "pipe",
			env,
		});

		// Log stderr in background (bounded to ~4KB to avoid unbounded memory usage)
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

		let killed = false;
		let timedOut = false;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

		const timeout = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			sigkillTimer = setTimeout(() => {
				if (!killed) proc.kill("SIGKILL");
			}, SIGKILL_DELAY_MS);
		}, timeoutMs);

		async function* eventStream(): AsyncIterable<AgentEvent> {
			try {
				let gotInit = false;
				for await (const raw of parseJSONLStream(proc.stdout)) {
					const events = transformClaudeEvent(raw);
					for (const event of events) {
						if (event.kind === "init" && !gotInit) {
							gotInit = true;
							sessionResolve(event.sessionId);
						}
						yield event;
						if (event.kind === "result") return;
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

		return {
			events: eventStream(),
			sessionId,
			async kill() {
				killed = true;
				clearTimeout(timeout);
				proc.kill("SIGTERM");
				const killTimer = setTimeout(
					() => proc.kill("SIGKILL"),
					SIGKILL_DELAY_MS,
				);
				await proc.exited;
				clearTimeout(killTimer);
			},
		};
	}
}
