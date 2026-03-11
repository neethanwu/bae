import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

export default defineConfig([
	{
		entry: ["src/cli.ts"],
		format: ["esm"],
		target: "node20",
		platform: "node",
		clean: true,
		banner: { js: "#!/usr/bin/env node" },
		define: { __VERSION__: JSON.stringify(pkg.version) },
	},
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		target: "node20",
		platform: "node",
		dts: true,
	},
]);
