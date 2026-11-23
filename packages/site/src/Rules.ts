import { Result, Schema, Struct } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import {
	apart,
	BRANN,
	COLUMNS,
	damageOf,
	FIGHTERS,
	fighterOf,
	HERO,
	isSame,
	MAP_ID,
	MAP_NAME,
	nameOfSquare,
	pushOf,
	RECOVERIES,
	RECOVERY_VALUE,
	ROWS,
	squareOfName,
	TERRAIN,
	terrainAt,
	tierOf,
	windedAt,
	WRATH_PER_TURN,
} from "./Encounter.ts";
import type { Ability, Fighter, Square } from "./Encounter.ts";

const Spot = Schema.Struct({ x: Schema.Int, y: Schema.Int });

const Id = Schema.String;

export const Happened = defineTaggedUnion({
	MapLoaded: {
		id: Id,
		name: Schema.String,
		terrain: Schema.Array(Schema.String),
	},
	Placed: { id: Id, at: Spot },
	RoundStarted: { round: Schema.Int },
	TurnStarted: { id: Id, gain: Schema.Int },
	Moved: {
		id: Id,
		path: Schema.Array(Spot),
		cost: Schema.Int,
		speed: Schema.Int,
		main: Schema.Boolean,
	},
	PowerRolled: {
		id: Id,
		ability: Schema.String,
		dice: Schema.Array(Schema.Int),
		bonus: Schema.Int,
		total: Schema.Int,
		tier: Schema.Int,
		cost: Schema.Int,
		targets: Schema.Array(Schema.Struct({ id: Id, apart: Schema.Int })),
	},
	Damaged: { id: Id, amount: Schema.Int, source: Schema.String },
	ForceMoved: {
		id: Id,
		kind: Schema.Literal("push"),
		source: Id,
		path: Schema.Array(Spot),
		distance: Schema.Int,
		stability: Schema.Int,
		stopped: Schema.String,
	},
	Recovered: { id: Id, amount: Schema.Int },
	TurnEnded: { id: Id },
	CombatEnded: { winner: Schema.Literals(["heroes", "director"]) },
	ChatPosted: { text: Schema.String },
	DiceRolled: {
		notation: Schema.String,
		rolls: Schema.Array(Schema.Int),
		modifier: Schema.Int,
		total: Schema.Int,
	},
	Measured: {
		from: Spot,
		to: Spot,
		squares: Schema.Int,
		between: Schema.Array(Schema.String),
	},
	Retracted: {
		seqs: Schema.Array(Schema.Int),
		undone: Schema.Array(Schema.String),
	},
});

export type Happened = typeof Happened.Type;

export const Entry = Schema.Struct({
	seq: Schema.Int,
	at: Schema.Int,
	actor: Schema.String,
	event: Happened,
});

export type Entry = typeof Entry.Type;

export const YOU = "you";

export const GM = "gm";

export interface Authored {
	readonly actor: string;
	readonly event: Happened;
}

export interface Body {
	readonly id: string;
	readonly stamina: number;
	readonly at: Square;
}

export interface TableState {
	readonly terrain: ReadonlyArray<string>;
	readonly bodies: ReadonlyArray<Body>;
	readonly round: number;
	readonly turn: string;
	readonly winner: string;
	readonly wrath: number;
	readonly recoveries: number;
	readonly spent: number;
	readonly allowance: number;
	readonly acted: boolean;
	readonly breathed: boolean;
}

export interface FeedLine {
	readonly seq: number;
	readonly kind: string;
	readonly who: string;
	readonly text: string;
	readonly taken: boolean;
}

export interface Folded {
	readonly state: TableState;
	readonly feed: ReadonlyArray<FeedLine>;
}

export interface Struck {
	readonly events: ReadonlyArray<Happened>;
	readonly seed: number;
}

export interface Decision {
	readonly events: ReadonlyArray<Authored>;
	readonly seed: number;
}

export const EMPTY: TableState = {
	terrain: [],
	bodies: [],
	round: 0,
	turn: "",
	winner: "",
	wrath: 0,
	recoveries: RECOVERIES,
	spent: 0,
	allowance: 0,
	acted: false,
	breathed: false,
};

export const OPENING: ReadonlyArray<Authored> = [
	{
		actor: GM,
		event: Happened.MapLoaded({ id: MAP_ID, name: MAP_NAME, terrain: TERRAIN }),
	},
	...FIGHTERS.map((fighter) => ({
		actor: GM,
		event: Happened.Placed({ id: fighter.id, at: fighter.start }),
	})),
	{ actor: GM, event: Happened.RoundStarted({ round: 1 }) },
	{
		actor: GM,
		event: Happened.TurnStarted({ id: HERO, gain: WRATH_PER_TURN }),
	},
];

