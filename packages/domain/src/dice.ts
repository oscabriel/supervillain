import type { Refused } from "./rules/engine.ts";
import { quote } from "./text.ts";

const MAX_DICE = 100;

const MAX_SIDES = 1000;

export const MAX_MODIFIER = 1000;

const NOTATION = /^(?<count>\d*)d(?<sides>\d+)(?<modifier>[+-]\d+)?$/u;

export interface Notation {
	readonly count: number;
	readonly sides: number;
	readonly modifier: number;
	readonly text: string;
}

export const signed = (n: number): string => {
	if (n === 0) {
		return "";
	}

	return n > 0 ? `+${n}` : `${n}`;
};

export const parseNotation = (input: string): Notation | Refused => {
	const compact = input.replaceAll(/\s+/gu, "").toLowerCase();
	const groups = NOTATION.exec(compact)?.groups;

	if (groups === undefined) {
		return {
			refusal: `"${quote(input)}" isn't dice; try 2d10+3, d20 or 3d6-1.`,
		};
	}

	const { count: counted = "", sides: faces = "", modifier: plus } = groups;
	const count = counted === "" ? 1 : Number(counted);
	const sides = Number(faces);
	const modifier = plus === undefined ? 0 : Number(plus);

	if (count < 1 || count > MAX_DICE) {
		return { refusal: `Roll 1 to ${MAX_DICE} dice at a time.` };
	}

	if (sides < 2 || sides > MAX_SIDES) {
		return { refusal: `Dice have 2 to ${MAX_SIDES} sides.` };
	}

	if (Math.abs(modifier) > MAX_MODIFIER) {
		return { refusal: `Keep the modifier within ${MAX_MODIFIER}.` };
	}

	return {
		count,
		sides,
		modifier,
		text: `${count}d${sides}${signed(modifier)}`,
	};
};
