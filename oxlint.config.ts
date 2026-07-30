import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
	extends: [core, vitest, react],
	ignorePatterns: [
		...core.ignorePatterns,
		// apps/web build artifacts (vite/nitro) and TanStack Router's generated
		// route tree, which its own header says to exclude from linters.
		"**/.nitro/**",
		"**/.output/**",
		"**/routeTree.gen.ts",
	],
});