export const TYPES = {
	MapLoaded: "ds.map-loaded",
	Placed: "ds.placed",
	RoundStarted: "ds.round-started",
	TurnStarted: "ds.turn-started",
	Moved: "ds.moved",
	PowerRolled: "ds.power-rolled",
	Damaged: "ds.damaged",
	ForceMoved: "ds.force-moved",
	Recovered: "ds.recovered",
	TurnEnded: "ds.turn-ended",
	CombatEnded: "ds.combat-ended",
	ChatPosted: "core.chat-posted",
	DiceRolled: "core.dice-rolled",
	Measured: "ds.measured",
	Retracted: "core.retracted",
} as const satisfies Record<Happened["_tag"], string>;

const START = Date.UTC(2026, 10, 22, 19, 30, 0);

export const timestampOf = (at: number): string =>
	new Date(START + at * 4000).toISOString();

export const lineOf = (entry: Entry): string =>
	JSON.stringify({
		actor: entry.actor,
		seq: entry.seq,
		timestamp: timestampOf(entry.at),
		type: TYPES[entry.event._tag],
		payload: Struct.omit(entry.event, ["_tag"]),
	});

export const bodyOf = (state: TableState, id: string): Body | undefined =>
	state.bodies.find((body) => body.id === id);

const deathAt = (fighter: Fighter): number =>
	fighter.side === "heroes" ? -windedAt(fighter) : 0;

export const isDead = (state: TableState, id: string): boolean => {
	const body = bodyOf(state, id);

	return body === undefined || body.stamina <= deathAt(fighterOf(id));
};

export const statusOf = (state: TableState, id: string): string => {
	const fighter = fighterOf(id);
	const stamina = bodyOf(state, id)?.stamina ?? 0;

	if (isDead(state, id)) {
		return "dead";
	}

	if (stamina <= 0) {
		return "dying";
	}

	return stamina <= windedAt(fighter) ? "winded" : "";
};

const whoAt = (state: TableState, square: Square): Body | undefined =>
	state.bodies.find(
		(body) => isSame(body.at, square) && !isDead(state, body.id)
	);

const changeBody = (
	state: TableState,
	id: string,
	change: (body: Body) => Body
): TableState => ({
	...state,
	bodies: state.bodies.map((body) => (body.id === id ? change(body) : body)),
});

const lastOf = (path: ReadonlyArray<Square>, at: Square): Square =>
	path.at(-1) ?? at;

export const apply = (state: TableState, event: Happened): TableState =>
	Happened.match(event, {
		MapLoaded: ({ terrain }) => ({ ...state, terrain }),
		Placed: ({ id, at }) => ({
			...state,
			bodies: [
				...state.bodies.filter((body) => body.id !== id),
				{ id, at, stamina: fighterOf(id).stamina },
			],
		}),
		RoundStarted: ({ round }) => ({ ...state, round }),
		TurnStarted: ({ id, gain }) => ({
			...state,
			turn: id,
			wrath: state.wrath + gain,
			spent: 0,
			allowance: fighterOf(id).speed,
			acted: false,
			breathed: false,
		}),
		Moved: ({ id, path, cost, main }) => ({
			...changeBody(state, id, (body) => ({
				...body,
				at: lastOf(path, body.at),
			})),
			spent: state.turn === id ? state.spent + cost : state.spent,
			allowance:
				main && state.turn === id
					? state.allowance + fighterOf(id).speed
					: state.allowance,
			acted: state.acted || (main && state.turn === id),
		}),
		PowerRolled: ({ id, cost }) => ({
			...state,
			acted: state.acted || state.turn === id,
			wrath: id === HERO ? state.wrath - cost : state.wrath,
		}),
		Damaged: ({ id, amount }) =>
			changeBody(state, id, (body) => ({
				...body,
				stamina: body.stamina - amount,
			})),
		ForceMoved: ({ id, path }) =>
			changeBody(state, id, (body) => ({ ...body, at: lastOf(path, body.at) })),
		Recovered: ({ id, amount }) => ({
			...changeBody(state, id, (body) => ({
				...body,
				stamina: Math.min(fighterOf(id).stamina, body.stamina + amount),
			})),
			recoveries: state.recoveries - 1,
			breathed: true,
		}),
		TurnEnded: () => ({ ...state, turn: "" }),
		CombatEnded: ({ winner }) => ({ ...state, turn: "", winner }),
		ChatPosted: () => state,
		DiceRolled: () => state,
		Measured: () => state,
		Retracted: () => state,
	});

const plural = (count: number, word: string): string =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

export const labelOf = (actor: string): string =>
	actor === YOU ? "You (Brann)" : "GM";

const nameOf = (id: string): string =>
	FIGHTERS.find((fighter) => fighter.id === id)?.name ?? id;

const movedText = (id: string, path: ReadonlyArray<Square>, cost: number) => {
	const to = path.at(-1);

	return `${nameOf(id)} moves to ${to === undefined ? "where it stood" : nameOfSquare(to)} (${plural(cost, "square")} of movement).`;
};

const abilityOf = (fighter: Fighter, name: string): Ability | undefined =>
	fighter.abilities.find((ability) => ability.name === name);

