/**
 * Parses newline-delimited JSON (JSONL) from a ReadableStream.
 * Handles partial lines across chunks and skips non-JSON lines.
 */
export async function* parseJSONLStream(
	readable: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of readable) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				yield JSON.parse(trimmed);
			} catch {
				// Skip non-JSON lines (e.g. Claude Code startup messages)
			}
		}
	}

	// Process any remaining data in buffer
	if (buffer.trim()) {
		try {
			yield JSON.parse(buffer.trim());
		} catch {
			// Skip
		}
	}
}
