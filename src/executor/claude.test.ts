import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeUserMessage, saveAttachments } from "./claude.ts";
import type { Attachment } from "../platform/types.ts";
import { sanitizeFilename } from "../platform/types.ts";

const TMP_DIR = join(import.meta.dir, "../../.test-workspace");

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("makeUserMessage", () => {
	test("default session ID is 'default'", () => {
		const msg = JSON.parse(makeUserMessage("hello"));
		expect(msg.type).toBe("user");
		expect(msg.message).toEqual({ role: "user", content: "hello" });
		expect(msg.session_id).toBe("default");
		expect(msg.parent_tool_use_id).toBeNull();
	});

	test("uses provided session ID", () => {
		const msg = JSON.parse(makeUserMessage("hi", "abc-123"));
		expect(msg.session_id).toBe("abc-123");
	});

	test("serializes as single NDJSON line (no embedded newlines)", () => {
		const serialized = makeUserMessage("line1\nline2\nline3");
		expect(serialized.includes("\n")).toBe(false);
	});

	test("handles special characters in content", () => {
		const msg = JSON.parse(makeUserMessage('he said "hello" & <world>'));
		expect(msg.message.content).toBe('he said "hello" & <world>');
	});

	test("text-only message: content is a plain string", () => {
		const msg = JSON.parse(makeUserMessage("just text"));
		expect(typeof msg.message.content).toBe("string");
		expect(msg.message.content).toBe("just text");
	});

	test("image attachment: content is array with text + image blocks", () => {
		const attachments: Attachment[] = [
			{
				filename: "screenshot.png",
				mimeType: "image/png",
				data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
			},
		];
		const msg = JSON.parse(
			makeUserMessage("what's this?", "sess", attachments, TMP_DIR),
		);

		expect(Array.isArray(msg.message.content)).toBe(true);
		const blocks = msg.message.content;

		// Text block first
		expect(blocks[0].type).toBe("text");
		expect(blocks[0].text).toBe("what's this?");

		// Image block second
		expect(blocks[1].type).toBe("image");
		expect(blocks[1].source.type).toBe("base64");
		expect(blocks[1].source.media_type).toBe("image/png");
		expect(typeof blocks[1].source.data).toBe("string");
	});

	test("image without text: uses placeholder prompt", () => {
		const attachments: Attachment[] = [
			{
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				data: Buffer.from([0xff, 0xd8]),
			},
		];
		const msg = JSON.parse(
			makeUserMessage("", "sess", attachments, TMP_DIR),
		);

		const blocks = msg.message.content;
		expect(blocks[0].type).toBe("text");
		expect(blocks[0].text).toBe("(see attached)");
		expect(blocks[1].type).toBe("image");
	});

	test("non-image file: saved to disk, path referenced in text", () => {
		const attachments: Attachment[] = [
			{
				filename: "data.csv",
				mimeType: "text/csv",
				data: Buffer.from("a,b,c\n1,2,3"),
			},
		];
		const msg = JSON.parse(
			makeUserMessage("check this", "sess", attachments, TMP_DIR),
		);

		const blocks = msg.message.content;
		expect(blocks[0].type).toBe("text");
		expect(blocks[0].text).toContain("check this");
		expect(blocks[0].text).toContain("[Attached file: .bae-attachments/");
		expect(blocks[0].text).toContain("data.csv");

		// No image block
		expect(blocks.length).toBe(1);
	});

	test("mixed: image + non-image file", () => {
		const attachments: Attachment[] = [
			{
				filename: "screenshot.png",
				mimeType: "image/png",
				data: Buffer.from([0x89, 0x50]),
			},
			{
				filename: "log.txt",
				mimeType: "text/plain",
				data: Buffer.from("error at line 42"),
			},
		];
		const msg = JSON.parse(
			makeUserMessage("help", "sess", attachments, TMP_DIR),
		);

		const blocks = msg.message.content;
		// Text block with user text + file path reference
		expect(blocks[0].type).toBe("text");
		expect(blocks[0].text).toContain("help");
		expect(blocks[0].text).toContain("[Attached file:");
		expect(blocks[0].text).toContain("log.txt");

		// Image block
		expect(blocks[1].type).toBe("image");
		expect(blocks[1].source.media_type).toBe("image/png");
	});

	test("attachments without cwd: falls back to text-only", () => {
		const attachments: Attachment[] = [
			{
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				data: Buffer.from([0xff]),
			},
		];
		// No cwd — can't save files
		const msg = JSON.parse(makeUserMessage("hello", "sess", attachments));
		expect(typeof msg.message.content).toBe("string");
	});
});