const effectText = (ability: Ability, tier: number): string => {
	const damage = damageOf(ability, tier);
	const push = pushOf(ability, tier);
	const typed = ability.type === "" ? "" : ` ${ability.type}`;

	const sum =
		ability.letter === ""
			? `${damage}${typed} damage`
			: `${ability.base[tier - 1] ?? 0} + ${ability.letter} (${ability.characteristic}) = ${damage}${typed} damage`;

	const pushed = push > 0 ? `; push ${push}` : "";
	const rider = ability.rider === "" ? "" : `; ${ability.rider}`;

	return `${sum}${pushed}${rider}`;
};

const staminaText = (state: TableState, id: string, amount: number): string => {
	const before = bodyOf(state, id)?.stamina ?? 0;
	const after = apply(state, Happened.Damaged({ id, amount, source: "" }));
	const status = statusOf(after, id);

	return `${nameOf(id)} takes ${amount} damage → ${before - amount}/${fighterOf(id).stamina}${status === "" ? "" : ` · ${status}`}`;
};

const pushText = (event: typeof Happened.ForceMoved.Type): string => {
	const to = event.path.at(-1);

	const into =
		event.stopped === "" || event.stopped === "edge"
			? ""
			: `, into ${event.stopped === "wall" ? "a wall" : nameOf(event.stopped)}`;

	if (to === undefined) {
		return event.stopped === ""
			? `${nameOf(event.id)} is pushed by ${nameOf(event.source)} but doesn't move (push ${event.distance}, stability ${event.stability}).`
			: `${nameOf(event.id)} is pushed by ${nameOf(event.source)} and doesn't move${into}.`;
	}

	return `${nameOf(event.id)} is pushed ${plural(event.path.length, "square")} by ${nameOf(event.source)} to ${nameOfSquare(to)}${into}.`;
};

const describe = (state: TableState, entry: Entry): Array<string> =>
	Happened.match(entry.event, {
		MapLoaded: ({ name, terrain }) => [
			`The map is ${name}, ${terrain[0]?.length ?? 0} by ${terrain.length}.`,
		],
		Placed: ({ id, at }) => [`${nameOf(id)} is placed at ${nameOfSquare(at)}.`],
		RoundStarted: ({ round }) => [
			round === 1 ? "Combat begins, round 1." : `Round ${round}.`,
		],
		TurnStarted: ({ id, gain }) => [
			gain > 0
				? `${nameOf(id)}'s turn. wrath +${gain} → ${state.wrath + gain}.`
				: `${nameOf(id)}'s turn.`,
		],
		Moved: ({ id, path, cost, main }) => [
			main
				? movedText(id, path, cost).replace(
						/\)\.$/u,
						", with the main action)."
					)
				: movedText(id, path, cost),
		],
		PowerRolled: ({ id, ability, dice, bonus, total, tier, cost, targets }) => {
			const fighter = fighterOf(id);
			const used = abilityOf(fighter, ability);

			const on =
				targets.length === 0
					? ""
					: ` on ${targets.map((target) => nameOf(target.id)).join(" and ")}`;

			const spent = cost > 0 ? ` (${cost} wrath)` : "";
			const effect = used === undefined ? "" : ` — ${effectText(used, tier)}`;

			const far = targets.flatMap((target) =>
				used !== undefined && target.apart > used.reach
					? [
							`${nameOf(target.id)} is ${plural(target.apart, "square")} away, past ${used.distance}.`,
						]
					: []
			);

			return [
				`${fighter.name} uses ${ability}${spent}${on}: [${dice.join(", ")}] +${bonus} = ${total} · tier ${tier}${effect}`,
				...far,
			];
		},
		Damaged: ({ id, amount, source }) => [
			source === "wall"
				? `${staminaText(state, id, amount)} from the wall`
				: staminaText(state, id, amount),
		],
		ForceMoved: (event) => [pushText(event)],
		Recovered: ({ id, amount }) => {
			const before = bodyOf(state, id)?.stamina ?? 0;
			const max = fighterOf(id).stamina;

			return [
				`${nameOf(id)} spends a Recovery and regains ${amount} Stamina → ${Math.min(max, before + amount)}/${max}.`,
			];
		},
		TurnEnded: ({ id }) => [`${nameOf(id)}'s turn ends.`],
		CombatEnded: ({ winner }) => [
			winner === "heroes"
				? "Combat ends. The bandits are beaten, and the ford is clear."
				: "Combat ends. Brann has fallen, and the bandits hold the ford.",
		],
		ChatPosted: ({ text }) => [text],
		DiceRolled: ({ notation, rolls, modifier, total }) => [
			`rolls ${notation}: [${rolls.join(", ")}]${modifier === 0 ? "" : ` ${modifier > 0 ? "+" : "−"}${Math.abs(modifier)}`} = ${total}`,
		],
		Measured: ({ between, squares }) => [
			`measures ${between.join(" to ")}: ${plural(squares, "square")}.`,
		],
		Retracted: ({ undone }) => [
			`↶ ${labelOf(entry.actor)} undid: ${undone.join(" ")}`,
		],
	});

