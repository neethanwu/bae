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
	kill(signal?: NodeJS.Signals): boolean;
	exited: Promise<number | null>;
}

export function spawnProcess(
	command: string,
	args: string[],
	opts: { cwd: string; env: Record<string, string | undefined> },
): ChildProcess {
	const proc = spawn(command, args, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	// stdio is ["ignore", "pipe", "pipe"] so stdout/stderr are guaranteed
	const stdout = proc.stdout as NonNullable<typeof proc.stdout>;
	const stderr = proc.stderr as NonNullable<typeof proc.stderr>;

	const exited = new Promise<number | null>((resolve) => {
		proc.on("close", (code) => resolve(code));
	});

	return {
		stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
		stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
		kill: (signal) => proc.kill(signal),
		exited,
	};
}
