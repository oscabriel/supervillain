import { mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

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
