import { mkdir, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";

const requireFromConfig = createRequire(import.meta.url);
const cruiserRoot = dirname(requireFromConfig.resolve("dependency-cruiser/package.json"));
const typescriptRoot = dirname(requireFromConfig.resolve("typescript/package.json"));
const nestedModules = join(cruiserRoot, "node_modules");
const nestedTypescript = join(nestedModules, "typescript");

await mkdir(nestedModules, { recursive: true });
await symlink(relative(nestedModules, typescriptRoot), nestedTypescript, "dir").catch(
  (cause: unknown) => {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
      throw cause;
    }
  },
);
