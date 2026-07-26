/** OpenTUI dependencies in either dependency-cruiser's resolved-path or
 * unresolved bare-specifier form. */
const OPENTUI_PACKAGE = "(^|/)node_modules/@opentui/|^@opentui/";

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
			// The render side plus one named exception: the gateway's SSH
			// entrypoint, which serves the Door on `@opentui/ssh` (ADR-0012,
			// NQ-14). The exception is a single file, not the app — and the
			// next rule holds it to `@opentui/ssh` alone, so no render-side
			// package gains an OpenTUI path through the gateway.
			from: {
				pathNot: [
					"^packages/table/",
					"^packages/games/[^/]+/src/view\\.ts$",
					"^apps/gateway/src/index\\.ts$",
				],
			},
			name: "opentui-only-on-view-side",
			severity: "error",
			// Bun's store may add nesting to resolved paths; missing installs and
			// resolution failures retain the bare package specifier instead.
			to: { path: OPENTUI_PACKAGE },
		},
		{
			// The gateway's *runtime* admission to OpenTUI is the Door library
			// and nothing else: the renderer it lends each session is the
			// library's to create and destroy (ADR-0016). Type-only imports of
			// `@opentui/core` are erased at compile time and invisible here;
			// making them visible is #79's tsPreCompilationDeps work.
			from: { path: "^apps/gateway/" },
			name: "gateway-opentui-is-ssh-only",
			severity: "error",
			to: {
				path: OPENTUI_PACKAGE,
				pathNot: "(^|/)node_modules/@opentui/ssh/|^@opentui/ssh(?:/|$)",
			},
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
				path: "^packages/(core|room-host|room-wire|transport-ws|session|identity)/|^packages/games/[^/]+/src/(model|authority|content)\\.ts$",
			},
			name: "node-compat-is-platform-free",
			severity: "error",
			to: { path: `^bun:|${OPENTUI_PACKAGE}` },
		},
		{
			from: { path: "^packages/room-wire/" },
			name: "room-wire-never-imports-room-host",
			severity: "error",
			to: { path: "^packages/room-host/" },
		},
		{
			// room-wire owns the transport seam and implements it for nobody
			// (ADR-0012, NQ-13). The arrow only ever points the other way: an
			// adapter imports the seam, never the reverse.
			from: { path: "^packages/room-wire/" },
			name: "room-wire-imports-no-transport",
			severity: "error",
			to: { path: "^(@supervillain/transport-|packages/transport-)" },
		},
		{
			// The server half is the gateway's: ADR-0012 has the Host dialing out
			// and the gateway listening, and the render side imports neither half.
			// apps/cli is a named, temporary exception. #57 inverted the *gateway*
			// direction — the Host now dials out and the gateway never dials back —
			// and #63 replaced `supervillain join <url>` with an ordinary SSH
			// session, so nothing dials the CLI's listener any more. The listener
			// itself outlived that change only because #63 declared `create` out of
			// scope; deleting it (and `door.txt` with it) is its own decision, and
			// this exception goes with it.
			from: { pathNot: "^(apps/gateway|apps/cli)/" },
			name: "transport-server-half-is-gateway-only",
			severity: "error",
			to: {
				path: "^(@supervillain/transport-[a-z]+/server$|packages/transport-[a-z]+/src/server\\.ts$)",
			},
		},
		{
			// One binary, two roles (ADR-0015): the gateway's server half is
			// compiled into the same artifact the CLI ships as, and this rule
			// keeps that from becoming a merge of the two halves. Exactly one
			// file may name the gateway — apps/cli/src/gateway-role.ts, whose
			// whole job is to defer-load it when an operator asks for the
			// gateway role. Nothing on the client path (create, join, the
			// render side) may reach it, so the halves stay apart behind the
			// role selector rather than by luck.
			from: {
				pathNot: "^(apps/gateway/|apps/cli/src/gateway-role\\.ts$)",
			},
			name: "gateway-role-behind-one-door",
			severity: "error",
			to: { path: "^(@supervillain/gateway$|apps/gateway/)" },
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
