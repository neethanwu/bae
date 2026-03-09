import { app } from "./server.ts";

const PORT = Number(process.env.BAE_PORT) || 3456;

console.log(`Bae starting on port ${PORT}...`);

export default {
	port: PORT,
	fetch: app.fetch,
};
