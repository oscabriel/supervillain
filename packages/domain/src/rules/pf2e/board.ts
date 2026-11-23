import { covers, squaresOf } from "../board/footprint.ts";
import type { Footprint } from "../board/footprint.ts";
import { formatSquare, standable, terrainAt } from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import { blocks, cheapestPath, corner, reachable } from "../board/movement.ts";
import type { Occupants, Path, Step, Walk } from "../board/movement.ts";
import { isRanged, meleeReach, reachOfStrike } from "./sheets.ts";
import type { PfStrike } from "./sheets.ts";
import {
	canAct,
	findCreature,
	isDead,
	mapSide,
	occupantsOf,
	spaceOfCreature,
} from "./state.ts";
import type { PfCreature, PfState } from "./state.ts";

export type Parity = 0 | 1;

export const SQUARE_FEET = 5;

export type MoveKind = "stride" | "step" | "crawl" | "move";

export interface PfMover {
	readonly side: "heroes" | "director";
	readonly footprint: Footprint;
	readonly tiny: boolean;
}

export const moverOf = (c: PfCreature): PfMover => ({
	side: mapSide(c),
	...spaceOfCreature(c),
});

const minus = (a: Square, b: Square): Square => ({
	x: a.x - b.x,
	y: a.y - b.y,
});

export const flip = (p: Parity): Parity => (p === 0 ? 1 : 0);

export const pfWalk = (
	terrain: ReadonlyArray<string>,
	mover: PfMover,
	occupants: Occupants,
	parity: Parity,
	careful: boolean
): Walk<Parity> => ({
	carry: parity,
	key: String,
	step: (from, to, carry): Step<Parity> | undefined => {
		const step = minus(to, from);
		const diagonal = step.x !== 0 && step.y !== 0;
		const landing = squaresOf(to, mover.footprint);

		const entered = landing.filter(
			(square) => !covers(from, mover.footprint, square)
		);

		const open =
			landing.every((square) => standable(terrain, square)) &&
			!squaresOf(from, mover.footprint).some((square) =>
				corner(terrain, square, step)
			) &&
			!entered.some((square) => {
				const there = occupants(square);

				return (
					there !== undefined &&
					there.side !== mover.side &&
					blocks(there, mover)
				);
			});

		const difficult = entered.some(
			(square) => terrainAt(terrain, square) === "difficult"
		);

		if (!open || (careful && difficult)) {
			return undefined;
		}

		const base =
			diagonal && carry === 1 && !careful ? 2 * SQUARE_FEET : SQUARE_FEET;

		return {
			cost: base + (difficult ? SQUARE_FEET : 0),
			carry: diagonal ? flip(carry) : carry,
		};
	},
});

export interface Route {
	readonly path: ReadonlyArray<Square>;
	readonly feet: number;
	readonly parity: Parity;
}

const parityAfter = (
	from: Square,
	path: ReadonlyArray<Square>,
	parity: Parity
): Parity => {
	let here = from;
	let carry = parity;

	for (const next of path) {
		if (next.x !== here.x && next.y !== here.y) {
			carry = flip(carry);
		}

		here = next;
	}

	return carry;
};

export const routeTo = (
	slice: PfState,
	c: PfCreature,
	to: Square,
	parity: Parity,
	careful: boolean
): Route | undefined => {
	const { map } = slice;

	if (map === undefined || c.at === undefined) {
		return undefined;
	}

	const found: Path | undefined = cheapestPath(
		map.terrain,
		c.at,
		to,
		pfWalk(map.terrain, moverOf(c), occupantsOf(slice, c.id), parity, careful)
	);

	return found === undefined
		? undefined
		: {
				path: found.path,
				feet: found.cost,
				parity: parityAfter(c.at, found.path, parity),
			};
};

export const reachableFrom = (
	slice: PfState,
	c: PfCreature,
	feet: number,
	parity: Parity
): ReadonlyArray<Square> => {
	const { map } = slice;

	if (map === undefined || c.at === undefined) {
		return [];
	}

	const mover = moverOf(c);
	const occupants = occupantsOf(slice, c.id);

	return reachable(
		map.terrain,
		c.at,
		feet,
		pfWalk(map.terrain, mover, occupants, parity, false),
		occupants,
		mover
	);
};

export const cantStand = (
	slice: PfState,
	c: PfCreature,
	at: Square
): string | undefined => {
	const terrain = slice.map?.terrain ?? [];
	const mover = moverOf(c);
	const named = formatSquare(at);
	const occupants = occupantsOf(slice, c.id);

	for (const square of squaresOf(at, mover.footprint)) {
		const kind = terrainAt(terrain, square);

		if (kind === "wall") {
			return `${named} is a wall.`;
		}

		if (kind === "outside") {
			return `${named} is outside the map.`;
		}

		const there = occupants(square);

		if (there !== undefined && blocks(there, mover)) {
			return `${named} is taken by ${findCreature(slice, there.id)?.name ?? there.id}.`;
		}
	}

	return undefined;
};

const gap = (a: number, af: number, b: number, bf: number): number =>
	Math.max(0, b - (a + af - 1), a - (b + bf - 1));

export interface Apart {
	readonly dx: number;
	readonly dy: number;
}

export const apartOf = (a: PfCreature, b: PfCreature): Apart | undefined => {
	if (a.at === undefined || b.at === undefined) {
		return undefined;
	}

	const af = spaceOfCreature(a).footprint;
	const bf = spaceOfCreature(b).footprint;

	return {
		dx: gap(a.at.x, af, b.at.x, bf),
		dy: gap(a.at.y, af, b.at.y, bf),
	};
};

