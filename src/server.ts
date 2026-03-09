import { Hono } from "hono";
import { bot } from "./bot.ts";

export const app = new Hono();

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.post("/webhook/:platform", async (c) => {
	const platform = c.req.param("platform");
	const handler = bot.webhooks[platform as keyof typeof bot.webhooks];
	if (!handler) {
		return c.text("Unknown platform", 404);
	}
	try {
		return await handler(c.req.raw);
	} catch (err) {
		console.error(`[webhook/${platform}] Error:`, err);
		return c.text("Internal server error", 500);
	}
});
