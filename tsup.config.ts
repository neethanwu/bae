import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: ["src/cli.ts"],
		format: ["esm"],
		target: "node20",
		platform: "node",
		clean: true,
		banner: { js: "#!/usr/bin/env node" },
	},
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		target: "node20",
		platform: "node",
		dts: true,
	},
]);