export const feetOf = ({ dx, dy }: Apart): number => {
	const diagonal = Math.min(dx, dy);
	const straight = Math.max(dx, dy) - diagonal;

	return SQUARE_FEET * (straight + diagonal + Math.floor(diagonal / 2));
};

export const feetBetween = (
	a: PfCreature,
	b: PfCreature
): number | undefined => {
	const apart = apartOf(a, b);

	return apart === undefined ? undefined : feetOf(apart);
};

export const inReach = (apart: Apart, reach: number): boolean =>
	feetOf(apart) <= reach ||
	(reach === 2 * SQUARE_FEET && apart.dx <= 2 && apart.dy <= 2);

export const MAX_INCREMENTS = 6;

export interface RangeCheck {
	readonly penalty: number;
	readonly feet?: number;
	readonly refusal?: string;
}

export const rangeCheck = (
	attacker: PfCreature,
	target: PfCreature,
	strike: PfStrike
): RangeCheck => {
	const apart = apartOf(attacker, target);

	if (apart === undefined) {
		return { penalty: 0 };
	}

	const feet = feetOf(apart);
	const { range } = strike;

	if (range === undefined || !isRanged(strike)) {
		const reach = reachOfStrike(strike);

		return inReach(apart, reach)
			? { penalty: 0, feet }
			: {
					penalty: 0,
					feet,
					refusal: `${target.name} is ${feet} ft away; ${attacker.name}'s ${strike.name} reaches ${reach} ft.`,
				};
	}

	const increments = Math.max(1, Math.ceil(feet / Math.max(1, range)));

	if (increments > MAX_INCREMENTS) {
		return {
			penalty: 0,
			feet,
			refusal: `${target.name} is ${feet} ft away, past ${MAX_INCREMENTS} range increments of ${range} ft.`,
		};
	}

	return { penalty: -2 * (increments - 1), feet };
};

interface Point {
	readonly x: number;
	readonly y: number;
}

const centre = (c: PfCreature, at: Square): Point => {
	const { footprint } = spaceOfCreature(c);

	return { x: at.x + footprint / 2, y: at.y + footprint / 2 };
};

type Side = "left" | "right" | "top" | "bottom";

const EPSILON = 1e-9;

const nearly = (a: number, b: number): boolean => Math.abs(a - b) < EPSILON;

const sidesAt = (
	p: Point,
	box: { readonly x0: number; readonly y0: number; readonly size: number }
): ReadonlyArray<Side> => {
	const edges: ReadonlyArray<readonly [Side, number, number]> = [
		["left", p.x, box.x0],
		["right", p.x, box.x0 + box.size],
		["top", p.y, box.y0],
		["bottom", p.y, box.y0 + box.size],
	];

	return edges.flatMap(([side, a, b]) => (nearly(a, b) ? [side] : []));
};

const clip = (
	a: Point,
	b: Point,
	box: { readonly x0: number; readonly y0: number; readonly size: number }
): { readonly enter: Point; readonly exit: Point } | undefined => {
	let t0 = 0;
	let t1 = 1;
	const dx = b.x - a.x;
	const dy = b.y - a.y;

	const edges: ReadonlyArray<readonly [number, number]> = [
		[-dx, a.x - box.x0],
		[dx, box.x0 + box.size - a.x],
		[-dy, a.y - box.y0],
		[dy, box.y0 + box.size - a.y],
	];

	for (const [p, q] of edges) {
		if (Math.abs(p) < EPSILON) {
			if (q < 0) {
				return undefined;
			}
		} else {
			const r = q / p;

			if (p < 0) {
				t0 = Math.max(t0, r);
			} else {
				t1 = Math.min(t1, r);
			}
		}
	}

	if (t0 > t1 - EPSILON) {
		return undefined;
	}

	return {
		enter: { x: a.x + t0 * dx, y: a.y + t0 * dy },
		exit: { x: a.x + t1 * dx, y: a.y + t1 * dy },
	};
};

const OPPOSITE: ReadonlyArray<readonly [Side, Side]> = [
	["left", "right"],
	["right", "left"],
	["top", "bottom"],
	["bottom", "top"],
];

export const crossesOpposite = (
	from: Point,
	to: Point,
	box: { readonly x0: number; readonly y0: number; readonly size: number }
): boolean => {
	const through = clip(from, to, box);

	if (through === undefined) {
		return false;
	}

	const enter = sidesAt(through.enter, box);
	const exit = sidesAt(through.exit, box);

	return OPPOSITE.some(([a, b]) => enter.includes(a) && exit.includes(b));
};

export const flankedBy = (
	slice: PfState,
	attacker: PfCreature,
	target: PfCreature,
	reach: number
): PfCreature | undefined => {
	const from = attacker.at;
	const there = target.at;
	const apart = apartOf(attacker, target);

	if (
		from === undefined ||
		there === undefined ||
		apart === undefined ||
		!inReach(apart, reach)
	) {
		return undefined;
	}

	const box = {
		x0: there.x,
		y0: there.y,
		size: spaceOfCreature(target).footprint,
	};

	return slice.creatures.find((ally) => {
		const { at } = ally;
		const near = apartOf(ally, target);

		return (
			ally.id !== attacker.id &&
			ally.id !== target.id &&
			ally.side === attacker.side &&
			at !== undefined &&
			near !== undefined &&
			!isDead(ally) &&
			canAct(ally) &&
			inReach(near, meleeReach(ally.sheet)) &&
			crossesOpposite(centre(attacker, from), centre(ally, at), box)
		);
	});
};
