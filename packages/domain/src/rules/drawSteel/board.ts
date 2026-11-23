import { ifDefined, listIfDefined, when } from "../../present.ts";
import { quote } from "../../text.ts";
import { apart, overlaps, squaresOf } from "../board/footprint.ts";
import type { Footprint } from "../board/footprint.ts";
import {
	checkGrid,
	formatSquare,
	inBounds,
	NOT_GENERATED,
	parseSquare,
	sameSquare,
	terrainAt,
} from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import {
	bestPull,
	cheapestPath,
	forcedLine,
	moverWalk,
	slideRoute,
	toward,
	towardFootprint,
} from "../board/movement.ts";
import type { Forced, Mover, Occupant, Occupants } from "../board/movement.ts";
import { GM } from "../core/module.ts";
import { isRefused } from "../engine.ts";
import type { Decision, NewEvent, Refused } from "../engine.ts";
import type { DsCommand, ForcedCommand } from "./commands.ts";
import { event } from "./events.ts";
import { modifiedDamage } from "./math.ts";
import { ID } from "./schema.ts";
import {
	budgetOf,
	byMark,
	capitalized,
	conditionsOf,
	controls,
	everyone,
	findWho,
	footprintOfWho,
	causedBy,
	heroOf,
	isDead,
	plural,
	resolve,
	sideOf,
	startedActions,
} from "./state.ts";
import type { Board, DrawSteelState, Who } from "./state.ts";

const refuse = (refusal: string): Refused => ({ refusal });

const decided = (...events: Array<NewEvent>): Decision => ({ events });

export const NO_MAP = "No map is loaded; the GM loads one with /map.";

export interface Speed {
	readonly speed: number;
	readonly why?: string;
}

export const speedOf = (slice: DrawSteelState, who: Who): Speed => {
	const base =
		who.kind === "hero"
			? who.hero.sheet.speed
			: (slice.blocks[who.creature.block]?.speed ?? 0);

	const has = new Set(conditionsOf(who).map((c) => c.name));

	for (const why of ["restrained", "grabbed"] as const) {
		if (has.has(why)) {
			return { speed: 0, why };
		}
	}

	if (has.has("slowed") && base > 2) {
		return { speed: 2, why: "slowed" };
	}

	return { speed: base };
};

const stabilityOf = (slice: DrawSteelState, who: Who): number =>
	Math.max(
		0,
		who.kind === "hero"
			? who.hero.sheet.stability
			: (slice.blocks[who.creature.block]?.stability ?? 0)
	);

const occupantOf = ({
	who,
	footprint,
}: {
	readonly who: Who;
	readonly footprint: Footprint;
}): Occupant =>
	footprint === 1
		? { id: who.id, side: sideOf(who) }
		: { id: who.id, side: sideOf(who), footprint };

export const occupants = (
	slice: DrawSteelState,
	board: Board,
	except?: string
): Occupants => {
	const at = new Map<
		string,
		{ readonly who: Who; readonly footprint: Footprint }
	>();

	for (const who of everyone(slice)) {
		const anchor = board.tokens[who.id];

		if (anchor !== undefined && who.id !== except && !isDead(who)) {
			const footprint = footprintOfWho(slice, who);

			for (const square of squaresOf(anchor, footprint)) {
				at.set(`${square.x},${square.y}`, { who, footprint });
			}
		}
	}

	return (square) => {
		const there = at.get(`${square.x},${square.y}`);

		return there === undefined ? undefined : occupantOf(there);
	};
};

export const moverOf = (slice: DrawSteelState, who: Who): Mover => {
	const mover = {
		side: sideOf(who),
		prone: conditionsOf(who).some((c) => c.name === "prone"),
	};

	const footprint = footprintOfWho(slice, who);

	return footprint === 1 ? mover : { ...mover, footprint };
};

const cantStand = (
	slice: DrawSteelState,
	board: Board,
	square: Square,
	who: Who
): string | undefined => {
	const taken = occupants(slice, board, who.id);

	for (const covered of squaresOf(square, footprintOfWho(slice, who))) {
		const named = formatSquare(covered);
		const terrain = terrainAt(board.terrain, covered);

		if (terrain === "wall") {
			return `${named} is a wall.`;
		}

		if (terrain === "outside") {
			return `${named} is outside the map.`;
		}

		const there = taken(covered);

		if (there !== undefined) {
			return `${named} is taken by ${everyone(slice).find((w) => w.id === there.id)?.name ?? there.id}.`;
		}
	}

	return undefined;
};

