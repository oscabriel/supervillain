/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite: the harness picks the runner. */
import { readFile } from "node:fs/promises";

import { validateSnapshotDocument } from "../src/index.js";
import type { SnapshotDocument, SnapshotMapGridV1 } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const fixture = async (name: string): Promise<unknown> =>
	JSON.parse(
		await readFile(new URL(`fixtures/${name}.json`, import.meta.url), "utf-8")
	) as unknown;

const stringsInMap = (map: SnapshotMapGridV1): readonly string[] => [
	map.name,
	...Object.keys(map.legend),
	...Object.values(map.legend),
	...map.rows,
];

/** The web-side proof: walk every document using only core discriminants and
 * semantic strings. This test imports no game package and performs no layout. */
const walkSnapshot = (document: SnapshotDocument): readonly string[] => {
	const strings = [
		document.card.title,
		document.card.description,
		...document.card.fields.flatMap(({ label, value }) => [label, value]),
		...(document.card.glyph === undefined ? [] : [document.card.glyph]),
		...(document.card.accentHint === undefined
			? []
			: [document.card.accentHint]),
	];
	if (document.artifactType === "character") {
		return [
			...strings,
			...document.sections.flatMap((section) => [
				section.title,
				...section.fields.flatMap(({ label, value }) => [label, value]),
			]),
		];
	}
	if (document.artifactType === "map") {
		return [...strings, ...stringsInMap(document.map)];
	}
	return [
		...strings,
		...document.entries.flatMap((entry) => {
			if (entry.block.type === "map-grid") {
				return [entry.timestamp, ...stringsInMap(entry.block)];
			}
			return [
				entry.timestamp,
				...entry.block.runs.flatMap((run) => [
					run.text,
					run.token,
					...(run.attrs ?? []),
				]),
			];
		}),
	];
};

const expectRejected = (value: unknown): void => {
	expect(validateSnapshotDocument(value).ok).toBe(false);
};

