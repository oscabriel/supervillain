/**
 * The table's typed command line. Everything the battle map needs beyond
 * cursor keys — a glyph, a label, a map name — arrives here, so every map
 * manipulation stays reachable by keyboard alone.
 */
export type ParsedInput =
	| { readonly kind: "empty" }
	| { readonly kind: "chat"; readonly text: string }
	| { readonly kind: "roll"; readonly notation: string }
	| { readonly kind: "quit" }
	| { readonly kind: "load-map"; readonly name: string }
	| { readonly kind: "clear-map" }
	| {
			readonly kind: "place-token";
			readonly glyph: string;
			readonly label: string;
			readonly seatId: string | null;
	  }
	| { readonly kind: "reglyph-token"; readonly glyph: string }
	| { readonly kind: "remove-token" }
	| { readonly kind: "usage"; readonly message: string }
	| { readonly kind: "unknown-command"; readonly command: string };

const MAP_USAGE = "Usage: /map load <name> | /map clear";
const TOKEN_USAGE =
	"Usage: /token place <glyph> [label] [@seat] | /token glyph <glyph> | /token remove";

const WHITESPACE = /\s+/u;
const SEAT_ARGUMENT = /^@(?<seatId>\S+)$/u;

const parseMap = (words: readonly string[]): ParsedInput => {
	const [verb, ...rest] = words;
	if (verb === "clear" && rest.length === 0) {
		return { kind: "clear-map" };
	}
	const name = rest.join(" ");
	if (verb === "load" && name !== "") {
		return { kind: "load-map", name };
	}
	return { kind: "usage", message: MAP_USAGE };
};

const parsePlace = (words: readonly string[]): ParsedInput => {
	const [glyph, ...rest] = words;
	if (glyph === undefined || [...glyph].length !== 1) {
		return { kind: "usage", message: TOKEN_USAGE };
	}
	const seatWord = rest.at(-1);
	const seatId =
		seatWord === undefined
			? null
			: (SEAT_ARGUMENT.exec(seatWord)?.groups?.seatId ?? null);
	const labelWords = seatId === null ? rest : rest.slice(0, -1);
	return { glyph, kind: "place-token", label: labelWords.join(" "), seatId };
};

const parseToken = (words: readonly string[]): ParsedInput => {
	const [verb, ...rest] = words;
	if (verb === "place") {
		return parsePlace(rest);
	}
	if (verb === "glyph") {
		const [glyph] = rest;
		return glyph !== undefined && rest.length === 1 && [...glyph].length === 1
			? { glyph, kind: "reglyph-token" }
			: { kind: "usage", message: TOKEN_USAGE };
	}
	if (verb === "remove" && rest.length === 0) {
		return { kind: "remove-token" };
	}
	return { kind: "usage", message: TOKEN_USAGE };
};

export const parseInput = (line: string): ParsedInput => {
	const trimmed = line.trim();
	if (trimmed === "") {
		return { kind: "empty" };
	}
	if (trimmed === "/quit") {
		return { kind: "quit" };
	}
	if (trimmed === "/roll" || trimmed.startsWith("/roll ")) {
		return { kind: "roll", notation: trimmed.slice(5).trim() };
	}
	if (trimmed.startsWith("/")) {
		const [verb, ...words] = trimmed.split(WHITESPACE);
		if (verb === "/map") {
			return parseMap(words);
		}
		if (verb === "/token") {
			return parseToken(words);
		}
		return { command: verb ?? trimmed, kind: "unknown-command" };
	}
	return { kind: "chat", text: trimmed };
};