const notPlaced = (who: Who) =>
	`${who.name} isn't on the map; /place them first.`;

export const loadMap = (
	slice: DrawSteelState,
	command: Extract<DsCommand, { type: "map" }>
): Decision => {
	if (command.generate !== undefined) {
		return refuse(NOT_GENERATED);
	}

	if (command.id === undefined) {
		return slice.map === undefined
			? refuse("No map is loaded.")
			: decided(event("ds.map-cleared", {}));
	}

	if (!ID.test(command.id)) {
		return refuse(`'${quote(command.id)}' isn't a map id.`);
	}

	if (command.grid === undefined) {
		return refuse(`No map for '${quote(command.id)}' was loaded.`);
	}

	const grid = checkGrid(command.id, command.grid);

	if ("refusal" in grid) {
		return grid;
	}

	return decided(
		event("ds.map-loaded", {
			id: command.id,
			name: grid.name,
			terrain: [...grid.terrain],
			...ifDefined(grid.dressing, (value) => ({ dressing: [...value] })),
		})
	);
};

export const place = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "place" }>
): Decision => {
	const board = slice.map;

	if (board === undefined) {
		return refuse(NO_MAP);
	}

	const who = resolve(slice, command.who);

	if ("refusal" in who) {
		return who;
	}

	if (!controls(actor, who)) {
		return refuse("You can only place your own hero.");
	}

	if (
		actor !== GM &&
		slice.combat.active &&
		board.tokens[who.id] !== undefined
	) {
		return refuse(`${who.name} is on the map already; /move instead.`);
	}

	const why = cantStand(slice, board, command.at, who);

	if (why !== undefined) {
		return refuse(why);
	}

	return decided(event("ds.placed", { id: who.id, at: command.at }));
};

interface MoveStart {
	readonly board: Board;
	readonly who: Who;
	readonly from: Square;
	readonly limited: boolean;
}

const moveStart = (
	slice: DrawSteelState,
	actor: string,
	typed: string
): MoveStart | Refused => {
	const board = slice.map;

	if (board === undefined) {
		return refuse(NO_MAP);
	}

	const who = resolve(slice, typed);

	if (isRefused(who)) {
		return who;
	}

	if (!controls(actor, who)) {
		return refuse("You can only move your own hero.");
	}

	const from = board.tokens[who.id];

	if (from === undefined) {
		return refuse(notPlaced(who));
	}

	if (isDead(who)) {
		return refuse(`${who.name} is dead.`);
	}

	const { combat } = slice;
	const limited = actor !== GM && combat.active;

	if (limited && combat.acting !== who.id) {
		return refuse(
			`It isn't ${who.name}'s turn; the GM moves heroes between turns.`
		);
	}

	return { board, who, from, limited };
};

const tooFar = (
	who: Who,
	to: Square,
	cost: number,
	speed: number,
	before: { readonly spent: number; readonly main: boolean },
	main: boolean
): Refused => {
	const takes = `${formatSquare(to)} takes ${plural(cost, "square")} of movement`;

	if (before.spent === 0 && !main) {
		return refuse(
			`${who.name} can't move that far: ${takes}, and ${who.name}'s speed is ${speed}.`
		);
	}

	const allowance = main ? 2 * speed : speed;
	const left = Math.max(0, allowance - before.spent);
	const again = main ? "" : "; add main to move again with the main action";

	return refuse(
		`${who.name} can't move that far: ${takes}, and ${who.name} has ${left} of speed ${speed} left this turn${again}.`
	);
};

const moveBudget = (
	slice: DrawSteelState,
	who: Who,
	before: { readonly spent: number; readonly main: boolean },
	main: boolean
): string | undefined => {
	const { actions } = slice.combat;
	const spent = actions?.id === who.id ? actions : startedActions(who.id);
	const budget = budgetOf(slice, who);
	const needsMove = spent.move === 0;
	const needsMain = main && !before.main;

	if (!needsMove && !main && before.spent === 0) {
		return `${who.name} has no move action left this turn; add main to move with the main action.`;
	}

	if (budget.dazed) {
		return (needsMove ? 1 : 0) + (needsMain ? 1 : 0) > budget.move
			? `${who.name} is dazed and has taken their one action this turn.`
			: undefined;
	}

	return needsMain && budget.main === 0
		? `${who.name} has no main action left this turn.`
		: undefined;
};

