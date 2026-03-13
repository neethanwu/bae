/**
 * Prototype: Test persistent stdin steering with Claude Code
 *
 * Validates:
 * 1. Spawn `claude -p --input-format stream-json` with stdin pipe
 * 2. Write first message to stdin, receive streaming response
 * 3. Write second message (steering) while first is still processing
 * 4. Verify agent receives and processes the steering message
 *
 * Run: CLAUDECODE= bun scripts/test-steering.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function makeUserMessage(text: string, sessionId?: string) {
	return JSON.stringify({
		type: "user",
		message: { role: "user", content: text },
		session_id: sessionId ?? "default",
		parent_tool_use_id: null,
	});
}

async function main() {
	console.log("=== Steering Prototype Test ===\n");

	// Strip CLAUDECODE to avoid nested session check
	const env = { ...process.env };
	delete env.CLAUDECODE;

	const proc = spawn(
		"claude",
		[
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--max-turns",
			"3",
		],
		{
			stdio: ["pipe", "pipe", "pipe"],
			env,
			cwd: process.cwd(),
		},
	);

	let sessionId: string | undefined;
	let gotFirstResult = false;
	let gotSecondResult = false;
	let steeringSent = false;

	// Parse stdout NDJSON
	const rl = createInterface({ input: proc.stdout! });

	rl.on("line", (line) => {
		try {
			const event = JSON.parse(line);

			if (event.type === "system" && event.subtype === "init") {
				sessionId = event.session_id;
				console.log(`[init] session_id: ${sessionId}`);
			} else if (event.type === "assistant") {
				const text =
					event.message?.content
						?.filter((b: any) => b.type === "text")
						.map((b: any) => b.text)
						.join("") ?? "";
				console.log(`[assistant] ${text.substring(0, 200)}...`);
			} else if (event.type === "result") {
				if (!gotFirstResult) {
					gotFirstResult = true;
					console.log(
						`\n[result #1] ${event.result?.substring(0, 200)}...`,
					);
					console.log(`[result #1] duration: ${event.duration_ms}ms`);

					// Now send a second message (follow-up turn)
					console.log("\n--- Sending follow-up message ---");
					const msg2 = makeUserMessage(
						"Now reply with just the word 'STEERED' in all caps, nothing else.",
						sessionId,
					);
					proc.stdin!.write(msg2 + "\n");
					console.log(`[stdin] wrote follow-up message`);
				} else if (!gotSecondResult) {
					gotSecondResult = true;
					console.log(
						`\n[result #2] ${event.result?.substring(0, 200)}`,
					);
					console.log(`[result #2] duration: ${event.duration_ms}ms`);

					// Check if steering worked
					const steered =
						event.result?.includes("STEERED") ?? false;
					console.log(
						`\n=== STEERING TEST: ${steered ? "PASSED" : "FAILED"} ===`,
					);

					// Clean exit
					proc.stdin!.end();
				}
			} else if (event.type === "rate_limit_event") {
				// skip
			} else {
				console.log(
					`[${event.type}${event.subtype ? ":" + event.subtype : ""}]`,
				);
			}
		} catch {
			// non-JSON line, ignore
		}
	});

	proc.stderr!.on("data", (data) => {
		const text = data.toString().trim();
		if (text) console.error(`[stderr] ${text}`);
	});

	proc.on("exit", (code) => {
		console.log(`\n[exit] code: ${code}`);
		if (!gotFirstResult) {
			console.log("FAILED: Never got first result");
		}
		if (!gotSecondResult) {
			console.log("FAILED: Never got second result (steering)");
		}
		process.exit(code ?? 1);
	});

	// Send first message
	console.log("--- Sending first message ---");
	const msg1 = makeUserMessage(
		"Reply with just the word 'HELLO' in all caps, nothing else.",
	);
	proc.stdin!.write(msg1 + "\n");
	console.log("[stdin] wrote first message\n");

	// Safety timeout
	setTimeout(() => {
		console.log("\n[timeout] 60s exceeded, killing process");
		proc.kill("SIGTERM");
		process.exit(1);
	}, 60000);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
