import { apart, centreOf, covers, overlaps, squaresOf } from "./footprint.ts";
import type { Footprint } from "./footprint.ts";
import { inBounds, sameSquare, standable, terrainAt, widthOf } from "./grid.ts";
import type { Square } from "./grid.ts";

export type { Footprint } from "./footprint.ts";

export interface Occupant {
	readonly id: string;
	readonly side: string;
	readonly footprint?: Footprint;
	readonly tiny?: boolean;
}

export type Occupants = (square: Square) => Occupant | undefined;

export interface Mover {
	readonly side: string;
	readonly prone: boolean;
	readonly footprint?: Footprint;
	readonly tiny?: boolean;
}

export type StepCost = (square: Square) => number;

export interface Step<C> {
	readonly cost: number;
	readonly carry: C;
}

export type Stepper<C> = (
	from: Square,
	to: Square,
	carry: C
) => Step<C> | undefined;

export interface Walk<C> {
	readonly step: Stepper<C>;
	readonly carry: C;
	readonly key?: (carry: C) => string;
}

export const STEPS: ReadonlyArray<Square> = [
	{ x: 0, y: -1 },
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 },
	{ x: 1, y: -1 },
	{ x: 1, y: 1 },
	{ x: -1, y: 1 },
	{ x: -1, y: -1 },
];

const plus = (a: Square, b: Square): Square => ({ x: a.x + b.x, y: a.y + b.y });

const minus = (a: Square, b: Square): Square => ({
	x: a.x - b.x,
	y: a.y - b.y,
});

export const corner = (
	terrain: ReadonlyArray<string>,
	from: Square,
	step: Square
): boolean => {
	if (step.x === 0 || step.y === 0) {
		return false;
	}

	return (
		terrainAt(terrain, { x: from.x + step.x, y: from.y }) === "wall" ||
		terrainAt(terrain, { x: from.x, y: from.y + step.y }) === "wall"
	);
};

export const blocks = (
	occupant: Occupant | undefined,
	mover?: Pick<Mover, "tiny">
): boolean =>
	occupant !== undefined && occupant.tiny !== true && mover?.tiny !== true;

export const fits = (
	terrain: ReadonlyArray<string>,
	at: Square,
	occupants: Occupants,
	mover?: Pick<Mover, "footprint" | "tiny">
): boolean =>
	squaresOf(at, mover?.footprint).every(
		(square) => standable(terrain, square) && !blocks(occupants(square), mover)
	);

export const stepCost =
	(
		terrain: ReadonlyArray<string>,
		mover: Mover,
		occupants: Occupants
	): StepCost =>
	(square) => {
		const there = occupants(square);

		const difficult =
			terrainAt(terrain, square) === "difficult" ||
			(there !== undefined && there.side !== mover.side);

		return 1 + (difficult ? 1 : 0) + (mover.prone ? 1 : 0);
	};

export const plainWalk = (
	terrain: ReadonlyArray<string>,
	cost: StepCost
): Walk<undefined> => ({
	carry: undefined,
	step: (from, to) =>
		standable(terrain, to) && !corner(terrain, from, minus(to, from))
			? { cost: cost(to), carry: undefined }
			: undefined,
});

export const moverWalk = (
	terrain: ReadonlyArray<string>,
	mover: Mover,
	occupants: Occupants
): Walk<undefined> => {
	const footprint = mover.footprint ?? 1;
	const cost = stepCost(terrain, mover, occupants);

	if (footprint === 1) {
		return plainWalk(terrain, cost);
	}

	return {
		carry: undefined,
		step: (from, to) => {
			const step = minus(to, from);
			const landing = squaresOf(to, footprint);

			const open =
				landing.every((square) => standable(terrain, square)) &&
				!squaresOf(from, footprint).some((square) =>
					corner(terrain, square, step)
				);

			const entered = landing.filter(
				(square) => !covers(from, footprint, square)
			);

			return open
				? { cost: Math.max(1, ...entered.map(cost)), carry: undefined }
				: undefined;
		},
	};
};

interface Queued {
	readonly cost: number;
	readonly seq: number;
	readonly state: number;
}

const before = (a: Queued, b: Queued): boolean =>
	a.cost < b.cost || (a.cost === b.cost && a.seq < b.seq);

const queue = () => {
	const items: Array<Queued> = [];

	const swap = (i: number, j: number) => {
		const a = items[i];
		const b = items[j];

		if (a !== undefined && b !== undefined) {
			items[i] = b;
			items[j] = a;
		}
	};

	const at = (i: number): Queued | undefined => items[i];

	const push = (item: Queued): void => {
		items.push(item);

		for (let i = items.length - 1; i > 0;) {
			const parent = Math.floor((i - 1) / 2);
			const child = at(i);
			const above = at(parent);

			if (child === undefined || above === undefined || !before(child, above)) {
				break;
			}

			swap(i, parent);
			i = parent;
		}
	};

	const pop = (): Queued | undefined => {
		const [top] = items;
		const last = items.pop();

		if (top === undefined || last === undefined || items.length === 0) {
			return top;
		}

		items[0] = last;

		for (let i = 0; ;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let least = i;

			for (const child of [left, right]) {
				const candidate = at(child);
				const current = at(least);

				if (
					candidate !== undefined &&
					current !== undefined &&
					before(candidate, current)
				) {
					least = child;
				}
			}

			if (least === i) {
				break;
			}

			swap(i, least);
			i = least;
		}

		return top;
	};

	return { push, pop };
};