export const move = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "move" }>
): Decision => {
	const start = moveStart(slice, actor, command.who);

	if (isRefused(start)) {
		return start;
	}

	const { board, who, from, limited } = start;
	const { combat } = slice;
	const { to } = command;

	if (sameSquare(from, to)) {
		return refuse(`${who.name} is at ${formatSquare(to)} already.`);
	}

	const why = cantStand(slice, board, to, who);

	if (why !== undefined) {
		return refuse(why);
	}

	const { speed, why: slowed } = speedOf(slice, who);

	if (limited && speed === 0) {
		return refuse(
			`${who.name} can't move: speed 0${slowed === undefined ? "" : ` (${slowed})`}.`
		);
	}

	const route = cheapestPath(
		board.terrain,
		from,
		to,
		moverWalk(
			board.terrain,
			moverOf(slice, who),
			occupants(slice, board, who.id)
		)
	);

	if (route === undefined) {
		return refuse(`${who.name} can't reach ${formatSquare(to)}.`);
	}

	const turn = combat.active && combat.acting === who.id;

	const before =
		combat.moved?.id === who.id ? combat.moved : { spent: 0, main: false };

	const main = before.main || command.main === true;
	const allowance = main ? 2 * speed : speed;
	const spent = before.spent + route.cost;

	const short = limited ? moveBudget(slice, who, before, main) : undefined;

	if (short !== undefined) {
		return refuse(short);
	}

	if (limited && spent > allowance) {
		return tooFar(who, to, route.cost, speed, before, main);
	}

	return decided(
		event("ds.moved", {
			id: who.id,
			path: [...route.path],
			cost: route.cost,
			speed,
			...when(turn, () => ({ spent, allowance })),
			...when(turn && main, () => ({ main: true })),
		})
	);
};

interface Point {
	readonly id?: string;
	readonly at: Square;
	readonly footprint: Footprint;
}

const point = (
	slice: DrawSteelState,
	board: Board,
	typed: string
): Point | Refused => {
	const marked = byMark(slice, typed);
	const placed = marked === undefined ? undefined : board.tokens[marked.id];

	if (marked !== undefined && placed !== undefined) {
		return {
			id: marked.id,
			at: placed,
			footprint: footprintOfWho(slice, marked),
		};
	}

	const square = parseSquare(typed);

	if (square !== undefined) {
		return inBounds(board.terrain, square)
			? { at: square, footprint: 1 }
			: refuse(`${formatSquare(square)} is outside the map.`);
	}

	const who = resolve(slice, typed);

	if ("refusal" in who) {
		return who;
	}

	const at = board.tokens[who.id];

	return at === undefined
		? refuse(notPlaced(who))
		: { id: who.id, at, footprint: footprintOfWho(slice, who) };
};

const pointOf = ({ id, at }: Point) => (id === undefined ? { at } : { id, at });

export const measure = (
	slice: DrawSteelState,
	command: Extract<DsCommand, { type: "dist" }>
): Decision => {
	const board = slice.map;

	if (board === undefined) {
		return refuse(NO_MAP);
	}

	const from = point(slice, board, command.from);

	if ("refusal" in from) {
		return from;
	}

	const to = point(slice, board, command.to);

	if ("refusal" in to) {
		return to;
	}

	return decided(
		event("ds.measured", {
			from: pointOf(from),
			to: pointOf(to),
			distance: apart(from.at, from.footprint, to.at, to.footprint),
		})
	);
};

const sourceNamed = (
	slice: DrawSteelState,
	from: string | undefined,
	own: string | undefined
): Who | Refused | undefined => {
	if (from !== undefined) {
		return resolve(slice, from);
	}

	return own === undefined ? undefined : findWho(slice, own);
};

const sourceOf = (
	slice: DrawSteelState,
	actor: string,
	command: ForcedCommand<"push" | "pull" | "slide">,
	target: Who
): Who | Refused | undefined => {
	const { acting } = slice.combat;
	const actingWho = acting === undefined ? undefined : findWho(slice, acting);

	if (
		actor === GM &&
		command.from === undefined &&
		(actingWho === undefined || actingWho.id === target.id || isDead(actingWho))
	) {
		return undefined;
	}

	const own = actor === GM ? acting : heroOf(slice, actor)?.id;

	const source = sourceNamed(slice, command.from, own);

	if (source !== undefined && "refusal" in source) {
		return source;
	}

	if (source === undefined || !controls(actor, source)) {
		return refuse("You can only force move with your own hero.");
	}

	if (isDead(source)) {
		return refuse(`${source.name} is dead.`);
	}

	if (actor !== GM && acting !== source.id) {
		return refuse(
			`It isn't ${source.name}'s turn; the GM force moves between turns.`
		);
	}

	return source;
};