const KINDS = {
	MapLoaded: "plain",
	Placed: "plain",
	RoundStarted: "turn",
	TurnStarted: "turn",
	Moved: "move",
	PowerRolled: "roll",
	Damaged: "hit",
	ForceMoved: "move",
	Recovered: "heal",
	TurnEnded: "turn",
	CombatEnded: "end",
	ChatPosted: "chat",
	DiceRolled: "dice",
	Measured: "dice",
	Retracted: "undo",
} as const satisfies Record<Happened["_tag"], string>;

const SPOKEN = new Set(["ChatPosted", "DiceRolled", "Measured"]);

export const retractedIn = (log: ReadonlyArray<Entry>): ReadonlySet<number> =>
	new Set(
		log.flatMap((entry) =>
			Happened.guards.Retracted(entry.event) ? entry.event.seqs : []
		)
	);

export const fold = (log: ReadonlyArray<Entry>): Folded => {
	const retracted = retractedIn(log);
	let state = EMPTY;
	const feed: Array<FeedLine> = [];

	for (const entry of log) {
		const taken = retracted.has(entry.seq);

		for (const text of describe(state, entry)) {
			feed.push({
				seq: entry.seq,
				kind: KINDS[entry.event._tag],
				who: SPOKEN.has(entry.event._tag) ? labelOf(entry.actor) : "",
				text,
				taken,
			});
		}

		if (!taken) {
			state = apply(state, entry.event);
		}
	}

	return { state, feed };
};

const STEPS: ReadonlyArray<Square> = [
	{ x: -1, y: -1 },
	{ x: 0, y: -1 },
	{ x: 1, y: -1 },
	{ x: -1, y: 0 },
	{ x: 1, y: 0 },
	{ x: -1, y: 1 },
	{ x: 0, y: 1 },
	{ x: 1, y: 1 },
];

const isInside = (square: Square): boolean =>
	square.x >= 0 && square.y >= 0 && square.x < COLUMNS && square.y < ROWS;

const isWall = (state: TableState, square: Square): boolean =>
	!isInside(square) || terrainAt(state.terrain, square) === "#";

const cutsCorner = (state: TableState, from: Square, step: Square): boolean =>
	step.x !== 0 &&
	step.y !== 0 &&
	(isWall(state, { x: from.x + step.x, y: from.y }) ||
		isWall(state, { x: from.x, y: from.y + step.y }));

const indexOf = (square: Square): number => square.y * COLUMNS + square.x;

const squareAt = (index: number): Square => ({
	x: index % COLUMNS,
	y: Math.floor(index / COLUMNS),
});

export interface Reach {
	readonly cost: ReadonlyArray<number>;
	readonly back: ReadonlyArray<number>;
}

const cheapestOpen = (
	cost: ReadonlyArray<number>,
	done: ReadonlyArray<boolean>
): number => {
	let best = -1;
	let lowest = Infinity;

	for (const [index, price] of cost.entries()) {
		if (!(done[index] ?? true) && price < lowest) {
			best = index;
			lowest = price;
		}
	}

	return best;
};

const priceOf = (
	state: TableState,
	mover: Fighter,
	from: Square,
	step: Square
): number => {
	const to = { x: from.x + step.x, y: from.y + step.y };

	if (isWall(state, to) || cutsCorner(state, from, step)) {
		return Infinity;
	}

	const there = whoAt(state, to);

	const hostile =
		there !== undefined && fighterOf(there.id).side !== mover.side;

	const rough = terrainAt(state.terrain, to) === "~";

	return 1 + (rough ? 1 : 0) + (hostile ? 1 : 0);
};

export const reachFrom = (state: TableState, id: string): Reach => {
	const mover = fighterOf(id);
	const start = bodyOf(state, id)?.at ?? mover.start;
	const size = COLUMNS * ROWS;
	const cost = Array.from({ length: size }, () => Infinity);
	const back = Array.from({ length: size }, () => -1);
	const done = Array.from({ length: size }, () => false);

	cost[indexOf(start)] = 0;

	let best = cheapestOpen(cost, done);

	while (best !== -1) {
		done[best] = true;

		const from = squareAt(best);
		const here = cost[best] ?? Infinity;

		for (const step of STEPS) {
			const to = indexOf({ x: from.x + step.x, y: from.y + step.y });
			const through = here + priceOf(state, mover, from, step);

			if (through < (cost[to] ?? Infinity)) {
				cost[to] = through;
				back[to] = best;
			}
		}

		best = cheapestOpen(cost, done);
	}

	return { cost, back };
};

export const pathTo = (reach: Reach, to: Square): Array<Square> => {
	const path: Array<Square> = [];
	let at = indexOf(to);

	while ((reach.back[at] ?? -1) !== -1) {
		path.unshift(squareAt(at));
		at = reach.back[at] ?? -1;
	}

	return path;
};

export const canEnd = (
	state: TableState,
	id: string,
	square: Square
): boolean => {
	const there = whoAt(state, square);

	return !isWall(state, square) && (there === undefined || there.id === id);
};

export const movesLeft = (state: TableState): number =>
	Math.max(0, state.allowance - state.spent);