interface Link {
	readonly index: number;
	readonly prev: number;
}

interface Explored {
	readonly cost: ReadonlyArray<number>;
	readonly end: ReadonlyArray<number>;
	readonly links: ReadonlyArray<Link>;
}

const squareOf = (index: number, width: number): Square => ({
	x: index % width,
	y: Math.floor(index / width),
});

const explore = <C>(
	terrain: ReadonlyArray<string>,
	from: Square,
	walk: Walk<C>,
	limit: number
): Explored => {
	const width = widthOf(terrain);
	const size = width * terrain.length;
	const key = walk.key ?? ((carry: C) => JSON.stringify(carry));
	const cost: Array<number> = Array.from({ length: size }, () => Infinity);
	const end: Array<number> = Array.from({ length: size }, () => -1);
	const links: Array<Link> = [];
	const carries: Array<C> = [];
	const spent: Array<number> = [];
	const ids = new Map<string, number>();
	const waiting = queue();
	let seq = 0;

	const reach = (square: Square, carry: C, total: number, prev: number) => {
		const index = square.y * width + square.x;
		const name = `${index}|${key(carry)}`;
		const known = ids.get(name);

		if (known !== undefined && (spent[known] ?? Infinity) <= total) {
			return;
		}

		const id = known ?? links.length;

		links[id] = { index, prev };
		carries[id] = carry;
		spent[id] = total;
		ids.set(name, id);

		if (total < (cost[index] ?? Infinity)) {
			cost[index] = total;
			end[index] = id;
		}

		waiting.push({ cost: total, seq, state: id });
		seq += 1;
	};

	reach(from, walk.carry, 0, -1);

	for (let item = waiting.pop(); item !== undefined; item = waiting.pop()) {
		const link = links[item.state];
		const carry = carries[item.state];

		if (link !== undefined && spent[item.state] === item.cost) {
			const here = squareOf(link.index, width);

			for (const step of STEPS) {
				const next = plus(here, step);

				const taken = inBounds(terrain, next)
					? walk.step(here, next, carry ?? walk.carry)
					: undefined;

				if (taken !== undefined && item.cost + taken.cost <= limit) {
					reach(next, taken.carry, item.cost + taken.cost, item.state);
				}
			}
		}
	}

	return { cost, end, links };
};

export interface Path {
	readonly path: ReadonlyArray<Square>;
	readonly cost: number;
}

export const cheapestPath = <C>(
	terrain: ReadonlyArray<string>,
	from: Square,
	to: Square,
	walk: Walk<C>
): Path | undefined => {
	if (!inBounds(terrain, to)) {
		return undefined;
	}

	const width = widthOf(terrain);
	const found = explore(terrain, from, walk, Infinity);
	const index = to.y * width + to.x;
	const total = found.cost[index] ?? Infinity;

	if (total === Infinity) {
		return undefined;
	}

	const path: Array<Square> = [];

	for (
		let link = found.links[found.end[index] ?? -1];
		link !== undefined && link.prev !== -1;
		link = found.links[link.prev]
	) {
		path.unshift(squareOf(link.index, width));
	}

	return { path, cost: total };
};

export const reachable = <C>(
	terrain: ReadonlyArray<string>,
	from: Square,
	speed: number,
	walk: Walk<C>,
	occupants: Occupants,
	mover?: Pick<Mover, "footprint" | "tiny">
): ReadonlyArray<Square> => {
	const found = explore(terrain, from, walk, speed);
	const width = widthOf(terrain);

	return found.cost.flatMap((c, i) => {
		const square = squareOf(i, width);

		return c > 0 &&
			c <= speed &&
			squaresOf(square, mover?.footprint).every(
				(s) => !blocks(occupants(s), mover)
			)
			? [square]
			: [];
	});
};

export interface Forced {
	readonly path: ReadonlyArray<Square>;
	readonly slam?: { readonly into: string; readonly remaining: number };
	readonly edge?: boolean;
}

export const sign = (n: number): number => {
	if (n > 0) {
		return 1;
	}

	return n < 0 ? -1 : 0;
};

export const toward = (from: Square, to: Square): Square => ({
	x: sign(to.x - from.x),
	y: sign(to.y - from.y),
});

const axisStep = (
	fromStart: number,
	fromSize: number,
	toStart: number,
	toSize: number
): number => {
	if (toStart >= fromStart + fromSize) {
		return 1;
	}

	return toStart + toSize <= fromStart ? -1 : 0;
};

export const towardFootprint = (
	from: Square,
	fromFootprint: Footprint,
	to: Square,
	toFootprint: Footprint
): Square => {
	const x = axisStep(from.x, fromFootprint, to.x, toFootprint);
	const y = axisStep(from.y, fromFootprint, to.y, toFootprint);

	return x === 0 && y === 0
		? toward(centreOf(from, fromFootprint), centreOf(to, toFootprint))
		: { x, y };
};