const slamDamage = (
	slice: DrawSteelState,
	target: Who,
	slam: Forced["slam"]
): Array<NewEvent> => {
	if (slam === undefined) {
		return [];
	}

	const hurt = (who: Who, amount: number): Array<NewEvent> => {
		if (isDead(who)) {
			return [];
		}

		const sheet =
			who.kind === "hero"
				? who.hero.sheet
				: (slice.blocks[who.creature.block] ?? {});

		const { dealt, weakness, immunity } = modifiedDamage(
			amount,
			undefined,
			sheet
		);

		return [
			event("ds.damaged", {
				id: who.id,
				amount,
				...when(weakness > 0, () => ({ weakness })),
				...when(immunity > 0, () => ({ immunity })),
				dealt,
			}),
		];
	};

	if (slam.into === "wall") {
		return hurt(target, 2 + slam.remaining);
	}

	const other = everyone(slice).find((w) => w.id === slam.into);

	return [
		...hurt(target, slam.remaining),
		...listIfDefined(other, (value) => hurt(value, slam.remaining)),
	];
};

interface ForceContext {
	readonly board: Board;
	readonly target: Who;
	readonly start: Square;
	readonly steps: number;
	readonly after: string;
	readonly blocked: Occupants;
	readonly footprint: Footprint;
	readonly sourceFootprint: Footprint;
}

const slideForced = (
	context: ForceContext,
	command: ForcedCommand<"push" | "pull" | "slide">
): Forced | Refused => {
	const { board, target, start, steps, after, blocked, footprint } = context;
	const { to } = command;

	if (to === undefined) {
		return refuse(
			`Say where: /slide ${command.who} ${command.distance} to <square>.`
		);
	}

	if (sameSquare(start, to)) {
		return refuse(`${target.name} is at ${formatSquare(to)} already.`);
	}

	const route = slideRoute(board.terrain, start, to, blocked, footprint);

	if (route === undefined) {
		return refuse(`${target.name} can't be slid to ${formatSquare(to)}.`);
	}

	const needed = route.path.length + (route.into === undefined ? 0 : 1);

	if (needed > steps) {
		return refuse(
			`${formatSquare(to)} is ${plural(needed, "square")} away, and the slide is ${steps}${after}.`
		);
	}

	return route.into === undefined
		? { path: route.path }
		: {
				path: route.path,
				slam: { into: route.into, remaining: steps - route.path.length },
			};
};

const wrongWay = (
	context: ForceContext,
	to: Square,
	from: Square,
	away: boolean,
	intoSource: boolean
): boolean => {
	const { start, footprint, sourceFootprint } = context;
	const line = toward(start, to);
	let here = start;

	for (const _step of Array.from({ length: apart(start, 1, to, 1) })) {
		const next = { x: here.x + line.x, y: here.y + line.y };
		const was = apart(here, footprint, from, sourceFootprint);
		const now = apart(next, footprint, from, sourceFootprint);

		const wrong = away
			? now <= was
			: now >= was ||
				(overlaps(next, footprint, from, sourceFootprint) && !intoSource);

		if (wrong) {
			return true;
		}

		here = next;
	}

	return false;
};

const lineForced = (
	context: ForceContext,
	kind: "push" | "pull",
	source: Who,
	from: Square,
	to: Square
): Forced | Refused => {
	const { board, target, start, steps, after, blocked } = context;
	const { footprint, sourceFootprint } = context;
	const away = kind === "push";
	const dx = to.x - start.x;
	const dy = to.y - start.y;

	if (dx === 0 && dy === 0) {
		return refuse(`${target.name} is at ${formatSquare(to)} already.`);
	}

	if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) {
		return refuse(
			`${formatSquare(to)} isn't in a straight line from ${formatSquare(start)}.`
		);
	}

	const length = apart(start, 1, to, 1);
	const intoSource = !away && overlaps(to, footprint, from, sourceFootprint);

	if (wrongWay(context, to, from, away, intoSource)) {
		return refuse(
			`A ${kind} moves ${target.name} ${away ? "away from" : "toward"} ${source.name}, and ${formatSquare(to)} isn't.`
		);
	}

	if (length > steps) {
		return refuse(
			`${formatSquare(to)} is ${plural(length, "square")} away, and the ${kind} is ${steps}${after}.`
		);
	}

	const slams =
		squaresOf(to, footprint).some(
			(square) =>
				terrainAt(board.terrain, square) === "wall" ||
				blocked(square) !== undefined
		) || intoSource;

	return forcedLine(
		board.terrain,
		start,
		toward(start, to),
		slams ? steps : length,
		blocked,
		{ at: from, away, intoSource, footprint: sourceFootprint },
		footprint
	);
};

