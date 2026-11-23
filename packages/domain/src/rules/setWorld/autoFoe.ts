import { distance } from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import { moverWalk, reachable } from "../board/movement.ts";
import type { SetCommand } from "./commands.ts";
import {
	ATTACK_STAMINA,
	findFighter,
	isDown,
	living,
	mapSide,
	occupants,
	speedOf,
} from "./state.ts";
import type { Fighter, SetState, Turn } from "./state.ts";
import { reachOf } from "./weapons.ts";

const apartFrom = (foe: Fighter, other: Fighter): number =>
	foe.at === undefined || other.at === undefined
		? 0
		: distance(foe.at, other.at);

const nearestOf = (
	foe: Fighter,
	party: ReadonlyArray<Fighter>
): Fighter | undefined => {
	const placed =
		foe.at === undefined ? party : party.filter((p) => p.at !== undefined);

	const pool = placed.length > 0 ? placed : party;

	return pool.toSorted((a, b) => apartFrom(foe, a) - apartFrom(foe, b)).at(0);
};

const attackStep = (
	foe: Fighter,
	party: ReadonlyArray<Fighter>,
	turn: Turn
): SetCommand | undefined => {
	if (turn.attacked || foe.stamina < ATTACK_STAMINA) {
		return undefined;
	}

	const reach = reachOf(foe.character.mainhand).squares;
	const target = nearestOf(foe, party);

	return target !== undefined && apartFrom(foe, target) <= reach
		? { type: "set-attack", who: foe.id, target: target.id }
		: undefined;
};

const blocksAway = (a: Square, b: Square): number =>
	Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const closer = (
	squares: ReadonlyArray<Square>,
	goal: Square,
	from: Square
): Square | undefined =>
	squares
		.filter((square) => distance(square, goal) < distance(from, goal))
		.toSorted(
			(a, b) =>
				distance(a, goal) - distance(b, goal) ||
				blocksAway(a, goal) - blocksAway(b, goal) ||
				distance(a, from) - distance(b, from)
		)
		.at(0);

const moveStep = (
	slice: SetState,
	foe: Fighter,
	party: ReadonlyArray<Fighter>,
	turn: Turn
): SetCommand | undefined => {
	const { map } = slice;
	const target = nearestOf(foe, party);
	const goal = target?.at;

	if (map === undefined || foe.at === undefined || goal === undefined) {
		return undefined;
	}

	if (turn.moved > 0) {
		return undefined;
	}

	const blocked = occupants(slice, foe.id);

	const squares = reachable(
		map.terrain,
		foe.at,
		speedOf(foe.character),
		moverWalk(map.terrain, { side: mapSide(foe), prone: false }, blocked),
		blocked
	);

	const to = closer(squares, goal, foe.at);

	return to === undefined ? undefined : { type: "set-move", who: foe.id, to };
};

export const decideAutoFoeStep = (slice: SetState): SetCommand | undefined => {
	const turn = slice.fight?.turn;

	if (turn === undefined) {
		return undefined;
	}

	const foe = findFighter(slice, turn.id);
	const party = living(slice, "party");

	if (
		foe === undefined ||
		foe.side !== "foes" ||
		isDown(foe) ||
		party.length === 0
	) {
		return undefined;
	}

	return (
		attackStep(foe, party, turn) ??
		moveStep(slice, foe, party, turn) ?? { type: "set-done" }
	);
};
