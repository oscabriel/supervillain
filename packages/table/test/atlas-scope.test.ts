/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** These two deep, purpose-specific modules are the entire atlas-rendering
 * surface. Neither accepts prose: one accepts MapComposition, the other has no
 * content parameter at all and paints only the pinned wordmark. */
const ATLAS_RENDER_MODULES: ReadonlySet<string> = new Set([
	"map-pixel.ts",
	"pixel-wordmark.ts",
]);

describe("atlas rendering stays out of body-text surfaces", () => {
	test("only the map composer and fixed wordmark import the atlas", async () => {
		const sourceDirectory = path.join(import.meta.dir, "..", "src");
		const files = await readdir(sourceDirectory);
		const sources = await Promise.all(
			files.map(async (file) => ({
				file,
				source: await readFile(path.join(sourceDirectory, file), "utf-8"),
			}))
		);
		const importers = sources
			.filter(({ source }) => source.includes('from "@supervillain/atlas"'))
			.map(({ file }) => file);
		expect(new Set(importers)).toEqual(ATLAS_RENDER_MODULES);
	});

	test("chat, feed/log, sheets, sidebar panels, and lobby menus stay real text", async () => {
		const sourceDirectory = path.join(import.meta.dir, "..", "src");
		const bodySources = await Promise.all(
			["chrome.ts", "lobby.ts", "lobby-screens.ts"].map(
				async (file) =>
					await readFile(path.join(sourceDirectory, file), "utf-8")
			)
		);
		for (const source of bodySources) {
			expect(source).not.toContain('from "@supervillain/atlas"');
		}
		const chrome = await readFile(
			path.join(sourceDirectory, "chrome.ts"),
			"utf-8"
		);
		expect(chrome).toContain("new TextRenderable");
		expect(chrome).toContain("new InputRenderable");
		const lobby = await readFile(
			path.join(sourceDirectory, "lobby.ts"),
			"utf-8"
		);
		expect(lobby).toContain("new TextRenderable");
		expect(lobby).toContain("new InputRenderable");
	});
});
