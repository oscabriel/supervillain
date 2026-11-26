import type { Square } from "./grid.ts";

export type Footprint = 1 | 2 | 3 | 4;

const SIZE = /^\s*(?<n>\d+)/u;

export const footprintOf = (size: string | undefined): Footprint => {
	const n = Number(SIZE.exec(size ?? "")?.groups?.n ?? "1");

	if (n >= 4) {
		return 4;
	}

	if (n === 3) {
		return 3;
	}

	return n === 2 ? 2 : 1;
};

export const squaresOf = (
	at: Square,
	footprint: Footprint = 1
): ReadonlyArray<Square> =>
	Array.from({ length: footprint * footprint }, (_, i) => ({
		x: at.x + (i % footprint),
		y: at.y + Math.floor(i / footprint),
	}));

export const covers = (
	at: Square,
	footprint: Footprint,
	square: Square
): boolean =>
	square.x >= at.x &&
	square.x < at.x + footprint &&
	square.y >= at.y &&
	square.y < at.y + footprint;

const gap = (a: number, af: number, b: number, bf: number): number =>
	Math.max(0, b - (a + af - 1), a - (b + bf - 1));

export const apart = (
	a: Square,
	af: Footprint,
	b: Square,
	bf: Footprint
): number => Math.max(gap(a.x, af, b.x, bf), gap(a.y, af, b.y, bf));

export const overlaps = (
	a: Square,
	af: Footprint,
	b: Square,
	bf: Footprint
): boolean => apart(a, af, b, bf) === 0;

export const centreOf = (at: Square, footprint: Footprint): Square => ({
	x: at.x + (footprint - 1) / 2,
	y: at.y + (footprint - 1) / 2,
});
