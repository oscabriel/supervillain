/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite: the harness picks the runner. */
import { readFile } from "node:fs/promises";

import {
	DEFAULT_MAP_LEGEND,
	isValidMapName,
	MAP_MAX_HEIGHT,
	MAP_MAX_WIDTH,
	mapFilePath,
	parseMapFile,
	readMapLoadedPayload,
	validateMapFile,
} from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const DEFAULT_FILE = `name: Cavern Mouth
---
#####
#...#
#.^.#
##+##
`;

const messagesOf = (text: string): readonly string[] => {
	const parsed = parseMapFile(bytes(text));
	if (parsed.ok) {
		throw new Error("expected the map file to be rejected.");
	}
	return parsed.errors.map((error) => error.message);
};

describe("parseMapFile", () => {
	test("accepts the GM-facing sample file shipped with the docs", async () => {
		const sample = await readFile(
			new URL("../../../docs/examples/cavern.map", import.meta.url)
		);
		expect(parseMapFile(sample).ok).toBe(true);
	});

	test("parses a header, the default legend, and the grid verbatim", () => {
		const parsed = parseMapFile(bytes(DEFAULT_FILE));
		expect(parsed).toEqual({
			map: {
				legend: DEFAULT_MAP_LEGEND,
				name: "Cavern Mouth",
				rows: ["#####", "#...#", "#.^.#", "##+##"],
			},
			ok: true,
		});
	});

	test("lets a declared legend replace the default, keeping author characters", () => {
		const parsed = parseMapFile(
			bytes(`name: Bog
legend: o floor
legend: X wall
legend: , difficult
---
XXXX
XooX
X,oX
XXXX
`)
		);
		expect(parsed).toEqual({
			map: {
				legend: { ",": "difficult", X: "wall", o: "floor" },
				name: "Bog",
				rows: ["XXXX", "XooX", "X,oX", "XXXX"],
			},
			ok: true,
		});
	});

	test("tolerates CRLF line endings, blank header lines, and no final newline", () => {
		const parsed = parseMapFile(bytes("name: Hall\r\n\r\n---\r\n..\r\n.."));
		expect(parsed).toEqual({
			map: { legend: DEFAULT_MAP_LEGEND, name: "Hall", rows: ["..", ".."] },
			ok: true,
		});
	});

	test("rejects a file with no separator line", () => {
		expect(messagesOf("name: Hall\n..\n")).toEqual([
			"Map file must separate its header from its grid with a '---' line.",
		]);
	});

	test("rejects a header with no name, an unknown key, or a repeated name", () => {
		expect(messagesOf("---\n..\n")).toEqual(["Header must declare a 'name'."]);
		expect(messagesOf("name: Hall\nauthor: me\n---\n..\n")).toEqual([
			"Header key 'author' is not one of name, legend.",
		]);
		expect(messagesOf("name: Hall\nname: Hall\n---\n..\n")).toEqual([
			"Header declares 'name' more than once.",
		]);
	});

	test("rejects malformed legend lines", () => {
		expect(messagesOf("name: Hall\nlegend: floor\n---\n..\n")).toEqual([
			"Legend line 'legend: floor' must read '<character> <tile>'.",
			"Row 1 uses character '.', which the legend does not define.",
		]);
		expect(messagesOf("name: Hall\nlegend: . water\n---\n..\n")).toEqual([
			"Legend names unknown tile 'water'; use one of difficult, door, floor, hazard, wall.",
			"Row 1 uses character '.', which the legend does not define.",
		]);
		expect(
			messagesOf("name: Hall\nlegend: . floor\nlegend: . wall\n---\n..\n")
		).toEqual(["Legend defines character '.' more than once."]);
	});

	test("rejects a ragged grid and characters the legend does not define", () => {
		expect(messagesOf("name: Hall\n---\n...\n..\n")).toEqual([
			"Row 2 is 2 cells wide; row 1 is 3. Every row must be the same width.",
		]);
		expect(messagesOf("name: Hall\n---\n.x.\n...\n")).toEqual([
			"Row 1 uses character 'x', which the legend does not define.",
		]);
	});

	test("rejects an empty grid", () => {
		expect(messagesOf("name: Hall\n---\n")).toEqual(["Map grid is empty."]);
	});

	test("rejects a grid past the ~200x100 bound", () => {
		const wide = `name: Wide\n---\n${".".repeat(MAP_MAX_WIDTH + 1)}\n`;
		expect(messagesOf(wide)).toEqual([
			`Map grid is ${MAP_MAX_WIDTH + 1} cells wide; the limit is ${MAP_MAX_WIDTH}.`,
		]);
		const tall = `name: Tall\n---\n${"..\n".repeat(MAP_MAX_HEIGHT + 1)}`;
		expect(messagesOf(tall)).toEqual([
			`Map grid is ${MAP_MAX_HEIGHT + 1} rows tall; the limit is ${MAP_MAX_HEIGHT}.`,
		]);
	});

	test("accepts a grid exactly at the bound", () => {
		const atBound = `name: Edge\n---\n${`${".".repeat(MAP_MAX_WIDTH)}\n`.repeat(MAP_MAX_HEIGHT)}`;
		expect(parseMapFile(bytes(atBound)).ok).toBe(true);
	});

	test("rejects bytes that are not UTF-8", () => {
		const parsed = parseMapFile(new Uint8Array([255, 254]));
		expect(parsed).toEqual({
			errors: [{ message: "Map file must contain valid UTF-8 text." }],
			ok: false,
		});
	});
});

