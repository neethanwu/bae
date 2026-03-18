import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	deleteChannelCredentials,
	readChannelCredentials,
	writeChannelCredentials,
} from "./credentials.ts";

// Use a temp directory for tests
const TEST_DIR = join(import.meta.dir, "..", "..", ".test-credentials");

describe("credentials", () => {
	beforeEach(() => {
		// Clean up test dir
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("write and read credentials", () => {
		const id = "chan_test000001";
		writeChannelCredentials(id, {
			TELEGRAM_BOT_TOKEN: "123:ABC",
			ANOTHER_KEY: "value",
		});

		const creds = readChannelCredentials(id);
		expect(creds.TELEGRAM_BOT_TOKEN).toBe("123:ABC");
		expect(creds.ANOTHER_KEY).toBe("value");
	});

	test("read non-existent file returns empty object", () => {
		const creds = readChannelCredentials("chan_nonexist01");
		expect(Object.keys(creds)).toHaveLength(0);
	});

	test("delete credentials", () => {
		const id = "chan_test000002";
		writeChannelCredentials(id, { KEY: "val" });

		deleteChannelCredentials(id);

		const creds = readChannelCredentials(id);
		expect(Object.keys(creds)).toHaveLength(0);
	});

	test("delete non-existent file does not throw", () => {
		expect(() => deleteChannelCredentials("chan_nonexist02")).not.toThrow();
	});

	test("path traversal in channel ID is rejected", () => {
		expect(() => readChannelCredentials("../../etc/passwd" as string)).toThrow(
			"Invalid channel ID format",
		);

		expect(() =>
			writeChannelCredentials("../evil" as string, { KEY: "val" }),
		).toThrow("Invalid channel ID format");

		// Too-short IDs are rejected (must be chan_ + exactly 10 chars)
		expect(() => readChannelCredentials("chan_short" as string)).toThrow(
			"Invalid channel ID format",
		);

		// Too-long IDs are rejected
		expect(() => readChannelCredentials("chan_toolongvalue" as string)).toThrow(
			"Invalid channel ID format",
		);
	});

	test("values with spaces are quoted and round-trip correctly", () => {
		const id = "chan_test000003";
		writeChannelCredentials(id, {
			NORMAL: "plain",
			SPACES: "has spaces",
		});

		const creds = readChannelCredentials(id);
		expect(creds.NORMAL).toBe("plain");
		expect(creds.SPACES).toBe("has spaces");
	});
});
