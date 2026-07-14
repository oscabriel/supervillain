/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "games-only-imported-by-apps",
      severity: "error",
      from: { path: "^(?!apps/|packages/games/)" },
      to: { path: "^packages/games/" },
    },
    {
      name: "opentui-only-on-view-side",
      severity: "error",
      from: { pathNot: ["^packages/table/", "^packages/games/[^/]+/src/view\\.ts$"] },
      to: { path: "^@opentui/" },
    },
    {
      name: "table-does-not-import-authority",
      severity: "error",
      from: { path: "^packages/table/" },
      to: { path: "(^|/)authority(\\.ts)?$|(^|/)decide(\\.ts)?$" },
    },
    {
      name: "game-content-imports-model-only",
      severity: "error",
      from: { path: "^packages/games/[^/]+/src/content\\.ts$" },
      to: { pathNot: "^packages/games/[^/]+/src/model\\.ts$" },
    },
    {
      name: "game-model-imports-nothing",
      severity: "error",
      from: { path: "^packages/games/[^/]+/src/model\\.ts$" },
      to: {},
    },
    {
      name: "node-compat-is-platform-free",
      severity: "error",
      from: {
        path: "^packages/(core|room-host|transport-iroh|session|identity)/|^packages/games/[^/]+/src/(model|authority|content)\\.ts$",
      },
      to: { path: "^(bun:|@opentui/)" },
    },
    {
      name: "bun-sqlite-only-in-gateway",
      severity: "error",
      from: { pathNot: "^apps/gateway/" },
      to: { path: "^bun:sqlite$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|test)/|\\.test\\.ts$" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