describe("validateMapFile", () => {
	test("wears the ContentValidator shape", () => {
		expect(validateMapFile(bytes(DEFAULT_FILE))).toEqual({ ok: true });
		expect(validateMapFile(bytes("name: Hall\n---\n"))).toEqual({
			errors: [{ message: "Map grid is empty." }],
			ok: false,
		});
	});
});

describe("isValidMapName", () => {
	test("accepts filename-safe names and refuses paths", () => {
		expect(["cavern", "Cavern_2", "a-b-c"].map(isValidMapName)).toEqual([
			true,
			true,
			true,
		]);
		expect(
			["", "../secret", "maps/cavern", "a b", "-lead", "x".repeat(61)].map(
				isValidMapName
			)
		).toEqual([false, false, false, false, false, false]);
	});

	test("addresses a map file inside the campaign folder", () => {
		expect(mapFilePath("cavern")).toBe("maps/cavern.map");
	});
});

describe("readMapLoadedPayload", () => {
	test("round-trips a parsed map through the payload", () => {
		const parsed = parseMapFile(bytes(DEFAULT_FILE));
		if (!parsed.ok) {
			throw new Error("expected the map file to parse.");
		}
		// oxlint-disable-next-line unicorn/prefer-structured-clone -- the payload reaches a fold as JSON off the log; the round trip is the claim.
		const payload = JSON.parse(JSON.stringify(parsed.map)) as unknown;
		expect(readMapLoadedPayload(payload)).toEqual(parsed.map);
	});

	test("reads a known-invalid payload as null", () => {
		const valid = {
			legend: { ".": "floor" },
			name: "Hall",
			rows: ["..", ".."],
		};
		expect(readMapLoadedPayload(valid)).toEqual(valid);
		const invalid: readonly unknown[] = [
			null,
			"map",
			{ ...valid, name: "" },
			{ ...valid, legend: {} },
			{ ...valid, legend: { ".": "water" } },
			{ ...valid, legend: { "..": "floor" } },
			{ ...valid, rows: ["..", null] },
			{ ...valid, rows: ["..", "."] },
			{ ...valid, rows: ["..", ".x"] },
			{ ...valid, rows: [] },
			{ legend: { ".": "floor" }, rows: [".."] },
		];
		expect(invalid.map(readMapLoadedPayload)).toEqual(invalid.map(() => null));
	});
});