export interface ForceSource {
	readonly at: Square;
	readonly away: boolean;
	readonly intoSource?: boolean;
	readonly footprint?: Footprint;
}

const stopsShort = (
	here: Square,
	next: Square,
	source: ForceSource,
	footprint: Footprint
): boolean => {
	const theirs = source.footprint ?? 1;
	const was = apart(here, footprint, source.at, theirs);
	const now = apart(next, footprint, source.at, theirs);

	if (
		overlaps(next, footprint, source.at, theirs) &&
		source.intoSource !== true
	) {
		return true;
	}

	return source.away ? now <= was : now >= was;
};

export const forcedLine = (
	terrain: ReadonlyArray<string>,
	start: Square,
	step: Square,
	steps: number,
	occupants: Occupants,
	source: ForceSource,
	footprint: Footprint = 1
): Forced => {
	const path: Array<Square> = [];
	let here = start;

	for (let moved = 0; moved < steps; moved += 1) {
		const next = plus(here, step);

		if (stopsShort(here, next, source, footprint)) {
			break;
		}

		const remaining = steps - moved;
		const landing = squaresOf(next, footprint);

		if (
			landing.some((square) => terrainAt(terrain, square) === "wall") ||
			squaresOf(here, footprint).some((square) => corner(terrain, square, step))
		) {
			return { path, slam: { into: "wall", remaining } };
		}

		if (landing.some((square) => terrainAt(terrain, square) === "outside")) {
			return { path, edge: true };
		}

		const hit = landing
			.map((square) => occupants(square))
			.find((there) => there !== undefined);

		if (hit !== undefined) {
			return { path, slam: { into: hit.id, remaining } };
		}

		path.push(next);
		here = next;
	}

	return { path };
};

export const bestPull = (
	terrain: ReadonlyArray<string>,
	start: Square,
	steps: number,
	occupants: Occupants,
	from: Square,
	footprint: Footprint = 1,
	fromFootprint: Footprint = 1
): Forced => {
	const direct = towardFootprint(start, footprint, from, fromFootprint);
	const lines = [direct, ...STEPS.filter((s) => !sameSquare(s, direct))];
	let best: { readonly forced: Forced; readonly gap: number } | undefined;

	for (const step of lines) {
		const forced = forcedLine(
			terrain,
			start,
			step,
			steps,
			occupants,
			{ at: from, away: false, footprint: fromFootprint },
			footprint
		);

		const end = forced.path.at(-1) ?? start;
		const gap = apart(end, footprint, from, fromFootprint);

		if (
			best === undefined ||
			gap < best.gap ||
			(gap === best.gap && forced.path.length > best.forced.path.length)
		) {
			best = { forced, gap };
		}
	}

	return best?.forced ?? { path: [] };
};

export interface Slide {
	readonly path: ReadonlyArray<Square>;
	readonly into?: string;
}

const slideTarget = (
	terrain: ReadonlyArray<string>,
	to: Square,
	occupants: Occupants,
	footprint: Footprint
): string | undefined => {
	const landing = squaresOf(to, footprint);

	if (landing.some((square) => terrainAt(terrain, square) === "wall")) {
		return "wall";
	}

	return landing
		.map((square) => occupants(square))
		.find((there) => there !== undefined)?.id;
};

const cutsCorner = (
	terrain: ReadonlyArray<string>,
	here: Square,
	step: Square,
	footprint: Footprint
): boolean =>
	squaresOf(here, footprint).some((square) => corner(terrain, square, step));

export const slideRoute = (
	terrain: ReadonlyArray<string>,
	start: Square,
	to: Square,
	occupants: Occupants,
	footprint: Footprint = 1
): Slide | undefined => {
	if (
		squaresOf(to, footprint).some(
			(square) => terrainAt(terrain, square) === "outside"
		)
	) {
		return undefined;
	}

	const into = slideTarget(terrain, to, occupants, footprint);
	const width = widthOf(terrain);
	const index = (s: Square) => s.y * width + s.x;
	const prev = new Map<number, number>([[index(start), -1]]);
	const queued: Array<Square> = [start];
	let found: Square | undefined;

	for (const here of queued) {
		if (found !== undefined) {
			break;
		}

		for (const step of STEPS) {
			const next = plus(here, step);

			if (into !== undefined && sameSquare(next, to)) {
				if (!cutsCorner(terrain, here, step, footprint)) {
					found = here;
					break;
				}
			} else if (
				!prev.has(index(next)) &&
				fits(terrain, next, occupants, { footprint }) &&
				!cutsCorner(terrain, here, step, footprint)
			) {
				prev.set(index(next), index(here));

				if (sameSquare(next, to)) {
					found = next;
					break;
				}

				queued.push(next);
			}
		}
	}

	if (found === undefined) {
		return undefined;
	}

	const path: Array<Square> = [];

	for (
		let i = index(found);
		i !== index(start) && i !== -1;
		i = prev.get(i) ?? -1
	) {
		path.unshift(squareOf(i, width));
	}

	return into === undefined ? { path } : { path, into };
};
