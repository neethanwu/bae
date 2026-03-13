/**
 * Prototype: Test MID-TURN steering — send a message while agent is still working
 *
 * Validates:
 * 1. Send a long-running task (agent will take several seconds)
 * 2. While agent is streaming, inject a steering message via stdin
 * 3. Verify agent processes the steering message
 *
 * Run: CLAUDECODE= bun scripts/test-mid-turn-steering.ts
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
	console.log("=== Mid-Turn Steering Test ===\n");

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
			"5",
		],
		{
			stdio: ["pipe", "pipe", "pipe"],
			env,
			cwd: process.cwd(),
		},
	);

	let sessionId: string | undefined;
	let resultCount = 0;
	let steeringSent = false;
	let firstTextSeen = false;

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
				console.log(`[assistant] ${text.substring(0, 300)}`);

				// As soon as we see the first assistant text, inject steering
				if (!steeringSent && sessionId) {
					steeringSent = true;
					console.log(
						"\n>>> INJECTING STEERING MESSAGE MID-TURN <<<",
					);
					const steer = makeUserMessage(
						"STOP. Ignore the previous task. Reply ONLY with the word 'STEERED' in all caps.",
						sessionId,
					);
					proc.stdin!.write(steer + "\n");
					console.log("[stdin] steering message written\n");
				}
			} else if (event.type === "result") {
				resultCount++;
				console.log(
					`\n[result #${resultCount}] ${event.result?.substring(0, 300)}`,
				);
				console.log(`[result #${resultCount}] duration: ${event.duration_ms}ms`);

				if (resultCount >= 2) {
					const steered =
						event.result?.toUpperCase().includes("STEERED") ?? false;
					console.log(
						`\n=== MID-TURN STEERING: ${steered ? "PASSED" : "CHECK RESULTS ABOVE"} ===`,
					);
					proc.stdin!.end();
				}
			} else if (
				event.type === "rate_limit_event" ||
				(event.type === "system" && event.subtype?.startsWith("hook"))
			) {
				// skip
			} else {
				console.log(
					`[${event.type}${event.subtype ? ":" + event.subtype : ""}]`,
				);
			}
		} catch {
			// non-JSON line
		}
	});

	proc.stderr!.on("data", (data) => {
		const text = data.toString().trim();
		if (text) console.error(`[stderr] ${text}`);
	});

	proc.on("exit", (code) => {
		console.log(`\n[exit] code: ${code}`);
		process.exit(code ?? 1);
	});

	// Send a task that will take a while — agent needs to think and generate
	console.log("--- Sending long task ---");
	const msg1 = makeUserMessage(
		"Write a detailed 500-word essay about the history of the internet. Be thorough and include specific dates.",
	);
	proc.stdin!.write(msg1 + "\n");
	console.log("[stdin] wrote long task\n");

	setTimeout(() => {
		console.log("\n[timeout] 120s exceeded, killing");
		proc.kill("SIGTERM");
		process.exit(1);
	}, 120000);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