describe("snapshot document version 1", () => {
	test("validates the semantic character fixture", async () => {
		const validated = validateSnapshotDocument(
			await fixture("snapshot-v1-character")
		);
		expect(validated).toEqual({
			document: await fixture("snapshot-v1-character"),
			ok: true,
		});
		if (!validated.ok) {
			throw new Error("character snapshot was rejected");
		}
		expect(validated.document.artifactType).toBe("character");
		expect(validated.document.sections[0]?.fields[0]).toEqual({
			label: "ancestry",
			value: "Human",
		});
	});

	test("validates timestamped text and inline map blocks in the log fixture", async () => {
		const validated = validateSnapshotDocument(
			await fixture("snapshot-v1-log")
		);
		expect(validated.ok).toBe(true);
		if (!validated.ok || validated.document.artifactType !== "log") {
			throw new Error("log snapshot was rejected");
		}
		expect(
			validated.document.entries.map(({ timestamp }) => timestamp.slice(0, 10))
		).toEqual(["2026-07-21", "2026-07-22", "2026-07-22"]);
		expect(validated.document.entries.map(({ block }) => block.type)).toEqual([
			"text",
			"map-grid",
			"text",
		]);
		const first = validated.document.entries[0]?.block;
		expect(first?.type === "text" ? first.runs[0] : undefined).toEqual({
			attrs: ["bold"],
			text: "Coda: ",
			token: "accent",
		});
	});

	test("reuses the inline map-grid vocabulary for a map artifact", async () => {
		const validated = validateSnapshotDocument(
			await fixture("snapshot-v1-map")
		);
		expect(validated.ok).toBe(true);
		if (!validated.ok || validated.document.artifactType !== "map") {
			throw new Error("map snapshot was rejected");
		}
		expect(validated.document.map).toEqual({
			legend: {
				"#": "wall",
				"+": "door",
				".": "floor",
				"~": "difficult",
			},
			name: "Ember Gate",
			rows: ["######", "#..+.#", "#~~~~#", "######"],
			type: "map-grid",
		});
	});

	test("round-trips every fixture through validation and a game-blind walk", async () => {
		const names = [
			"snapshot-v1-character",
			"snapshot-v1-log",
			"snapshot-v1-map",
		] as const;
		const fixtures = await Promise.all(names.map(fixture));
		for (const [index, decoded] of fixtures.entries()) {
			const name = names[index];
			// oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON round-trip is the wire-contract assertion.
			const roundTripped = JSON.parse(JSON.stringify(decoded)) as unknown;
			const validated = validateSnapshotDocument(roundTripped);
			if (!validated.ok) {
				throw new Error(`${name} was rejected`);
			}
			const walked = walkSnapshot(validated.document);
			expect(walked.length).toBeGreaterThan(0);
			expect(walked.every((value) => typeof value === "string")).toBe(true);
		}
	});

	test("pins schema version 1 and the closed artifact set", async () => {
		const character = await fixture("snapshot-v1-character");
		if (typeof character !== "object" || character === null) {
			throw new Error("character fixture is not an object");
		}
		for (const schemaVersion of [undefined, "1", 1.5, 2]) {
			expectRejected({ ...character, schemaVersion });
		}
		expectRejected({ ...character, artifactType: "journal" });
	});

	test("refuses layout vocabulary and non-string card data", async () => {
		const character = (await fixture("snapshot-v1-character")) as Record<
			string,
			unknown
		>;
		expectRejected({ ...character, layout: { columns: 2 } });
		expectRejected({
			...character,
			card: {
				...(character.card as Record<string, unknown>),
				fields: [{ label: "stamina", value: 20 }],
			},
		});
		expectRejected({
			...character,
			card: {
				...(character.card as Record<string, unknown>),
				glyph: " ",
			},
		});
	});

	test("refuses ANSI, unknown text intent, and ambiguous timestamps", async () => {
		const log = (await fixture("snapshot-v1-log")) as Record<string, unknown>;
		const entries = structuredClone(log.entries) as Record<string, unknown>[];
		const firstBlock = entries[0]?.block as Record<string, unknown>;
		const firstRuns = firstBlock.runs as Record<string, unknown>[];
		firstRuns[0] = { ...firstRuns[0], text: "\u001B[31mred" };
		expectRejected({ ...log, entries });

		const wrongToken = structuredClone(log.entries) as Record<
			string,
			unknown
		>[];
		const tokenBlock = wrongToken[0]?.block as Record<string, unknown>;
		const tokenRuns = tokenBlock.runs as Record<string, unknown>[];
		tokenRuns[0] = { ...tokenRuns[0], token: "#ff0000" };
		expectRejected({ ...log, entries: wrongToken });

		const blink = structuredClone(log.entries) as Record<string, unknown>[];
		const blinkBlock = blink[0]?.block as Record<string, unknown>;
		const blinkRuns = blinkBlock.runs as Record<string, unknown>[];
		blinkRuns[0] = { ...blinkRuns[0], attrs: ["blink"] };
		expectRejected({ ...log, entries: blink });

		const localTime = structuredClone(log.entries) as Record<string, unknown>[];
		localTime[0] = {
			...localTime[0],
			timestamp: "2026-07-21T23:58:00-04:00",
		};
		expectRejected({ ...log, entries: localTime });
	});

	test("refuses invalid or token-bearing map grids", async () => {
		const map = (await fixture("snapshot-v1-map")) as Record<string, unknown>;
		const grid = map.map as Record<string, unknown>;
		expectRejected({
			...map,
			map: { ...grid, rows: ["####", "#..#", "###"] },
		});
		expectRejected({
			...map,
			map: { ...grid, legend: { ".": "lava" }, rows: ["."] },
		});
		expectRejected({
			...map,
			map: { ...grid, tokens: [{ glyph: "@", x: 1, y: 1 }] },
		});
	});
});