export const reachable = (state: TableState): Array<Square> => {
	if (state.turn !== HERO || state.winner !== "") {
		return [];
	}

	const reach = reachFrom(state, HERO);
	const left = movesLeft(state);

	return reach.cost.flatMap((cost, index) => {
		const square = squareAt(index);

		return cost > 0 && cost <= left && canEnd(state, HERO, square)
			? [square]
			: [];
	});
};

interface Rolled {
	readonly rolls: ReadonlyArray<number>;
	readonly seed: number;
}

const MODULUS = 2_147_483_647;

export const rollDice = (
	seed: number,
	count: number,
	sides: number
): Rolled => {
	const rolls: Array<number> = [];
	let next = seed;

	for (let die = 0; die < count; die += 1) {
		next = (next * 48_271) % MODULUS;
		rolls.push(1 + (next % sides));
	}

	return { rolls, seed: next };
};

const sumOf = (values: ReadonlyArray<number>): number =>
	values.reduce((total, value) => total + value, 0);

const refuse = (reason: string): Result.Result<Decision, string> =>
	Result.fail(reason);

const accept = (
	events: ReadonlyArray<Authored>,
	seed: number
): Result.Result<Decision, string> => Result.succeed({ events, seed });

const wordsOf = (name: string): Array<string> =>
	name.toLowerCase().split(/[\s-]+/u);

const matches = (query: string, id: string, name: string): boolean =>
	id.startsWith(query) ||
	name.toLowerCase().startsWith(query) ||
	wordsOf(name).some((word) => word.startsWith(query));

export const whoOf = (text: string): Result.Result<Fighter, string> => {
	const marked = FIGHTERS.find((fighter) => fighter.mark === text);
	const query = text.toLowerCase();

	const exact = FIGHTERS.find(
		(fighter) => fighter.id === query || fighter.name.toLowerCase() === query
	);

	const found = FIGHTERS.filter((fighter) =>
		matches(query, fighter.id, fighter.name)
	);

	const [only] = found;

	if (marked !== undefined) {
		return Result.succeed(marked);
	}

	if (exact !== undefined) {
		return Result.succeed(exact);
	}

	if (found.length === 1 && only !== undefined) {
		return Result.succeed(only);
	}

	return Result.fail(
		found.length === 0
			? `There's nobody called ${text} at this table.`
			: `${text} could be ${found.map((fighter) => fighter.name).join(" or ")}.`
	);
};

const abilityNamed = (
	fighter: Fighter,
	text: string
): Result.Result<Ability, string> => {
	const query = text.toLowerCase();

	const found = fighter.abilities.filter(
		(ability) =>
			ability.name.toLowerCase() === query ||
			matches(query, ability.name.toLowerCase(), ability.name)
	);

	const [only] = found;

	return found.length === 1 && only !== undefined
		? Result.succeed(only)
		: Result.fail(
				`${fighter.name} has no ability called ${text}; try ${fighter.abilities.map((ability) => ability.name).join(" or ")}.`
			);
};

const placeOf = (
	state: TableState,
	text: string
): Result.Result<{ readonly at: Square; readonly label: string }, string> => {
	const square = squareOfName(text);

	if (square !== undefined && !FIGHTERS.some((f) => f.mark === text)) {
		return Result.succeed({ at: square, label: nameOfSquare(square) });
	}

	return Result.map(whoOf(text), (fighter) => {
		const at = bodyOf(state, fighter.id)?.at ?? fighter.start;

		return { at, label: `${fighter.name} (${nameOfSquare(at)})` };
	});
};

const yours = (fighter: Fighter): Result.Result<Fighter, string> =>
	fighter.id === HERO
		? Result.succeed(fighter)
		: Result.fail(`You play Brann; ${fighter.name} is the GM's to run.`);

const playing = (state: TableState): string => {
	if (state.winner !== "") {
		return "The fight is over. Start over to play it again.";
	}

	return state.turn === HERO ? "" : "It isn't Brann's turn.";
};

const mover = (
	state: TableState,
	text: string
): Result.Result<Fighter, string> => {
	const blocked = playing(state);

	return blocked === ""
		? Result.flatMap(whoOf(text), yours)
		: Result.fail(blocked);
};

