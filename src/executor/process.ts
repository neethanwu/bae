/**
 * Cross-runtime process spawning.
 *
 * Uses node:child_process which works on both Bun and Node.js.
 * Returns Web ReadableStreams so parseJSONLStream works unchanged.
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";

export interface ChildProcess {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	stdin?: { write(data: string): boolean; end(): void };
	kill(signal?: NodeJS.Signals): boolean;
	exited: Promise<number | null>;
}

export interface SpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	/** Open stdin as a writable pipe (for persistent process mode). */
	pipeStdin?: boolean;
}

export function spawnProcess(
	command: string,
	args: string[],
	opts: SpawnOptions,
): ChildProcess {
	const stdinMode = opts.pipeStdin ? "pipe" : "ignore";

	const proc = spawn(command, args, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: [stdinMode, "pipe", "pipe"],
	});

	const stdout = proc.stdout as NonNullable<typeof proc.stdout>;
	const stderr = proc.stderr as NonNullable<typeof proc.stderr>;

	const exited = new Promise<number | null>((resolve) => {
		proc.on("close", (code) => resolve(code));
	});

	const stdin = proc.stdin;
	const stdinHandle =
		opts.pipeStdin && stdin
			? {
					write: (data: string) => stdin.write(data),
					end: () => stdin.end(),
				}
			: undefined;

	return {
		stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
		stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
		stdin: stdinHandle,
		kill: (signal) => proc.kill(signal),
		exited,
	};
}