describe("saveAttachments", () => {
	test("saves files to .bae-attachments/ and returns relative paths", () => {
		const attachments: Attachment[] = [
			{
				filename: "test.txt",
				mimeType: "text/plain",
				data: Buffer.from("hello world"),
			},
		];
		const paths = saveAttachments(attachments, TMP_DIR);

		expect(paths.length).toBe(1);
		expect(paths[0]).toMatch(/^\.bae-attachments\/[a-z0-9]+-test\.txt$/);

		// File actually exists
		const fullPath = join(TMP_DIR, paths[0]!);
		expect(existsSync(fullPath)).toBe(true);
		expect(readFileSync(fullPath, "utf-8")).toBe("hello world");
	});

	test("creates .gitignore with .bae-attachments/ if none exists", () => {
		const attachments: Attachment[] = [
			{
				filename: "f.txt",
				mimeType: "text/plain",
				data: Buffer.from("x"),
			},
		];
		saveAttachments(attachments, TMP_DIR);

		const gitignore = readFileSync(join(TMP_DIR, ".gitignore"), "utf-8");
		expect(gitignore).toContain(".bae-attachments/");
	});

	test("appends to existing .gitignore if not already present", () => {
		const gitignorePath = join(TMP_DIR, ".gitignore");
		writeFileSync(gitignorePath, "node_modules/\n");

		saveAttachments(
			[{ filename: "f.txt", mimeType: "text/plain", data: Buffer.from("x") }],
			TMP_DIR,
		);

		const content = readFileSync(gitignorePath, "utf-8");
		expect(content).toContain("node_modules/");
		expect(content).toContain(".bae-attachments/");
	});

	test("does not duplicate .bae-attachments/ in existing .gitignore", () => {
		const gitignorePath = join(TMP_DIR, ".gitignore");
		writeFileSync(gitignorePath, ".bae-attachments/\n");

		saveAttachments(
			[{ filename: "f.txt", mimeType: "text/plain", data: Buffer.from("x") }],
			TMP_DIR,
		);

		const content = readFileSync(gitignorePath, "utf-8");
		const count = (content.match(/\.bae-attachments/g) || []).length;
		expect(count).toBe(1);
	});
});

describe("sanitizeFilename", () => {
	test("strips path separators", () => {
		const result = sanitizeFilename("../../etc/passwd");
		expect(result).not.toContain("/");
		expect(result).not.toContain("\\");
		expect(result).toContain("passwd");
	});

	test("replaces dangerous characters", () => {
		const result = sanitizeFilename("file name (1).txt");
		expect(result).not.toContain(" ");
		expect(result).toContain("file");
		expect(result).toEndWith(".txt");
	});

	test("collapses multiple underscores", () => {
		expect(sanitizeFilename("a///b")).toBe("a_b");
	});

	test("removes leading dots", () => {
		expect(sanitizeFilename(".hidden")).toBe("_hidden");
		expect(sanitizeFilename("...dots")).toBe("_dots");
	});

	test("truncates long names preserving extension", () => {
		const long = "a".repeat(250) + ".png";
		const result = sanitizeFilename(long);
		expect(result.length).toBeLessThanOrEqual(200);
		expect(result).toEndWith(".png");
	});

	test("returns 'attachment' for empty input", () => {
		expect(sanitizeFilename("")).toBe("attachment");
	});

	test("preserves normal filenames", () => {
		expect(sanitizeFilename("screenshot-2026.png")).toBe(
			"screenshot-2026.png",
		);
		expect(sanitizeFilename("data_file.csv")).toBe("data_file.csv");
	});
});