const move = (
	state: TableState,
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const [who = "", where = "", flag = ""] = args;

	if (who === "" || where === "") {
		return refuse("/move takes who and a square: /move brann g4.");
	}

	return Result.flatMap(mover(state, who), (fighter) => {
		const to = squareOfName(where);
		const from = bodyOf(state, fighter.id)?.at ?? fighter.start;
		const main = flag === "main";

		if (to === undefined) {
			return refuse(`${where} isn't a square on this map (a1 to n7).`);
		}

		if (isWall(state, to)) {
			return refuse(`${nameOfSquare(to)} is a wall.`);
		}

		if (isSame(from, to)) {
			return refuse(`${fighter.name} is already at ${nameOfSquare(to)}.`);
		}

		if (!canEnd(state, fighter.id, to)) {
			return refuse(
				`${nameOf(whoAt(state, to)?.id ?? "")} is at ${nameOfSquare(to)}, and nobody ends a move on another creature.`
			);
		}

		if (main && state.acted) {
			return refuse(`${fighter.name} has used its main action this turn.`);
		}

		const reach = reachFrom(state, fighter.id);
		const cost = reach.cost[indexOf(to)] ?? Infinity;
		const left = movesLeft(state) + (main ? fighter.speed : 0);

		if (cost === Infinity) {
			return refuse(`${fighter.name} can't reach ${nameOfSquare(to)}.`);
		}

		if (cost > left) {
			return refuse(
				state.spent === 0 && !main
					? `${fighter.name} can't move that far: ${nameOfSquare(to)} takes ${plural(cost, "square")} of movement, and ${fighter.name}'s speed is ${fighter.speed}.`
					: `${fighter.name} can't move that far: ${nameOfSquare(to)} takes ${plural(cost, "square")} of movement, and ${fighter.name} has ${left} left this turn.`
			);
		}

		return accept(
			[
				{
					actor: YOU,
					event: Happened.Moved({
						id: fighter.id,
						path: pathTo(reach, to),
						cost,
						speed: fighter.speed,
						main,
					}),
				},
			],
			seed
		);
	});
};

const pushed = (
	state: TableState,
	source: string,
	target: string,
	push: number
): ReadonlyArray<Happened> => {
	const from = bodyOf(state, source)?.at;
	const start = bodyOf(state, target)?.at;
	const { stability } = fighterOf(target);
	const distance = Math.max(0, push - stability);

	if (from === undefined || start === undefined || push <= 0) {
		return [];
	}

	const step = {
		x: Math.sign(start.x - from.x),
		y: Math.sign(start.y - from.y),
	};

	const path: Array<Square> = [];
	let at = start;
	let left = distance;
	let stopped = "";

	while (left > 0 && stopped === "") {
		const next = { x: at.x + step.x, y: at.y + step.y };
		const there = whoAt(state, next);

		if (!isInside(next)) {
			stopped = "edge";
		} else if (isWall(state, next) || cutsCorner(state, at, step)) {
			stopped = "wall";
		} else if (there === undefined || there.id === target) {
			path.push(next);
			at = next;
			left -= 1;
		} else {
			stopped = there.id;
		}
	}

	const moved = Happened.ForceMoved({
		id: target,
		kind: "push",
		source,
		path,
		distance: push,
		stability,
		stopped,
	});

	if (stopped === "wall") {
		return [
			moved,
			Happened.Damaged({ id: target, amount: 2 + left, source: "wall" }),
		];
	}

	if (stopped !== "" && stopped !== "edge") {
		return [
			moved,
			Happened.Damaged({ id: target, amount: left, source: stopped }),
			Happened.Damaged({ id: stopped, amount: left, source: target }),
		];
	}

	return [moved];
};

const after = (
	state: TableState,
	events: ReadonlyArray<Happened>
): TableState => {
	let now = state;

	for (const event of events) {
		now = apply(now, event);
	}

	return now;
};

const strike = (
	state: TableState,
	fighter: Fighter,
	ability: Ability,
	targets: ReadonlyArray<Fighter>,
	seed: number
): Struck => {
	const { rolls, seed: next } = rollDice(seed, 2, 10);
	const total = sumOf(rolls) + ability.characteristic;
	const tier = tierOf(total);
	const from = bodyOf(state, fighter.id)?.at ?? fighter.start;

	const rolled = Happened.PowerRolled({
		id: fighter.id,
		ability: ability.name,
		dice: rolls,
		bonus: ability.characteristic,
		total,
		tier,
		cost: ability.cost,
		targets: targets.map((target) => ({
			id: target.id,
			apart: apart(from, bodyOf(state, target.id)?.at ?? target.start),
		})),
	});

	const hits = targets.map((target) =>
		Happened.Damaged({
			id: target.id,
			amount: damageOf(ability, tier),
			source: fighter.id,
		})
	);

	const struck = after(state, [rolled, ...hits]);

	const pushes = targets.flatMap((target) =>
		isDead(struck, target.id)
			? []
			: pushed(struck, fighter.id, target.id, pushOf(ability, tier))
	);

	return { events: [rolled, ...hits, ...pushes], seed: next };
};

const foesBeaten = (state: TableState): boolean =>
	FIGHTERS.every(
		(fighter) => fighter.side === "heroes" || isDead(state, fighter.id)
	);

