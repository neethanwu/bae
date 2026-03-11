import { describe, expect, test } from "bun:test";
import { formatMetadata, formatToolStatus, splitMessage } from "./telegram.ts";

describe("splitMessage", () => {
	test("returns short message as-is", () => {
		expect(splitMessage("hello")).toEqual(["hello"]);
	});

	test("returns empty string as single chunk", () => {
		expect(splitMessage("")).toEqual([""]);
	});

	test("splits long message at line boundaries", () => {
		// Create a message over 3996 chars (4096 - 100 safety margin)
		const line = `${"x".repeat(100)}\n`;
		const text = line.repeat(50); // 5050 chars
		const chunks = splitMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(3996);
		}
	});

	test("preserves code fences when splitting", () => {
		const codeLine = "const x = 1;\n";
		const codeBlock = `\`\`\`typescript\n${codeLine.repeat(50)}\`\`\``;
		const chunks = splitMessage(codeBlock);

		// Each chunk that has code should have balanced fences
		for (const chunk of chunks) {
			const fenceCount = (chunk.match(/```/g) || []).length;
			expect(fenceCount % 2).toBe(0);
		}
	});

	test("message under limit is single chunk", () => {
		const text = "a".repeat(3000);
		expect(splitMessage(text)).toEqual([text]);
	});
});

describe("formatToolStatus", () => {
	test("formats file_path tool", () => {
		expect(formatToolStatus("Read", { file_path: "/src/index.ts" })).toBe(
			"Reading /src/index.ts",
		);
	});

	test("formats command tool", () => {
		expect(formatToolStatus("Bash", { command: "npm test" })).toBe(
			"Running: npm test",
		);
	});

	test("formats pattern tool", () => {
		expect(formatToolStatus("Grep", { pattern: "TODO" })).toBe(
			'Searching for "TODO"',
		);
	});

	test("formats unknown tool", () => {
		expect(formatToolStatus("CustomTool", {})).toBe("Using CustomTool...");
	});

	test("shortens long file paths", () => {
		const result = formatToolStatus("Read", {
			file_path: "/Users/test/project/src/deep/file.ts",
		});
		expect(result).toBe("Reading .../deep/file.ts");
	});
});

describe("formatMetadata", () => {
	test("formats milliseconds", () => {
		expect(formatMetadata(500)).toBe("\n\n✓ Done (500ms)");
	});

	test("formats seconds", () => {
		expect(formatMetadata(3500)).toBe("\n\n✓ Done (3.5s)");
	});

	test("includes cost when provided", () => {
		expect(formatMetadata(2000, 0.0123)).toBe("\n\n✓ Done (2.0s · $0.0123)");
	});

	test("omits cost when zero", () => {
		expect(formatMetadata(1000, 0)).toBe("\n\n✓ Done (1.0s)");
	});

	test("omits cost when undefined", () => {
		expect(formatMetadata(1000)).toBe("\n\n✓ Done (1.0s)");
	});
});
