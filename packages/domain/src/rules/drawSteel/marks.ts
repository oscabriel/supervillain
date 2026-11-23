import { charsOf } from "../../text.ts";
import type { Who } from "./state.ts";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const DIGITS = "0123456789";

const ALNUM = LETTERS + DIGITS;

const OVERFLOW = DIGITS + charsOf(LETTERS).toReversed().join("");

const wordsOf = (name: string): Array<string> =>
	name
		.normalize("NFKD")
		.toLowerCase()
		.replaceAll(/[^a-z0-9 ]/gu, "")
		.split(" ")
		.filter((w) => w !== "");

interface Wanted {
	readonly own: ReadonlyArray<string>;
	readonly pairs: string;
}

const NUMBERED = /-(?<number>\d+)$/u;

const SQUAD_LETTER = /-(?<letter>[a-z])$/u;

const wanted = (who: Who): Wanted => {
	if (who.kind === "hero") {
		const [first = "", ...rest] = wordsOf(who.name).join("");
		const initial = first.toUpperCase();

		return {
			own:
				initial === "" ? [] : [initial, ...rest.map((c) => `${initial}${c}`)],
			pairs: ALNUM,
		};
	}

	const { creature } = who;
	const numbered = NUMBERED.exec(creature.id)?.groups?.number;

	const squad =
		creature.squad === undefined
			? undefined
			: SQUAD_LETTER.exec(creature.id)?.groups?.letter;

	const suffix = squad?.toUpperCase() ?? numbered;
	const words = wordsOf(creature.name);

	if (
		suffix !== undefined &&
		words.at(-1)?.toUpperCase() === suffix.toUpperCase()
	) {
		words.pop();
	}

	const initials = words.map((w) => w.slice(0, 1)).toReversed();

	if (numbered !== undefined && squad === undefined && numbered.length > 1) {
		return {
			own: initials.slice(0, 1).map((i) => `${i}${numbered.at(-1)}`),
			pairs: OVERFLOW,
		};
	}

	if (suffix !== undefined) {
		return { own: initials.map((i) => `${i}${suffix}`), pairs: ALNUM };
	}

	const [first, ...later] = initials;

	return {
		own:
			first === undefined ? [] : [first, ...later.map((i) => `${first}${i}`)],
		pairs: ALNUM,
	};
};

const free = (
	taken: ReadonlySet<string>,
	candidates: Iterable<string>
): string | undefined => {
	for (const m of candidates) {
		if (!taken.has(m)) {
			return m;
		}
	}

	return undefined;
};

const pairs = (initial: string, chars: string): ReadonlyArray<string> =>
	charsOf(chars).map((c) => `${initial}${c}`);

const ANY_PAIR: ReadonlyArray<string> = charsOf(ALNUM).flatMap((a) =>
	charsOf(ALNUM).map((b) => `${a}${b}`)
);

export const marksOf = (
	everyone: ReadonlyArray<Who>
): ReadonlyMap<string, string> => {
	const taken = new Set<string>();
	const result = new Map<string, string>();

	for (const who of everyone) {
		const { own, pairs: chars } = wanted(who);
		const initial = own[0]?.[0] ?? (who.kind === "hero" ? "X" : "x");

		const mark =
			free(taken, own) ??
			free(taken, pairs(initial, chars)) ??
			free(taken, ANY_PAIR) ??
			"??";

		taken.add(mark);
		result.set(who.id, mark);
	}

	return result;
};
