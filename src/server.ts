import { Hono } from "hono";

export const app = new Hono();

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

const isBun = typeof globalThis.Bun !== "undefined";

/**
 * Start the HTTP server cross-runtime.
 * Bun uses Bun.serve(), Node.js uses @hono/node-server.
 */
export async function startServer(port: number): Promise<void> {
	if (isBun) {
		Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: app.fetch,
		});
	} else {
		const { serve } = await import("@hono/node-server");
		serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
	}
}
