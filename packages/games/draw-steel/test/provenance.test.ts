/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import manifest from "../provenance.json";

// ADR-0011: game-data citations must name an enumerated document of the
// Draw Steel Creator License (.agents/wayfinder/assets/draw-steel-license.md).
const ENUMERATED_WORKS: readonly string[] = [
	"DRAW STEEL Backer Packet #1",
	"Draw Steel Backer Packet #2",
	"Draw Steel: Heroes",
	"Draw Steel: Monsters",
	"The Beastheart for Draw Steel",
	"The Summoner",
];

const KINDS: readonly string[] = ["game-data", "license-text"];

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

const source = await Bun.file(
	new URL("../src/content.ts", import.meta.url)
).text();

describe("Draw Steel provenance manifest (ADR-0011)", () => {
	test("manifest names this package", () => {
		expect(manifest.package).toBe("@supervillain/draw-steel");
		expect(manifest.entries.length).toBeGreaterThan(0);
	});

	describe.each(
		manifest.entries.map((entry, index) => [index, entry] as const)
	)("entry %i", (_index, entry) => {
		test("is schema-valid", () => {
			expect(KINDS).toContain(entry.kind);
			expect(isNonEmptyString(entry.work)).toBe(true);
			expect(isNonEmptyString(entry.version)).toBe(true);
			expect(isNonEmptyString(entry.author)).toBe(true);
			expect(isNonEmptyString(entry.license.name)).toBe(true);
			expect(isNonEmptyString(entry.license.url)).toBe(true);
			expect(isNonEmptyString(entry.sourceUrl)).toBe(true);
			expect(entry.accessed).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			expect(entry.data.length).toBeGreaterThan(0);
		});

		test("game-data entries cite an enumerated document", () => {
			if (entry.kind === "game-data") {
				expect(ENUMERATED_WORKS).toContain(entry.work);
			}
		});

		test("every cited datum occurs in the package source (forward coverage)", () => {
			for (const datum of entry.data) {
				expect(isNonEmptyString(datum.value)).toBe(true);
				expect(source).toContain(datum.value);
			}
		});
	});
});