const straightForced = (
	context: ForceContext,
	command: ForcedCommand<"push" | "pull" | "slide">,
	kind: "push" | "pull",
	source: Who | undefined,
	from: Square | undefined
): Forced | Refused => {
	if (source === undefined) {
		return refuse(
			`${capitalized(kind)} from where? /${kind} ${command.who} ${command.distance} from <who>.`
		);
	}

	if (from === undefined) {
		return refuse(notPlaced(source));
	}

	const { board, start, steps, blocked, footprint, sourceFootprint } = context;

	if (command.to !== undefined) {
		return lineForced(context, kind, source, from, command.to);
	}

	return kind === "push"
		? forcedLine(
				board.terrain,
				start,
				towardFootprint(from, sourceFootprint, start, footprint),
				steps,
				blocked,
				{ at: from, away: true, footprint: sourceFootprint },
				footprint
			)
		: bestPull(
				board.terrain,
				start,
				steps,
				blocked,
				from,
				footprint,
				sourceFootprint
			);
};

const forceTarget = (
	slice: DrawSteelState,
	board: Board,
	typed: string
): { readonly target: Who; readonly start: Square } | Refused => {
	const target = resolve(slice, typed);

	if (isRefused(target)) {
		return target;
	}

	const start = board.tokens[target.id];

	if (start === undefined) {
		return refuse(notPlaced(target));
	}

	if (conditionsOf(target).some((c) => c.name === "restrained")) {
		return refuse(`${target.name} is restrained and can't be force moved.`);
	}

	return { target, start };
};

export const forceMove = (
	slice: DrawSteelState,
	actor: string,
	command: ForcedCommand<"push" | "pull" | "slide">
): Decision => {
	const board = slice.map;

	if (board === undefined) {
		return refuse(NO_MAP);
	}

	const kind = command.type;
	const found = forceTarget(slice, board, command.who);

	if (isRefused(found)) {
		return found;
	}

	const { target, start } = found;
	const source = sourceOf(slice, actor, command, target);

	if (source !== undefined && isRefused(source)) {
		return source;
	}

	if (source?.id === target.id) {
		return refuse(
			kind === "slide"
				? `${target.name} can't slide themselves; /move instead.`
				: `${target.name} can't ${kind} themselves.`
		);
	}

	const holder = causedBy(target, "grabbed");

	if (actor !== GM && holder !== undefined && source?.id !== holder) {
		const name = findWho(slice, holder)?.name ?? holder;

		return refuse(
			`${target.name} is grabbed by ${name}; only ${name} or the GM can force move them.`
		);
	}

	const stability = stabilityOf(slice, target);

	const context: ForceContext = {
		board,
		target,
		start,
		steps: Math.max(0, command.distance - stability),
		after: stability > 0 ? ` after stability ${stability}` : "",
		blocked: occupants(slice, board, target.id),
		footprint: footprintOfWho(slice, target),
		sourceFootprint: source === undefined ? 1 : footprintOfWho(slice, source),
	};

	const sourceAt = source === undefined ? undefined : board.tokens[source.id];

	const forced =
		kind === "slide"
			? slideForced(context, command)
			: straightForced(context, command, kind, source, sourceAt);

	if (isRefused(forced)) {
		return forced;
	}

	return decided(
		event("ds.force-moved", {
			id: target.id,
			kind,
			...ifDefined(source, (value) => ({ source: value.id })),
			from: start,
			distance: command.distance,
			stability,
			path: [...forced.path],
			...ifDefined(forced.slam, (value) => ({ slam: value })),
			...when(forced.edge === true, () => ({ edge: true })),
			...ifDefined(sourceAt, (value) => ({
				apart: apart(value, context.sourceFootprint, start, context.footprint),
			})),
		}),
		...slamDamage(slice, target, forced.slam)
	);
};

export const clearedAtEnd = (slice: DrawSteelState): ReadonlyArray<string> => {
	const board = slice.map;

	if (board === undefined) {
		return [];
	}

	return everyone(slice)
		.filter(
			(w) =>
				board.tokens[w.id] !== undefined && (w.kind === "creature" || isDead(w))
		)
		.map((w) => w.id);
};
