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
			from: { path: "^apps/gateway/" },
			name: "gateway-does-not-import-authority",
			severity: "error",
			to: {
				path: "(^|/)authority(\\.ts)?$|(^|/)decide(\\.ts)?$|^packages/room-host/",
			},
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
				path: "^packages/(core|room-host|room-wire|transport-iroh|session|identity)/|^packages/games/[^/]+/src/(model|authority|content)\\.ts$",
			},
			name: "node-compat-is-platform-free",
			severity: "error",
			to: { path: "^(bun:|@opentui/)" },
		},
		{
			from: { path: "^packages/room-wire/" },
			name: "room-wire-never-imports-room-host",
			severity: "error",
			to: { path: "^packages/room-host/" },
		},
		{
			// apps/gateway is the only thing touching the GATEWAY's store — not
			// "the only thing touching a DB", which stopped being true when
			// ADR-0013 gave the web backend its own store. apps/web must not
			// reach the gateway's store either; it reads identity through the
			// interface instead.
			from: { pathNot: "^apps/gateway/" },
			name: "bun-sqlite-only-in-gateway",
			severity: "error",
			to: { path: "^bun:sqlite$" },
		},
		{
			// apps/web is the only thing touching the BACKEND's store. Drizzle's
			// driver entrypoints reach a sqlite binding from inside node_modules,
			// so `doNotFollow: node_modules` lets them sail past the rule above —
			// this names the entrypoints directly to close that gap (ADR-0013).
			from: { pathNot: "^apps/web/" },
			name: "backend-store-drivers-only-in-web",
			severity: "error",
			to: {
				path: "^(drizzle-orm/(bun-sqlite|better-sqlite3|libsql|sqlite-proxy)|better-sqlite3$|node:sqlite$)",
			},
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		exclude: { path: "(^|/)(dist|test)/|\\.test\\.ts$" },
		tsConfig: { fileName: "tsconfig.json" },
	},
};
