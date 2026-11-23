import type { Html, HtmlBuilder } from "foldkit/html";

import type { Square } from "./Encounter.ts";
import type { Message } from "./Model.ts";

export type MekTone =
	| "ground"
	| "grass"
	| "tree"
	| "rock"
	| "water"
	| "stone"
	| "floor";

export interface MekSwatch {
	readonly fg: string;
	readonly bg: string;
}

export const MEK_TONES: Readonly<Record<MekTone, MekSwatch>> = {
	ground: { fg: "#7b8068", bg: "#141612" },
	grass: { fg: "#78a656", bg: "#111910" },
	tree: { fg: "#579846", bg: "#0e170e" },
	rock: { fg: "#9f988a", bg: "#191816" },
	water: { fg: "#68acd9", bg: "#0d1b26" },
	stone: { fg: "#b7b1a1", bg: "#1f1f24" },
	floor: { fg: "#938b7c", bg: "#1a1916" },
};

export const MEK_REACH_BG = "#1f3d3d";

export const MEK_SIDES = {
	you: "#98c379",
	foe: "#e06c75",
	dead: "#6e7380",
	director: "#c678dd",
} as const;

const BITMAPS: ReadonlyMap<string, string> = new Map(
	Object.entries({
		"3": "1c183cbebebabaa4b8282828",
		"%": "72377afafafebe7a3a3a7afa",
		"*": "1819117d557d573b2a2a2a2a",
		"7": "18d8c8beaabeca9c9c5c5e5f",
		"@": "1c3c2c5e1e1e1e1c1e3e3e7e",
		a: "006b00c40073009a004f00c8",
		A: "007700ee007700ee007700ee",
		i: "000c3e7e7e7c3e3e1408081c",
		k: "007e3c181818181818183c7e",
		o: "00080c1c1e3e3e1e1408081c",
		q: "000020000004000000100000",
		r: "3278066ff0028c1e60f60f40",
		s: "00fb00df00fb00df00fb00df",
		t: "67f6f2684d9d9e4ee0eede18",
		T: "8777faf8f8726f5f1ebdbddb",
		u: "00000000021409aa4a4a2a2a",
		U: "004828905552525454545454",
		w: "01001005025020000a045000",
		x: "0044bb0044bb0044bb0044bb",
		z: "00cc3300cc3300cc3300cc33",
		Z: "00f00f00f00f00f00f00f00f",
	})
);

const TONE_OF: ReadonlyMap<string, MekTone> = new Map<string, MekTone>([
	["a", "floor"],
	["A", "floor"],
	["i", "tree"],
	["k", "stone"],
	["o", "tree"],
	["q", "ground"],
	["r", "rock"],
	["s", "stone"],
	["t", "rock"],
	["T", "rock"],
	["u", "grass"],
	["U", "grass"],
	["w", "grass"],
	["x", "water"],
	["z", "water"],
	["Z", "water"],
]);

export const FORD_DRESSING: ReadonlyArray<string> = [
	"uqwuaaaauqwwuu",
	"uskuaaaauuzzwu",
	"qiqwaaaauuZxwu",
	"aaaaaaaaaazzaa",
	"uquaaaaaaaZzuo",
	"uwwutquuquxZwT",
	"qwuquuqwuuqwuq",
];

const FIGHTER_FIGURES: ReadonlyMap<string, string> = new Map([
	["brann", "3"],
	["bandit-bruiser", "%"],
	["bandit-slinger", "*"],
]);

const bitmapToPath = (hex: string): string => {
	const commands: Array<string> = [];

	for (let row = 0; row < 12; row += 1) {
		const bits = Number.parseInt(hex.slice(row * 2, row * 2 + 2), 16);
		let col = 0;

		while (col < 8) {
			const on = Math.floor(bits / 2 ** (7 - col)) % 2 === 1;

			if (!on) {
				col += 1;
				continue;
			}

			const start = col;

			while (col < 8 && Math.floor(bits / 2 ** (7 - col)) % 2 === 1) {
				col += 1;
			}

			commands.push(`M${start} ${row}h${col - start}v1h-${col - start}Z`);
		}
	}

	return commands.join("");
};

const PATHS: ReadonlyMap<string, string> = new Map(
	[...BITMAPS.entries()].map(([letter, hex]) => [letter, bitmapToPath(hex)])
);

export const pathOfGlyph = (letter: string): string => PATHS.get(letter) ?? "";

export const figureOfFighter = (id: string): string =>
	FIGHTER_FIGURES.get(id) ?? "3";

export const dressingAt = (square: Square, terrain: string): string => {
	const dressed = FORD_DRESSING[square.y]?.[square.x];

	if (dressed !== undefined) {
		return dressed;
	}

	if (terrain === "#") {
		return "s";
	}

	return terrain === "~" ? "z" : "q";
};

export const swatchOf = (letter: string): MekSwatch => {
	const tone = TONE_OF.get(letter) ?? "ground";

	return MEK_TONES[tone];
};

export const mekSvg = (
	h: HtmlBuilder<Message>,
	letter: string,
	color: string,
	className: string
): Html =>
	h.svg(
		[
			h.ViewBox("0 0 8 12"),
			h.ShapeRendering("crispEdges"),
			h.Class(className),
			h.AriaHidden(true),
		],
		[h.path([h.D(pathOfGlyph(letter)), h.Fill(color)], [])]
	);
