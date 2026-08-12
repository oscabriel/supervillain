/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Bare "draw" is intentionally not forbidden: rendering code legitimately
 * uses it as a verb. Bare "steel", bare "fake", camelCase `ds`-prefixed
 * identifiers (`DsState`), and both modules' hyphen/dot machine vocabulary
 * (`ds-initiative`, `ds.`, `fake-visits`, `fake.`) are all caught — depcruise
 * blocks imports, but only this scan catches copied vocabulary. */
const GAME_VOCABULARY = [
	/\bds[-.]/iu,
	/\b[Dd]s[A-Z]/u,
	/\bfake\b/iu,
	/\bsteel\b/iu,
	/\bdraw[\s-]*steel\b/iu,
] as const;

describe("Table source stays game-blind", () => {
	test("contains no game ids, namespaces, or names", async () => {
		const sourceDirectory = path.join(import.meta.dir, "..", "src");
		const directoryEntries = await readdir(sourceDirectory, {
			recursive: true,
			withFileTypes: true,
		});
		const sourceFiles = directoryEntries
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(entry.parentPath, entry.name));
		const sources = await Promise.all(
			sourceFiles.map(async (file) => await readFile(file, "utf-8"))
		);
		for (const source of sources) {
			for (const vocabulary of GAME_VOCABULARY) {
				expect(source).not.toMatch(vocabulary);
			}
		}
	});
});
