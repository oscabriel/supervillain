import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

const DOMAIN = [
	"**",
	"!effect",
	"!effect/rpc",
	"!@alchemy.run/domain",
	"!./**",
];

const PURE_DOMAIN =
	"The domain imports only effect, effect/rpc and @alchemy.run/domain. Files, sockets, terminals and the log belong to the host.";

const TABLE = [
	"**",
	"!@opentui/core",
	"!@opentui/core/**",
	"!@opentui/solid",
	"!solid-js",
	"!solid-js/**",
	"!node:zlib",
	"!@supervillain/domain",
	"!@supervillain/domain/**",
	"!./**",
];

const TABLE_VIEW =
	"The table sees only its TableView and the game's projections: never the room, the log or Effect.";

const restrict = (
	group: ReadonlyArray<string>,
	message: string
): [
	"error",
	{ patterns: Array<{ group: Array<string>; message: string }> },
] => ["error", { patterns: [{ group: [...group], message }] }];

const ultraciteIgnores = core.ignorePatterns ?? [];

export default defineConfig({
	env: core.env,
	extends: [core, effectRecommended],
	ignorePatterns: [
		...ultraciteIgnores,
		".agents/**",
		".claude/**",
		".pi-subagents/**",
		".zed/**",
		"examples/campaign/**",
		"patches/**",
		"spikes/**",
		"tools/oxlint/anti-slop/**",
	],
	jsPlugins: [
		{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
		{
			name: "anti-slop-effect",
			specifier: "./tools/oxlint/anti-slop/effect/index.ts",
		},
		{
			name: "supervillain",
			specifier: "./tools/oxlint/supervillain/index.ts",
		},
	],
	options: {
		denyWarnings: true,
		reportUnusedDisableDirectives: "error",
		typeAware: true,
	},
	rules: {
		"effecttsgo/prefer-barrel-import": "error",
		"effecttsgo/schema-class-missing-brand": "off",
		"func-names": "off",
		"max-classes-per-file": "off",
		"no-redeclare": "off",
		"require-yield": "off",
		"sort-keys": "off",
		"typescript/array-type": [
			"error",
			{ default: "generic", readonly: "generic" },
		],
		"typescript/consistent-indexed-object-style": "off",
		"typescript/method-signature-style": "off",
		"unicorn/filename-case": [
			"error",
			{ cases: { camelCase: true, kebabCase: true, pascalCase: true } },
		],
		"unicorn/no-array-method-this-argument": "off",
		"unicorn/throw-new-error": "off",

		"effecttsgo/crypto-random-uuid-in-effect": "error",
		"effecttsgo/global-console-in-effect": "error",
		"effecttsgo/global-date-in-effect": "error",
		"effecttsgo/global-fetch-in-effect": "error",
		"effecttsgo/global-json-in-effect": "error",
		"effecttsgo/process-env-in-effect": "error",
		"effecttsgo/effect-try-without-catch": "error",
		"effecttsgo/extends-native-error": "error",
		"effecttsgo/missing-concurrency-option": "error",
		"effecttsgo/provide-merge-all-to-array": "error",
		"effecttsgo/strict-effect-provide": "error",

		"oxc/no-accumulating-spread": "error",
		"anti-slop/max-ternary-depth": ["error", { maxDepth: 2 }],
		"anti-slop/no-array-filter-map": "error",
		"anti-slop/no-chained-type-assertions": "error",
		"anti-slop/no-conditional-spread": "error",
		"anti-slop/no-disabled-type-assertion-rules": "error",
		"anti-slop/no-known-value-widening": "error",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-reduce-accumulator-copy": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		"anti-slop/no-reprovide-ambient-service": "error",
		"anti-slop/no-runtime-typeof": "error",
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-unknown-parameters": "error",
		"anti-slop/no-unknown-returns": "error",
		"anti-slop/no-unknown-type-aliases": "error",
		"anti-slop/no-unsafe-dictionary-type": "error",
		"anti-slop/no-widen-then-assert": "error",
		"anti-slop/require-readable-spacing": "error",
		"anti-slop/require-safety-comment-for-type-assertion": "error",
		"anti-slop-effect/no-manual-effect-error-tag": "error",
		"anti-slop-effect/no-manual-tag-comparison": "error",
		"anti-slop-effect/no-manual-tagged-construction": "error",
		"anti-slop-effect/no-manual-tagged-type": "error",
		"anti-slop-effect/no-ordie-in-service-construction": "error",
		"anti-slop-effect/no-service-constructor-imports": "error",
		"anti-slop-effect/no-service-parameters": "error",
		"anti-slop-effect/no-test-code-in-src": "error",
		"anti-slop-effect/prefer-effect-match": "error",
		"anti-slop-effect/prefer-tagged-error-handling": "error",
		"anti-slop-effect/prefer-yield-service": "error",
		"anti-slop-effect/require-cause-when-narrowing": "error",
		"anti-slop-effect/require-operation-span": "error",
		"anti-slop-effect/require-service-make-layer": "error",

		"supervillain/no-comments": "error",
	},
	overrides: [
		{
			files: ["packages/domain/src/*.ts"],
			rules: {
				"no-restricted-imports": restrict(DOMAIN, PURE_DOMAIN),
			},
		},
		{
			files: ["packages/domain/src/*/*.ts"],
			rules: {
				"no-restricted-imports": restrict(
					[...DOMAIN, "!../**", "../../**"],
					PURE_DOMAIN
				),
			},
		},
		{
			files: ["packages/domain/src/*/*/*.ts"],
			rules: {
				"no-restricted-imports": restrict(
					[...DOMAIN, "!../**", "!../../**", "../../../**"],
					PURE_DOMAIN
				),
			},
		},
		{
			files: [
				"apps/supervillain/src/table/*.ts",
				"apps/supervillain/src/table/*.tsx",
			],
			rules: {
				"no-restricted-imports": restrict(TABLE, TABLE_VIEW),
			},
		},
		{
			files: ["apps/supervillain/src/table/*/**"],
			rules: {
				"no-restricted-imports": restrict(
					[...TABLE, "!../**", "../../**"],
					TABLE_VIEW
				),
			},
		},
	],
});