const powerRoll = (
	state: TableState,
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const [who = "", ...rest] = args;
	const on = rest.indexOf("on");
	const named = (on === -1 ? rest : rest.slice(0, on)).join(" ");
	const aimed = on === -1 ? [] : rest.slice(on + 1);

	if (who === "" || named === "") {
		return refuse("/pr takes who and an ability: /pr brann driving on b.");
	}

	return Result.flatMap(mover(state, who), (fighter) =>
		Result.flatMap(abilityNamed(fighter, named), (ability) => {
			const found = aimed.map(whoOf);
			const failed = found.find(Result.isFailure);

			const seen = new Set<string>();

			const targets = found.flatMap((target) => {
				if (!Result.isSuccess(target) || seen.has(target.success.id)) {
					return [];
				}

				seen.add(target.success.id);

				return [target.success];
			});

			const fallen = targets.find((target) => isDead(state, target.id));

			if (state.acted) {
				return refuse(`${fighter.name} has used its main action this turn.`);
			}

			if (ability.cost > state.wrath) {
				return refuse(
					`${ability.name} costs ${ability.cost} wrath, and ${fighter.name} has ${state.wrath}.`
				);
			}

			if (failed !== undefined) {
				return refuse(failed.failure);
			}

			if (targets.some((target) => target.id === fighter.id)) {
				return refuse(`${fighter.name} can't be its own target.`);
			}

			if (fallen !== undefined) {
				return refuse(`${fallen.name} is dead.`);
			}

			const struck = strike(state, fighter, ability, targets, seed);
			const ended = after(state, struck.events);
			const events = struck.events.map((event) => ({ actor: YOU, event }));

			return accept(
				foesBeaten(ended)
					? [
							...events,
							{
								actor: GM,
								event: Happened.CombatEnded({ winner: "heroes" }),
							},
						]
					: events,
				struck.seed
			);
		})
	);
};

const recover = (
	state: TableState,
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const [who = ""] = args;

	if (who === "") {
		return refuse("/recover takes a hero: /recover brann.");
	}

	return Result.flatMap(mover(state, who), (fighter) => {
		const stamina = bodyOf(state, fighter.id)?.stamina ?? 0;

		if (state.breathed) {
			return refuse(`${fighter.name} has caught its breath this turn already.`);
		}

		if (state.recoveries <= 0) {
			return refuse(`${fighter.name} has no Recoveries left.`);
		}

		if (stamina <= 0) {
			return refuse(
				`${fighter.name} is dying, and a dying hero can't catch their breath in combat.`
			);
		}

		if (stamina >= fighter.stamina) {
			return refuse(`${fighter.name}'s Stamina is full.`);
		}

		return accept(
			[
				{
					actor: YOU,
					event: Happened.Recovered({ id: fighter.id, amount: RECOVERY_VALUE }),
				},
			],
			seed
		);
	});
};

const towards = (
	state: TableState,
	fighter: Fighter,
	reach: number
): Happened | undefined => {
	const target = bodyOf(state, HERO)?.at ?? BRANN.start;
	const from = bodyOf(state, fighter.id)?.at ?? fighter.start;
	const routes = reachFrom(state, fighter.id);

	const score = (square: Square, cost: number) =>
		Math.max(0, apart(square, target) - reach) * 100 + cost;

	let best = from;
	let bestScore = score(from, 0);

	for (const [index, cost] of routes.cost.entries()) {
		const square = squareAt(index);
		const scored = score(square, cost);

		if (
			cost <= fighter.speed &&
			canEnd(state, fighter.id, square) &&
			scored < bestScore
		) {
			best = square;
			bestScore = scored;
		}
	}

	return isSame(best, from)
		? undefined
		: Happened.Moved({
				id: fighter.id,
				path: pathTo(routes, best),
				cost: routes.cost[indexOf(best)] ?? 0,
				speed: fighter.speed,
				main: false,
			});
};

const directorTurn = (
	state: TableState,
	fighter: Fighter,
	seed: number
): Struck => {
	const [ability] = fighter.abilities;
	const started = Happened.TurnStarted({ id: fighter.id, gain: 0 });
	const ended = Happened.TurnEnded({ id: fighter.id });

	if (ability === undefined || isDead(state, HERO)) {
		return { events: [started, ended], seed };
	}

	const begun = apply(state, started);
	const stepped = towards(begun, fighter, ability.reach);
	const moved = stepped === undefined ? begun : apply(begun, stepped);
	const from = bodyOf(moved, fighter.id)?.at ?? fighter.start;
	const hero = bodyOf(moved, HERO)?.at ?? BRANN.start;

	const struck: Struck =
		apart(from, hero) <= ability.reach
			? strike(moved, fighter, ability, [BRANN], seed)
			: { events: [], seed };

	const events: Array<Happened> = [started];

	if (stepped !== undefined) {
		events.push(stepped);
	}

	events.push(...struck.events, ended);

	return { events, seed: struck.seed };
};

const done = (
	state: TableState,
	seed: number
): Result.Result<Decision, string> => {
	const blocked = playing(state);

	if (blocked !== "") {
		return refuse(blocked);
	}

	const first = Happened.TurnEnded({ id: HERO });
	let now = apply(state, first);
	let dice = seed;
	const events: Array<Authored> = [{ actor: YOU, event: first }];

	for (const fighter of FIGHTERS) {
		if (fighter.side === "director" && !isDead(now, fighter.id)) {
			const turn = directorTurn(now, fighter, dice);

			dice = turn.seed;
			now = after(now, turn.events);
			events.push(...turn.events.map((event) => ({ actor: GM, event })));
		}
	}

	const closing = isDead(now, HERO)
		? [Happened.CombatEnded({ winner: "director" })]
		: [
				Happened.RoundStarted({ round: state.round + 1 }),
				Happened.TurnStarted({ id: HERO, gain: WRATH_PER_TURN }),
			];

	return accept(
		[...events, ...closing.map((event) => ({ actor: GM, event }))],
		dice
	);
};

