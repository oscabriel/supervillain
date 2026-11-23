import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

const ultraciteIgnores = ultracite.ignorePatterns ?? [];

export default defineConfig({
	...ultracite,
	useTabs: true,
	ignorePatterns: [
		...ultraciteIgnores,
		".agents/**",
		".claude/**",
		".pi-subagents/**",
		".zed/**",
		"**/*.md",
		"apps/supervillain/test/**/fixtures/**",
		"examples/campaign/**",
		"patches/**",
		"spikes/**",
		"tools/oxlint/anti-slop/**",
	],
});
