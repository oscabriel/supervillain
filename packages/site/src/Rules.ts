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
	Bled: { id: Id, roll: Schema.Int, level: Schema.Int },
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
	readonly dashed: boolean;
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
	dashed: false,
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
	Bled: "ds.bled",
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

	return !fighter.minion && stamina <= windedAt(fighter) ? "winded" : "";
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

const staminaAfter = (id: string, stamina: number, loss: number): number =>
	fighterOf(id).side === "heroes"
		? stamina - loss
		: Math.max(0, stamina - loss);

const sumOf = (values: ReadonlyArray<number>): number =>
	values.reduce((total, value) => total + value, 0);

export const isNatural = (dice: ReadonlyArray<number>): boolean =>
	sumOf(dice) >= 19;

const afterMove = (
	state: TableState,
	event: typeof Happened.Moved.Type
): TableState => {
	const own = state.turn === event.id;
	const dash = own && event.main && !state.dashed;

	return {
		...changeBody(state, event.id, (body) => ({
			...body,
			at: lastOf(event.path, body.at),
		})),
		spent: own ? state.spent + event.cost : state.spent,
		allowance: dash
			? state.allowance + fighterOf(event.id).speed
			: state.allowance,
		acted: state.acted || dash,
		dashed: state.dashed || dash,
	};
};

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
			dashed: false,
			breathed: false,
		}),
		Moved: (step) => afterMove(state, step),
		PowerRolled: ({ id, cost, dice }) => ({
			...state,
			acted: state.acted || (state.turn === id && !isNatural(dice)),
			wrath: id === HERO ? state.wrath - cost : state.wrath,
		}),
		Damaged: ({ id, amount }) =>
			changeBody(state, id, (body) => ({
				...body,
				stamina: staminaAfter(id, body.stamina, amount),
			})),
		Bled: ({ id, roll, level }) =>
			changeBody(state, id, (body) => ({
				...body,
				stamina: staminaAfter(id, body.stamina, roll + level),
			})),
		ForceMoved: ({ id, path }) =>
			changeBody(state, id, (body) => ({ ...body, at: lastOf(path, body.at) })),
		Recovered: ({ id, amount }) => ({
			...changeBody(state, id, (body) => ({
				...body,
				stamina: body.stamina + amount,
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

const movedText = (event: typeof Happened.Moved.Type): string => {
	const to = event.path.at(-1);
	const where = to === undefined ? "where it stood" : nameOfSquare(to);
	const how = event.main ? ", with the main action" : "";

	return `${nameOf(event.id)} moves to ${where} (${plural(event.cost, "square")} of movement${how}).`;
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

const meterText = (state: TableState, id: string): string => {
	const stamina = bodyOf(state, id)?.stamina ?? 0;
	const status = statusOf(state, id);
	const health = status === "" ? "" : ` · ${status}`;

	return `${stamina}/${fighterOf(id).stamina}${health}`;
};

const staminaText = (state: TableState, id: string, amount: number): string => {
	const hit = apply(state, Happened.Damaged({ id, amount, source: "" }));

	return `${nameOf(id)} takes ${amount} damage → ${meterText(hit, id)}`;
};

const bledText = (
	state: TableState,
	event: typeof Happened.Bled.Type
): string => {
	const loss = event.roll + event.level;

	return `${nameOf(event.id)} bleeds and loses ${loss} Stamina (1d6: ${event.roll}, + level ${event.level}) → ${meterText(apply(state, event), event.id)}`;
};

const intoText = (stopped: string): string => {
	if (stopped === "" || stopped === "edge") {
		return "";
	}

	return stopped === "wall" ? ", into a wall" : `, into ${nameOf(stopped)}`;
};

const pushText = (event: typeof Happened.ForceMoved.Type): string => {
	const to = event.path.at(-1);
	const into = intoText(event.stopped);

	if (to === undefined) {
		return event.stopped === ""
			? `${nameOf(event.id)} is pushed by ${nameOf(event.source)} but doesn't move (push ${event.distance}, stability ${event.stability}).`
			: `${nameOf(event.id)} is pushed by ${nameOf(event.source)} and doesn't move${into}.`;
	}

	return `${nameOf(event.id)} is pushed ${plural(event.path.length, "square")} by ${nameOf(event.source)} to ${nameOfSquare(to)}${into}.`;
};

const naturalText = (
	state: TableState,
	event: typeof Happened.PowerRolled.Type
): string => {
	if (!isNatural(event.dice)) {
		return "";
	}

	const natural = `, natural ${sumOf(event.dice)}`;

	return state.turn === event.id ? `${natural}, extra main action` : natural;
};

const rollText = (
	state: TableState,
	event: typeof Happened.PowerRolled.Type
): Array<string> => {
	const fighter = fighterOf(event.id);
	const used = abilityOf(fighter, event.ability);
	const names = event.targets.map((target) => nameOf(target.id));
	const on = names.length === 0 ? "" : ` on ${names.join(" and ")}`;
	const spent = event.cost > 0 ? ` (${event.cost} wrath)` : "";
	const effect = used === undefined ? "" : ` · ${effectText(used, event.tier)}`;

	const natural = naturalText(state, event);

	const far = event.targets.flatMap((target) =>
		used !== undefined && target.apart > used.reach
			? [
					`${nameOf(target.id)} is ${plural(target.apart, "square")} away, past ${used.distance}.`,
				]
			: []
	);

	return [
		`${fighter.name} uses ${event.ability}${spent}${on}: [${event.dice.join(", ")}] +${event.bonus} = ${event.total}${natural} · tier ${event.tier}${effect}`,
		...far,
	];
};

const modifierText = (modifier: number): string => {
	if (modifier === 0) {
		return "";
	}

	return modifier > 0 ? ` +${modifier}` : ` −${Math.abs(modifier)}`;
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
		Moved: (event) => [movedText(event)],
		PowerRolled: (event) => rollText(state, event),
		Damaged: ({ id, amount, source }) => [
			source === "wall"
				? `${staminaText(state, id, amount)} from the wall`
				: staminaText(state, id, amount),
		],
		Bled: (event) => [bledText(state, event)],
		ForceMoved: (event) => [pushText(event)],
		Recovered: ({ id, amount }) => {
			const before = bodyOf(state, id)?.stamina ?? 0;

			return [
				`${nameOf(id)} spends a Recovery and regains ${amount} Stamina → ${before + amount}/${fighterOf(id).stamina}.`,
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
			`rolls ${notation}: [${rolls.join(", ")}]${modifierText(modifier)} = ${total}`,
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
	Bled: "hit",
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
	{ x: 0, y: -1 },
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 },
	{ x: 1, y: -1 },
	{ x: 1, y: 1 },
	{ x: -1, y: 1 },
	{ x: -1, y: -1 },
];

const isInside = (square: Square): boolean =>
	square.x >= 0 && square.y >= 0 && square.x < COLUMNS && square.y < ROWS;

const isStone = (state: TableState, square: Square): boolean =>
	terrainAt(state.terrain, square) === "#";

const isWall = (state: TableState, square: Square): boolean =>
	!isInside(square) || isStone(state, square);

const cutsCorner = (state: TableState, from: Square, step: Square): boolean =>
	step.x !== 0 &&
	step.y !== 0 &&
	(isStone(state, { x: from.x + step.x, y: from.y }) ||
		isStone(state, { x: from.x, y: from.y + step.y }));

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
	found: ReadonlyArray<number>,
	done: ReadonlyArray<boolean>
): number => {
	let best = -1;
	let lowest = Infinity;
	let earliest = Infinity;

	for (const [index, price] of cost.entries()) {
		const order = found[index] ?? Infinity;
		const sooner = price < lowest || (price === lowest && order < earliest);

		if (!(done[index] ?? true) && price < Infinity && sooner) {
			best = index;
			lowest = price;
			earliest = order;
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

	return rough || hostile ? 2 : 1;
};

export const reachFrom = (state: TableState, id: string): Reach => {
	const mover = fighterOf(id);
	const start = bodyOf(state, id)?.at ?? mover.start;
	const size = COLUMNS * ROWS;
	const cost = Array.from({ length: size }, () => Infinity);
	const back = Array.from({ length: size }, () => -1);
	const found = Array.from({ length: size }, () => Infinity);
	const done = Array.from({ length: size }, () => false);
	let order = 0;

	cost[indexOf(start)] = 0;
	found[indexOf(start)] = order;

	let best = cheapestOpen(cost, found, done);

	while (best !== -1) {
		done[best] = true;

		const from = squareAt(best);
		const here = cost[best] ?? Infinity;

		for (const step of STEPS) {
			const to = indexOf({ x: from.x + step.x, y: from.y + step.y });
			const through = here + priceOf(state, mover, from, step);

			if (through < (cost[to] ?? Infinity)) {
				order += 1;
				cost[to] = through;
				back[to] = best;
				found[to] = order;
			}
		}

		best = cheapestOpen(cost, found, done);
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

const refuse = (reason: string): Result.Result<Decision, string> =>
	Result.fail(reason);

const accept = (
	events: ReadonlyArray<Authored>,
	seed: number
): Result.Result<Decision, string> => Result.succeed({ events, seed });

const beginsWord = (key: string, query: string): boolean =>
	Array.from(key, (_char, index) => index).some(
		(index) =>
			(index === 0 || key[index - 1] === " " || key[index - 1] === "-") &&
			key.startsWith(query, index)
	);

const STAGES: ReadonlyArray<(key: string, query: string) => boolean> = [
	(key, query) => key.startsWith(query),
	beginsWord,
];

const begunBy = <T>(
	items: ReadonlyArray<T>,
	keysOf: (item: T) => ReadonlyArray<string>,
	query: string
): ReadonlyArray<T> => {
	if (query === "") {
		return [];
	}

	for (const stage of STAGES) {
		const begun = items.filter((item) =>
			keysOf(item).some((key) => stage(key.toLowerCase(), query))
		);

		if (begun.length > 0) {
			return begun;
		}
	}

	return [];
};

const orList = (names: ReadonlyArray<string>): string =>
	names.length <= 1
		? (names[0] ?? "")
		: `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;

export const whoOf = (text: string): Result.Result<Fighter, string> => {
	const query = text.trim().toLowerCase();

	const exact = FIGHTERS.find(
		(fighter) => fighter.id === query || fighter.name.toLowerCase() === query
	);

	const marked = FIGHTERS.find((fighter) => fighter.mark === text.trim());

	const begun = begunBy(
		FIGHTERS,
		(fighter) => [fighter.id, fighter.name],
		query
	);

	const [only] = begun;
	const found = exact ?? marked ?? (begun.length === 1 ? only : undefined);

	if (found !== undefined) {
		return Result.succeed(found);
	}

	return Result.fail(
		begun.length === 0
			? `There's nobody called ${text} at this table.`
			: `${text} could be ${orList(begun.map((fighter) => fighter.name))}.`
	);
};

const CHARACTERISTICS: ReadonlyArray<string> = [
	"Might",
	"Agility",
	"Reason",
	"Intuition",
	"Presence",
];

const abilityNamed = (
	fighter: Fighter,
	text: string
): Result.Result<Ability, string> => {
	const query = text.trim().toLowerCase();

	const names = [
		...fighter.abilities.map((ability) => ability.name),
		...CHARACTERISTICS,
	];

	const exact = names.find((name) => name.toLowerCase() === query);

	const begun =
		exact === undefined ? begunBy(names, (name) => [name], query) : [exact];

	const [only] = begun;

	if (begun.length > 1) {
		return Result.fail(`${text} could be ${orList(begun)}.`);
	}

	const found = fighter.abilities.find((ability) => ability.name === only);

	return found === undefined
		? Result.fail(
				`${fighter.name} has no ability called ${text}; try ${orList(fighter.abilities.map((ability) => ability.name))}.`
			)
		: Result.succeed(found);
};

interface Place {
	readonly at: Square;
	readonly label: string;
}

const placeOf = (
	state: TableState,
	text: string
): Result.Result<Place, string> => {
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

const foesBeaten = (state: TableState): boolean =>
	FIGHTERS.every(
		(fighter) => fighter.side === "heroes" || isDead(state, fighter.id)
	);

const bleedOf = (state: TableState, fighter: Fighter, seed: number): Struck => {
	if (statusOf(state, fighter.id) !== "dying") {
		return { events: [], seed };
	}

	const { rolls, seed: next } = rollDice(seed, 1, 6);
	const [roll = 1] = rolls;

	return {
		events: [Happened.Bled({ id: fighter.id, roll, level: fighter.level })],
		seed: next,
	};
};

const closed = (
	state: TableState,
	events: ReadonlyArray<Happened>
): ReadonlyArray<Authored> => {
	const ended = after(state, events);
	const own = events.map((event) => ({ actor: YOU, event }));

	if (foesBeaten(ended)) {
		return [
			...own,
			{ actor: GM, event: Happened.CombatEnded({ winner: "heroes" }) },
		];
	}

	return isDead(ended, HERO)
		? [
				...own,
				{ actor: GM, event: Happened.CombatEnded({ winner: "director" }) },
			]
		: own;
};

const move = (
	state: TableState,
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const [who = "", where = "", flag = "", extra = ""] = args;
	const word = flag.toLowerCase();

	if (who === "" || where === "" || extra !== "") {
		return refuse("/move takes who and a square: /move brann g4.");
	}

	if (word !== "" && word !== "main") {
		return refuse(
			`/move takes main after the square, not ${flag}: /move brann g4 main.`
		);
	}

	return Result.flatMap(mover(state, who), (fighter) => {
		const to = squareOfName(where);
		const from = bodyOf(state, fighter.id)?.at ?? fighter.start;
		const main = state.dashed || word === "main";
		const dash = main && !state.dashed;

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

		if (dash && state.acted) {
			return refuse(`${fighter.name} has used its main action this turn.`);
		}

		const reach = reachFrom(state, fighter.id);
		const cost = reach.cost[indexOf(to)] ?? Infinity;
		const left = movesLeft(state) + (dash ? fighter.speed : 0);

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

		const stepped = Happened.Moved({
			id: fighter.id,
			path: pathTo(reach, to),
			cost,
			speed: fighter.speed,
			main,
		});

		const bled: Struck = dash
			? bleedOf(state, fighter, seed)
			: { events: [], seed };

		return accept(closed(state, [stepped, ...bled.events]), bled.seed);
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

		if (isStone(state, next) || cutsCorner(state, at, step)) {
			stopped = "wall";
		} else if (!isInside(next)) {
			stopped = "edge";
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

	const bled = bleedOf(state, fighter, next);
	const struck = after(state, [rolled, ...hits, ...bled.events]);

	const pushes = targets.flatMap((target) =>
		isDead(struck, target.id) || isDead(struck, fighter.id)
			? []
			: pushed(struck, fighter.id, target.id, pushOf(ability, tier))
	);

	return {
		events: [rolled, ...hits, ...bled.events, ...pushes],
		seed: bled.seed,
	};
};

const powerRoll = (
	state: TableState,
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const [who = "", ...rest] = args;
	const on = rest.findLastIndex((word) => word.toLowerCase() === "on");
	const named = (on === -1 ? rest : rest.slice(0, on)).join(" ");
	const aimed = on === -1 ? [] : rest.slice(on + 1);

	if (who === "" || named === "" || (on !== -1 && aimed.length === 0)) {
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

			return accept(closed(state, struck.events), struck.seed);
		})
	);
};

const recover = (
	state: TableState,
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const [who = "", extra = ""] = args;

	if (who === "" || extra !== "") {
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
					event: Happened.Recovered({
						id: fighter.id,
						amount: Math.min(RECOVERY_VALUE, fighter.stamina - stamina),
					}),
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

const signedText = (value: number): string => {
	if (value === 0) {
		return "";
	}

	return value > 0 ? `+${value}` : `${value}`;
};

const roll = (
	args: ReadonlyArray<string>,
	seed: number
): Result.Result<Decision, string> => {
	const found = NOTATION.exec(args.join("").toLowerCase());

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
					notation: `${count}d${sides}${signedText(modifier)}`,
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
	const [one = "", other = "", extra = ""] = args;

	if (one === "" || other === "" || extra !== "") {
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
			return args.length === 0
				? undo(log, feed, seed)
				: refuse("/undo takes nothing here: it takes back your latest move.");
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
