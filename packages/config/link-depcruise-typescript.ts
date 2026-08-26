import { mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// This package deliberately pins a TypeScript 6.x devDependency even though the
// repo compiles with 7.0.2 (pinned at the root): dependency-cruiser 18.x drives
// only `typescript >=2 <7` and fails to extract with 7 installed
// (`missing-typescript-transpiler`), which makes `bun run depcruise` exit 0
// while silently cruising ~0 modules — the seam lattice goes decorative but
// stays green. The postinstall hook below symlinks whatever TS resolves from
// this scope into cruiser's node_modules, so this pin is what the cruise
// actually parses with. Root's 7.0.2 remains the compiler for all tsc -b work.
// Revisit when dependency-cruiser ships support for the published TS7 API.
const requireFromConfig = createRequire(import.meta.url);
const cruiserRoot = path.dirname(
	requireFromConfig.resolve("dependency-cruiser/package.json")
);
const typescriptRoot = path.dirname(
	requireFromConfig.resolve("typescript/package.json")
);
const nestedModules = path.join(cruiserRoot, "node_modules");
const nestedTypescript = path.join(nestedModules, "typescript");

await mkdir(nestedModules, { recursive: true });
await symlink(
	path.relative(nestedModules, typescriptRoot),
	nestedTypescript,
	"dir"
).catch((error: unknown) => {
	if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
		throw error;
	}
});