const NOTATION =
	/^(?<count>\d{0,2})d(?<sides>\d{1,3})(?<modifier>[+-]\d{1,3})?$/u;

const roll = (
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const notation = args.join("").toLowerCase();
	const found = NOTATION.exec(notation);

	const count = Number(
		found?.groups?.count === "" ? "1" : (found?.groups?.count ?? "1")
	);

	const sides = Number(found?.groups?.sides ?? "0");
	const modifier = Number(found?.groups?.modifier ?? "0");

	if (found === null || count < 1 || count > 20 || sides < 2 || sides > 100) {
		return refuse(
			"/roll takes dice like 2d10+3: up to 20 dice of 2 to 100 sides."
		);
	}

	const { rolls, seed: next } = rollDice(seed, count, sides);

	return accept(
		[
			{
				actor: YOU,
				event: Happened.DiceRolled({
					notation,
					rolls,
					modifier,
					total: sumOf(rolls) + modifier,
				}),
			},
		],
		next
	);
};

const measure = (
	state: TableState,
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const [one = "", other = ""] = args;

	if (one === "" || other === "") {
		return refuse("/dist takes two tokens or squares: /dist B b.");
	}

	return Result.flatMap(placeOf(state, one), (from) =>
		Result.flatMap(placeOf(state, other), (to) =>
			accept(
				[
					{
						actor: YOU,
						event: Happened.Measured({
							from: from.at,
							to: to.at,
							squares: apart(from.at, to.at),
							between: [from.label, to.label],
						}),
					},
				],
				seed
			)
		)
	);
};

const UNDOABLE = new Set(["Moved", "Recovered"]);

const QUIET = new Set(["ChatPosted", "DiceRolled", "Measured", "Retracted"]);

const undo = (
	log: ReadonlyArray<Entry>,
	feed: ReadonlyArray<FeedLine>,
	seed: number
): Result.Result<Decision, string> => {
	const retracted = retractedIn(log);

	const latest = log.findLast(
		(entry) => !QUIET.has(entry.event._tag) && !retracted.has(entry.seq)
	);

	if (latest === undefined || latest.actor !== YOU) {
		return refuse(
			"Nothing of yours is the latest change; the GM's turn came after it, so only the GM can take it back."
		);
	}

	if (!UNDOABLE.has(latest.event._tag)) {
		return refuse(
			"A change that rolled dice is the GM's alone to take back, so nobody rolls again by undoing."
		);
	}

	return accept(
		[
			{
				actor: YOU,
				event: Happened.Retracted({
					seqs: [latest.seq],
					undone: feed.flatMap((line) =>
						line.seq === latest.seq ? [line.text] : []
					),
				}),
			},
		],
		seed
	);
};

export const decide = (
	log: ReadonlyArray<Entry>,
	line: string,
	seed: number
): Result.Result<Decision, string> => {
	const { state, feed } = fold(log);
	const text = line.trim();
	const [head = "", ...args] = text.split(/\s+/u);

	if (!head.startsWith("/")) {
		return accept([{ actor: YOU, event: Happened.ChatPosted({ text }) }], seed);
	}

	switch (head.toLowerCase()) {
		case "/say": {
			return args.length === 0
				? refuse("/say takes something to say.")
				: accept(
						[
							{
								actor: YOU,
								event: Happened.ChatPosted({ text: args.join(" ") }),
							},
						],
						seed
					);
		}

		case "/roll": {
			return roll(args, seed);
		}

		case "/move": {
			return move(state, args, seed);
		}

		case "/pr": {
			return powerRoll(state, args, seed);
		}

		case "/recover": {
			return recover(state, args, seed);
		}

		case "/dist": {
			return measure(state, args, seed);
		}

		case "/done": {
			return done(state, seed);
		}

		case "/undo": {
			return undo(log, feed, seed);
		}

		case "/fs": {
			return refuse(
				"/fs is the GM's: a creature's free strike. Brann strikes with /pr."
			);
		}

		default: {
			return refuse(
				`There's no ${head} at this table; /help lists what this demo knows.`
			);
		}
	}
};

export const entriesOf = (
	log: ReadonlyArray<Entry>,
	events: ReadonlyArray<Authored>
): Array<Entry> => {
	const start = log.at(-1)?.at ?? 0;
	const entries: Array<Entry> = [...log];
	let at = start;

	for (const [index, authored] of events.entries()) {
		if (index === 0 || events[index - 1]?.actor !== authored.actor) {
			at += 1;
		}

		entries.push({
			seq: entries.length + 1,
			at,
			actor: authored.actor,
			event: authored.event,
		});
	}

	return entries;
};

export const OPENING_LOG: ReadonlyArray<Entry> = entriesOf([], OPENING);
