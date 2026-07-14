/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			from: { path: "^(?!apps/|packages/games/)" },
			name: "games-only-imported-by-apps",
			severity: "error",
			to: { path: "^packages/games/" },
		},
		{
			from: {
				pathNot: ["^packages/table/", "^packages/games/[^/]+/src/view\\.ts$"],
			},
			name: "opentui-only-on-view-side",
			severity: "error",
			to: { path: "^@opentui/" },
		},
		{
			from: { path: "^packages/table/" },
			name: "table-does-not-import-authority",
			severity: "error",
			to: { path: "(^|/)authority(\\.ts)?$|(^|/)decide(\\.ts)?$" },
		},
		{
			from: { path: "^packages/games/[^/]+/src/content\\.ts$" },
			name: "game-content-imports-model-only",
			severity: "error",
			to: { pathNot: "^packages/games/[^/]+/src/model\\.ts$" },
		},
		{
			from: { path: "^packages/games/[^/]+/src/model\\.ts$" },
			name: "game-model-imports-nothing",
			severity: "error",
			to: {},
		},
		{
			from: {
				path: "^packages/(core|room-host|transport-iroh|session|identity)/|^packages/games/[^/]+/src/(model|authority|content)\\.ts$",
			},
			name: "node-compat-is-platform-free",
			severity: "error",
			to: { path: "^(bun:|@opentui/)" },
		},
		{
			from: { pathNot: "^apps/gateway/" },
			name: "bun-sqlite-only-in-gateway",
			severity: "error",
			to: { path: "^bun:sqlite$" },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		exclude: { path: "(^|/)(dist|test)/|\\.test\\.ts$" },
		tsConfig: { fileName: "tsconfig.json" },
	},
};
