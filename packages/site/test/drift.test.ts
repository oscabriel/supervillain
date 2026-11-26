import { describe, expect, test } from "bun:test";

import {
	bandOf,
	cheapestPath,
	CorePayloads,
	GM as REAL_GM,
	isRefused,
	moverWalk,
	parseInputLine,
	rules,
} from "@supervillain/domain";
import type {
	Ability as RealAbility,
	Characteristic,
	Command,
	Envelope,
	HeroSheet,
	StatBlock,
	TableState as RealState,
} from "@supervillain/domain";
import { moverOf, occupants } from "@supervillain/domain/rules/drawSteel/board";
import { Payloads } from "@supervillain/domain/rules/drawSteel/events";
import { findWho, resolve } from "@supervillain/domain/rules/drawSteel/state";
import { decodePayload } from "@supervillain/domain/rules/engine";
import { Result } from "effect";

import { AUTOPLAY_SCRIPT } from "../src/Autoplay.ts";
import {
	BRANN,
	COLUMNS,
	FIGHTERS,
	fighterOf,
	HERO,
	MAP_ID,
	MAP_NAME,
	nameOfSquare,
	pushOf,
	RECOVERIES,
	ROWS,
	squareOfName,
	TERRAIN,
	WRATH_PER_TURN,
} from "../src/Encounter.ts";
import type { Ability, Fighter, Square } from "../src/Encounter.ts";
import {
	bodyOf,
	decide,
	entriesOf,
	fold,
	GM,
	Happened,
	labelOf,
	movesLeft,
	OPENING,
	OPENING_LOG,
	reachable,
	reachFrom,
	rollDice,
	statusOf,
	TYPES,
	whoOf,
	YOU,
} from "../src/Rules.ts";
import type { Entry, TableState } from "../src/Rules.ts";
import { DEMO, gmSaid, sent, suggestionsOf } from "../src/Table.ts";
import type { Demo } from "../src/Table.ts";

const PLAYER = "key:SHA256:abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEFG";

const RULESET = "draw-steel";

const STARTED = Date.UTC(2026, 0, 1);

const SQUAD = "a";

const FIRST_ROLL = 10;

const KNOWN_DIFFERENCES = {
	combatBegins: { demo: "ds.round-started", real: "ds.combat-started" },
	wordedApart: ["ForceMoved", "CombatEnded"],
	setUpByTheGm: [
		"core.door-set",
		"ds.hero-joined",
		"ds.creatures-added",
		"ds.hero-claimed",
		"ds.first-set",
	],
} as const;

const WORDED_APART: ReadonlySet<string> = new Set(
	KNOWN_DIFFERENCES.wordedApart
);

const SET_UP_BY_THE_GM: ReadonlySet<string> = new Set(
	KNOWN_DIFFERENCES.setUpByTheGm
);

const realIdOf = (id: string): string =>
	fighterOf(id).minion ? `${id}-${SQUAD}` : id;

const realNameOf = (fighter: Fighter): string =>
	fighter.minion ? `${fighter.name} ${SQUAD.toUpperCase()}` : fighter.name;

const demoIdOf = (id: string): string =>
	FIGHTERS.find((fighter) => realIdOf(fighter.id) === id)?.id ?? id;

const CHARACTERISTIC_OF: ReadonlyMap<string, Characteristic> = new Map<
	string,
	Characteristic
>([
	["M", "might"],
	["A", "agility"],
	["R", "reason"],
	["I", "intuition"],
	["P", "presence"],
]);

const tierText = (ability: Ability, tier: number): string => {
	const plus = ability.letter === "" ? "" : ` + ${ability.letter}`;
	const typed = ability.type === "" ? "" : ` ${ability.type}`;
	const push = pushOf(ability, tier);
	const pushed = push > 0 ? `; push ${push}` : "";
	const rider = ability.rider === "" ? "" : `; ${ability.rider}`;

	return `${ability.base[tier - 1] ?? 0}${plus}${typed} damage${pushed}${rider}`;
};

const heroAbility = (ability: Ability): RealAbility => {
	const uses = CHARACTERISTIC_OF.get(ability.letter);

	return {
		name: ability.name,
		kind: "main action",
		characteristics: uses === undefined ? [] : [uses],
		cost: ability.cost,
		distance: ability.distance,
		tier1: tierText(ability, 1),
		tier2: tierText(ability, 2),
		tier3: tierText(ability, 3),
	};
};

const creatureAbility = (ability: Ability): RealAbility => ({
	name: ability.name,
	kind: "main action",
	bonus: ability.characteristic,
	cost: ability.cost,
	distance: ability.distance,
	tier1: tierText(ability, 1),
	tier2: tierText(ability, 2),
	tier3: tierText(ability, 3),
});

const scoreOf = (fighter: Fighter, letter: string): number =>
	fighter.abilities.find((ability) => ability.letter === letter)
		?.characteristic ?? 0;

const heroSheet = (fighter: Fighter): HeroSheet => ({
	id: fighter.id,
	name: fighter.name,
	class: "Censor",
	level: fighter.level,
	characteristics: {
		might: scoreOf(fighter, "M"),
		agility: scoreOf(fighter, "A"),
		reason: scoreOf(fighter, "R"),
		intuition: scoreOf(fighter, "I"),
		presence: scoreOf(fighter, "P"),
	},
	stamina: fighter.stamina,
	recoveries: RECOVERIES,
	speed: fighter.speed,
	stability: fighter.stability,
	resource: { name: "wrath", perTurn: WRATH_PER_TURN },
	victories: 0,
	abilities: fighter.abilities.map(heroAbility),
});

const statBlock = (fighter: Fighter): StatBlock => ({
	id: fighter.id,
	name: fighter.name,
	level: fighter.level,
	organization: fighter.minion ? "minion" : "platoon",
	stamina: fighter.stamina,
	speed: fighter.speed,
	stability: fighter.stability,
	freeStrike: 1,
	characteristics: {
		might: 0,
		agility: 0,
		reason: 0,
		intuition: 0,
		presence: 0,
	},
	abilities: fighter.abilities.map(creatureAbility),
});

interface Die {
	readonly sides: number;
	readonly face: number;
}

interface Played {
	readonly state: RealState;
	readonly envelopes: ReadonlyArray<Envelope>;
}

const refusalOf = (
	state: RealState,
	actor: string,
	command: Command,
	dice: ReadonlyArray<Die>
): string => {
	const left = [...dice];

	const decision = rules.decide(
		state,
		actor,
		command,
		(sides) => left.shift()?.face ?? sides,
		STARTED + state.seq * 1000
	);

	return isRefused(decision) ? decision.refusal : "";
};

const played = (
	state: RealState,
	actor: string,
	command: Command,
	dice: ReadonlyArray<Die>
): Played => {
	const left = [...dice];
	const at = STARTED + state.seq * 1000;

	const decision = rules.decide(
		state,
		actor,
		command,
		(sides) => {
			const die = left.shift();

			if (die === undefined || die.sides !== sides) {
				throw new Error(
					`the real rules roll a d${sides} here, and the demo rolled ${JSON.stringify(die)}`
				);
			}

			return die.face;
		},
		at
	);

	if (isRefused(decision)) {
		throw new Error(
			`the real rules refuse ${JSON.stringify(command)}: ${decision.refusal}`
		);
	}

	if (left.length > 0) {
		throw new Error(
			`the demo rolled ${JSON.stringify(left)} that the real rules never asked for in ${JSON.stringify(command)}`
		);
	}

	let next = state;
	const envelopes: Array<Envelope> = [];

	for (const event of decision.events) {
		const envelope: Envelope = {
			actor,
			seq: next.seq + 1,
			timestamp: new Date(at).toISOString(),
			type: event.type,
			payload: event.payload,
		};

		next = rules.apply(next, envelope);
		envelopes.push(envelope);
	}

	return { state: next, envelopes };
};

const commandOf = (line: string): Command => {
	const parsed = parseInputLine(line, "chat", RULESET);

	if (parsed.kind !== "command") {
		throw new Error(
			`the real table doesn't read "${line}" as a command: ${JSON.stringify(parsed)}`
		);
	}

	return parsed.command;
};

const typed = (
	state: RealState,
	actor: string,
	line: string,
	dice: ReadonlyArray<Die> = []
): Played => played(state, actor, commandOf(line), dice);

type Places = ReadonlyMap<string, string>;

const AT_THE_FORD: Places = new Map();

const placeOf = (places: Places, fighter: Fighter): Square =>
	squareOfName(places.get(fighter.id) ?? "") ?? fighter.start;

const seated = (places: Places): Played => {
	const setUp: ReadonlyArray<Command> = [
		{ type: "door", door: "open" },
		{ type: "hero", hero: BRANN.id, sheet: heroSheet(BRANN) },
		...FIGHTERS.flatMap((fighter): Array<Command> =>
			fighter.side === "director"
				? [
						{
							type: "add",
							monster: fighter.id,
							count: 1,
							sheet: statBlock(fighter),
						},
					]
				: []
		),
		{
			type: "map",
			id: MAP_ID,
			grid: { name: MAP_NAME, terrain: TERRAIN },
		},
	];

	let table: Played = { state: rules.initial, envelopes: [] };

	const then = (next: Played): void => {
		table = {
			state: next.state,
			envelopes: [...table.envelopes, ...next.envelopes],
		};
	};

	for (const command of setUp) {
		then(played(table.state, REAL_GM, command, []));
	}

	then(typed(table.state, PLAYER, `/play ${BRANN.id}`));

	for (const fighter of FIGHTERS) {
		then(
			typed(
				table.state,
				REAL_GM,
				`/place ${realIdOf(fighter.id)} ${nameOfSquare(placeOf(places, fighter))}`
			)
		);
	}

	then(
		typed(table.state, REAL_GM, "/start", [{ sides: 10, face: FIRST_ROLL }])
	);
	then(typed(table.state, REAL_GM, "/first heroes"));
	then(typed(table.state, REAL_GM, `/turn ${HERO}`));

	return table;
};

interface Slam {
	readonly into: string;
}

const stoppedOf = (
	slam: Slam | undefined,
	edge: boolean | undefined
): string => {
	if (slam !== undefined) {
		return demoIdOf(slam.into);
	}

	return edge === true ? "edge" : "";
};

const pointLabel = (id: string | undefined, at: Square): string =>
	id === undefined
		? nameOfSquare(at)
		: `${fighterOf(demoIdOf(id)).name} (${nameOfSquare(at)})`;

const winnerOf = (before: RealState): "heroes" | "director" =>
	before.ds.creatures.every((creature) => creature.stamina <= 0)
		? "heroes"
		: "director";

type Mirror = (
	envelope: Envelope,
	before: RealState,
	demoSeqOf: ReadonlyMap<number, number>
) => Happened;

const MIRRORS: ReadonlyMap<string, Mirror> = new Map<string, Mirror>([
	[
		"ds.map-loaded",
		(envelope) => {
			const p = decodePayload(Payloads["ds.map-loaded"], envelope);

			return Happened.MapLoaded({
				id: p.id,
				name: p.name,
				terrain: [...p.terrain],
			});
		},
	],
	[
		"ds.placed",
		(envelope) => {
			const p = decodePayload(Payloads["ds.placed"], envelope);

			return Happened.Placed({ id: demoIdOf(p.id), at: p.at });
		},
	],
	["ds.combat-started", () => Happened.RoundStarted({ round: 1 })],
	[
		"ds.round-started",
		(envelope) => {
			const p = decodePayload(Payloads["ds.round-started"], envelope);

			return Happened.RoundStarted({ round: p.round });
		},
	],
	[
		"ds.turn-started",
		(envelope) => {
			const p = decodePayload(Payloads["ds.turn-started"], envelope);

			return Happened.TurnStarted({ id: demoIdOf(p.id), gain: p.gain ?? 0 });
		},
	],
	[
		"ds.turn-ended",
		(envelope) => {
			const p = decodePayload(Payloads["ds.turn-ended"], envelope);

			return Happened.TurnEnded({ id: demoIdOf(p.id) });
		},
	],
	[
		"ds.moved",
		(envelope) => {
			const p = decodePayload(Payloads["ds.moved"], envelope);

			return Happened.Moved({
				id: demoIdOf(p.id),
				path: [...p.path],
				cost: p.cost,
				speed: p.speed,
				main: p.main ?? false,
			});
		},
	],
	[
		"ds.power-rolled",
		(envelope) => {
			const p = decodePayload(Payloads["ds.power-rolled"], envelope);

			return Happened.PowerRolled({
				id: demoIdOf(p.id),
				ability: p.ability ?? "",
				dice: [...p.dice],
				bonus: p.bonus,
				total: p.total,
				tier: p.tier,
				cost: p.cost ?? 0,
				targets: (p.targets ?? []).map((target) => ({
					id: demoIdOf(target.id),
					apart: target.apart ?? 0,
				})),
			});
		},
	],
	[
		"ds.damaged",
		(envelope) => {
			const p = decodePayload(Payloads["ds.damaged"], envelope);

			return Happened.Damaged({
				id: demoIdOf(p.id),
				amount: p.dealt,
				source: "",
			});
		},
	],
	[
		"ds.bled",
		(envelope) => {
			const p = decodePayload(Payloads["ds.bled"], envelope);

			return Happened.Bled({
				id: demoIdOf(p.id),
				roll: p.roll,
				level: p.level,
			});
		},
	],
	[
		"ds.force-moved",
		(envelope) => {
			const p = decodePayload(Payloads["ds.force-moved"], envelope);

			if (p.kind !== "push") {
				throw new Error(`the demo only pushes, and this is a ${p.kind}`);
			}

			return Happened.ForceMoved({
				id: demoIdOf(p.id),
				kind: p.kind,
				source: demoIdOf(p.source ?? ""),
				path: [...p.path],
				distance: p.distance,
				stability: p.stability,
				stopped: stoppedOf(p.slam, p.edge),
			});
		},
	],
	[
		"ds.recovered",
		(envelope) => {
			const p = decodePayload(Payloads["ds.recovered"], envelope);

			return Happened.Recovered({ id: demoIdOf(p.id), amount: p.amount });
		},
	],
	[
		"ds.combat-ended",
		(_envelope, before) => Happened.CombatEnded({ winner: winnerOf(before) }),
	],
	[
		"ds.measured",
		(envelope) => {
			const p = decodePayload(Payloads["ds.measured"], envelope);

			return Happened.Measured({
				from: p.from.at,
				to: p.to.at,
				squares: p.distance,
				between: [
					pointLabel(p.from.id, p.from.at),
					pointLabel(p.to.id, p.to.at),
				],
			});
		},
	],
	[
		"core.chat-posted",
		(envelope) => {
			const p = decodePayload(CorePayloads["core.chat-posted"], envelope);

			return Happened.ChatPosted({ text: p.text });
		},
	],
	[
		"core.dice-rolled",
		(envelope) => {
			const p = decodePayload(CorePayloads["core.dice-rolled"], envelope);

			return Happened.DiceRolled({
				notation: p.notation,
				rolls: [...p.rolls],
				modifier: p.modifier,
				total: p.total,
			});
		},
	],
	[
		"core.retracted",
		(envelope, _before, demoSeqOf) => {
			const p = decodePayload(CorePayloads["core.retracted"], envelope);

			return Happened.Retracted({
				seqs: p.seqs.map((seq) => demoSeqOf.get(seq) ?? -1),
				undone: [],
			});
		},
	],
]);

const mirrored: Mirror = (envelope, before, demoSeqOf) => {
	const mirror = MIRRORS.get(envelope.type);

	if (mirror === undefined) {
		throw new Error(`the demo has nothing like ${envelope.type}`);
	}

	return mirror(envelope, before, demoSeqOf);
};

const comparable = (event: Happened): Happened => {
	if (Happened.guards.Damaged(event)) {
		return Happened.Damaged({ ...event, source: "" });
	}

	return Happened.guards.Retracted(event)
		? Happened.Retracted({ ...event, undone: [] })
		: event;
};

const named = (text: string): string => {
	let said = text;

	for (const fighter of FIGHTERS) {
		said = said.replaceAll(realNameOf(fighter), fighter.name);
	}

	return said;
};

const movedWording = (text: string): string =>
	text
		.replace(
			/, \d+ of \d+ this turn with the main action/u,
			", with the main action"
		)
		.replace(/, \d+ of \d+ this turn/u, "");

const recoveredWording = (text: string): string =>
	text.replace(/(?: · \w+)? \(\d+\/\d+ left\)$/u, ".");

const FAR = / \((?<far>[^()]* away); (?<distance>[^();]*)\)$/u;

const rollWording = (text: string): Array<string> => {
	const found = FAR.exec(text)?.groups;
	const far = found?.far ?? "";
	const distance = found?.distance ?? "";

	const head = text
		.replace(FAR, "")
		.replace(
			/^(?<who>.+? uses .+?)(?<on> on .+?)? \((?<cost>\d+) wrath → -?\d+\):/u,
			"$<who> ($<cost> wrath)$<on>:"
		);

	return [
		head,
		...far
			.split("; ")
			.flatMap((away) => (away === "" ? [] : [`${away}, past ${distance}.`])),
	];
};

const WORDING: Readonly<
	Record<Happened["_tag"], (text: string) => Array<string>>
> = {
	MapLoaded: (text) => [text],
	Placed: (text) => [text],
	RoundStarted: (text) => [text.replace(/ (?:d10:|Malice) .*$/u, "")],
	TurnStarted: (text) => [text],
	Moved: (text) => [movedWording(text)],
	PowerRolled: rollWording,
	Damaged: (text) => [
		text
			.replace(
				/ takes (?<amount>\d+) [a-z]+ damage/u,
				" takes $<amount> damage"
			)
			.replace(" · the squad is dead", " · dead"),
	],
	Bled: (text) => [text],
	ForceMoved: (text) => [text],
	Recovered: (text) => [recoveredWording(text)],
	TurnEnded: (text) => [text],
	CombatEnded: (text) => [text],
	ChatPosted: (text) => [text],
	DiceRolled: (text) => [
		text
			.replace(/^rolled /u, "rolls ")
			.replace(/ -(?<modifier>\d+) = /u, " −$<modifier> = "),
	],
	Measured: (text) => [text],
	Retracted: (text) => [
		`↶ ${labelOf(YOU)} ${recoveredWording(movedWording(text))}`,
	],
};

const DEMO_ONLY = / from the wall$/u;

const demoLines = (demo: Demo, entry: Entry): Array<string> =>
	fold(demo.log).feed.flatMap((line) =>
		line.seq === entry.seq ? [line.text.replace(DEMO_ONLY, "")] : []
	);

const realLines = (
	state: RealState,
	envelope: Envelope,
	entry: Entry
): Array<string> =>
	state.feed.flatMap((line) =>
		line.seq === envelope.seq ? WORDING[entry.event._tag](named(line.text)) : []
	);

const FOLLOWS: ReadonlySet<Happened["_tag"]> = new Set<Happened["_tag"]>([
	"Damaged",
	"Bled",
]);

const continues = (entry: Entry, before: Entry | undefined): boolean =>
	FOLLOWS.has(entry.event._tag) ||
	(Happened.guards.TurnStarted(entry.event) &&
		before !== undefined &&
		Happened.guards.RoundStarted(before.event));

const groupsOf = (entries: ReadonlyArray<Entry>): Array<Array<Entry>> => {
	const groups: Array<Array<Entry>> = [];

	for (const [index, entry] of entries.entries()) {
		const open = groups.at(-1);

		if (open !== undefined && continues(entry, entries[index - 1])) {
			open.push(entry);
		} else {
			groups.push([entry]);
		}
	}

	return groups;
};

const starts: (entry: Entry) => never = (entry) => {
	throw new Error(`${entry.event._tag} never starts a command at the table`);
};

const turnOf = (entry: Entry | undefined): string =>
	entry !== undefined && Happened.guards.TurnStarted(entry.event)
		? entry.event.id
		: HERO;

const lineOf = (head: Entry, second: Entry | undefined): string =>
	Happened.match(head.event, {
		MapLoaded: () => starts(head),
		Placed: () => starts(head),
		RoundStarted: () => `/turn ${realIdOf(turnOf(second))}`,
		TurnStarted: ({ id }) => `/turn ${realIdOf(id)}`,
		Moved: ({ id, path, main }) =>
			`/move ${realIdOf(id)} ${nameOfSquare(path.at(-1) ?? fighterOf(id).start)}${main ? " main" : ""}`,
		PowerRolled: ({ id, ability, targets }) =>
			`/pr ${realIdOf(id)} ${ability} on ${targets.map((target) => realIdOf(target.id)).join(" ")}`,
		Damaged: ({ id, amount }) => `/dmg ${realIdOf(id)} ${amount}`,
		Bled: () => starts(head),
		ForceMoved: ({ id, distance }) => `/push ${realIdOf(id)} ${distance}`,
		Recovered: ({ id }) => `/recover ${realIdOf(id)}`,
		TurnEnded: () => "/done",
		CombatEnded: () => "/end",
		ChatPosted: ({ text }) => text,
		DiceRolled: ({ notation }) => `/roll ${notation}`,
		Measured: ({ from, to }) =>
			`/dist ${nameOfSquare(from)} ${nameOfSquare(to)}`,
		Retracted: () => "/undo",
	});

const SIDES = /d(?<sides>\d+)/u;

const diceOf = (event: Happened): Array<Die> => {
	if (Happened.guards.PowerRolled(event)) {
		return event.dice.map((face) => ({ sides: 10, face }));
	}

	if (Happened.guards.Bled(event)) {
		return [{ sides: 6, face: event.roll }];
	}

	if (Happened.guards.DiceRolled(event)) {
		const sides = Number(SIDES.exec(event.notation)?.groups?.sides ?? "0");

		return event.rolls.map((face) => ({ sides, face }));
	}

	return [];
};

const realMovesLeft = (real: RealState): number => {
	const { acting, moved } = real.ds.combat;
	const mover = FIGHTERS.find((fighter) => realIdOf(fighter.id) === acting);

	if (mover === undefined) {
		return 0;
	}

	const own =
		moved !== undefined && moved.id === acting
			? moved
			: { spent: 0, main: false };

	const allowance = own.main ? 2 * mover.speed : mover.speed;

	return Math.max(0, allowance - own.spent);
};

const expectSameFighter = (
	state: TableState,
	real: RealState,
	fighter: Fighter
): void => {
	const body = bodyOf(state, fighter.id);
	const status = statusOf(state, fighter.id);

	const shown = bandOf(real, PLAYER, RULESET)?.combatants.find(
		(combatant) => combatant.id === realIdOf(fighter.id)
	);

	expect(real.ds.map?.tokens[realIdOf(fighter.id)]).toStrictEqual(body?.at);
	expect(shown?.stamina).toBe(body?.stamina);
	expect(shown?.max).toBe(fighter.stamina);
	expect(shown?.health ?? "").toBe(status);
	expect(shown?.conditions).toStrictEqual(
		status === "dying" ? ["bleeding"] : []
	);
};

const mainLeft = (real: RealState): boolean => {
	const acting = bandOf(real, PLAYER, RULESET)?.combatants.find(
		(combatant) => combatant.acting
	);

	return (acting?.turnActions ?? "").includes("main");
};

const expectSameTable = (state: TableState, real: RealState): void => {
	const band = bandOf(real, PLAYER, RULESET);
	const hero = band?.combatants.find((combatant) => combatant.id === HERO);
	const { combat } = real.ds;

	for (const fighter of FIGHTERS) {
		expectSameFighter(state, real, fighter);
	}

	expect(combat.active).toBe(true);
	expect(band?.round).toBe(state.round);
	expect(demoIdOf(combat.acting ?? "")).toBe(state.turn);
	expect(hero?.resource).toBe(`wrath ${state.wrath}`);
	expect(hero?.recoveries?.left).toBe(state.recoveries);
	expect(realMovesLeft(real)).toBe(state.turn === "" ? 0 : movesLeft(state));
	expect(mainLeft(real)).toBe(state.turn !== "" && !state.acted);
};

const SQUARES: ReadonlyArray<Square> = Array.from(
	{ length: COLUMNS * ROWS },
	(_unused, index) => ({ x: index % COLUMNS, y: Math.floor(index / COLUMNS) })
);

const realCosts = (real: RealState, id: string): Array<number> => {
	const board = real.ds.map;
	const who = findWho(real.ds, realIdOf(id));
	const from = board?.tokens[realIdOf(id)];

	if (board === undefined || who === undefined || from === undefined) {
		return [];
	}

	const walk = moverWalk(
		board.terrain,
		moverOf(real.ds, who),
		occupants(real.ds, board, who.id)
	);

	return SQUARES.map(
		(to) => cheapestPath(board.terrain, from, to, walk)?.cost ?? Infinity
	);
};

const expectSameCosts = (state: TableState, real: RealState): void => {
	for (const fighter of FIGHTERS) {
		expect([fighter.id, ...reachFrom(state, fighter.id).cost]).toStrictEqual([
			fighter.id,
			...realCosts(real, fighter.id),
		]);
	}
};

const expectEnded = (state: TableState, real: RealState): void => {
	expect(state.winner).not.toBe("");
	expect(state.turn).toBe("");
	expect(real.ds.combat.active).toBe(false);
};

interface Tables {
	readonly demo: Demo;
	readonly real: RealState;
	readonly demoSeqOf: ReadonlyMap<number, number>;
}

const expectSameEvents = (
	demo: Demo,
	entries: ReadonlyArray<Entry>,
	before: RealState,
	after: Played,
	demoSeqOf: ReadonlyMap<number, number>
): ReadonlyMap<number, number> => {
	const seqs = new Map(demoSeqOf);

	expect(after.envelopes.map((envelope) => envelope.type)).toStrictEqual(
		entries.map((entry) => TYPES[entry.event._tag])
	);

	for (const [index, entry] of entries.entries()) {
		const envelope = after.envelopes[index];

		const told =
			envelope === undefined
				? undefined
				: mirrored(envelope, before, demoSeqOf);

		const said =
			envelope === undefined || WORDED_APART.has(entry.event._tag)
				? demoLines(demo, entry)
				: realLines(after.state, envelope, entry);

		expect(told).toStrictEqual(comparable(entry.event));
		expect(demoLines(demo, entry)).toStrictEqual(said);
		seqs.set(envelope?.seq ?? -1, entry.seq);
	}

	return seqs;
};

const openingOf = (places: Places): Demo => ({
	...DEMO,
	log: entriesOf(
		[],
		OPENING.map((authored) =>
			Happened.guards.Placed(authored.event)
				? {
						...authored,
						event: Happened.Placed({
							id: authored.event.id,
							at: placeOf(places, fighterOf(authored.event.id)),
						}),
					}
				: authored
		)
	),
});

const opened = (places: Places = AT_THE_FORD): Tables => {
	const table = seated(places);
	const demo = openingOf(places);

	const shared = table.envelopes.filter(
		(envelope) => !SET_UP_BY_THE_GM.has(envelope.type)
	);

	const demoSeqOf = new Map<number, number>();

	expect(shared.map((envelope) => envelope.type)).toStrictEqual(
		demo.log.map((entry) =>
			TYPES[entry.event._tag] === KNOWN_DIFFERENCES.combatBegins.demo
				? KNOWN_DIFFERENCES.combatBegins.real
				: TYPES[entry.event._tag]
		)
	);

	for (const [index, entry] of demo.log.entries()) {
		const envelope = shared[index];

		const told =
			envelope === undefined
				? undefined
				: mirrored(envelope, table.state, demoSeqOf);

		const said =
			envelope === undefined ? [] : realLines(table.state, envelope, entry);

		expect(told).toStrictEqual(entry.event);
		expect(demoLines(demo, entry)).toStrictEqual(said);
		demoSeqOf.set(envelope?.seq ?? -1, entry.seq);
	}

	expectSameTable(fold(demo.log).state, table.state);

	return { demo, real: table.state, demoSeqOf };
};

const actorOf = (entry: Entry): string =>
	entry.actor === YOU ? PLAYER : REAL_GM;

const mirroredOnto = (tables: Tables, demo: Demo, line: string): Tables => {
	const entries = demo.log.slice(tables.demo.log.length);
	let { real, demoSeqOf } = tables;

	for (const [index, group] of groupsOf(entries).entries()) {
		const [head, second] = group;

		if (head === undefined) {
			throw new Error("a command with nothing in it");
		}

		const last = group.at(-1) ?? head;
		const own = index === 0 && head.actor === YOU && line.trim() !== "";
		const text = own ? line : lineOf(head, second);
		const dice = group.flatMap((entry) => diceOf(entry.event));
		const after = typed(real, actorOf(head), text, dice);
		const { state } = fold(demo.log.slice(0, last.seq));
		const check = state.winner === "" ? expectSameTable : expectEnded;

		demoSeqOf = expectSameEvents(demo, group, real, after, demoSeqOf);
		real = after.state;
		check(state, real);
	}

	return { demo, real, demoSeqOf };
};

const sentTo = (tables: Tables, line: string): Tables => {
	const demo = sent(tables.demo, line);

	expect(demo.refusal).toBe("");
	expect(demo.log.length).toBeGreaterThan(tables.demo.log.length);

	return mirroredOnto(tables, demo, line);
};

const walked = (tables: Tables): Tables => {
	expectSameCosts(fold(tables.demo.log).state, tables.real);

	return tables;
};

const SEEDS = Array.from({ length: 32 }, (_unused, index) => index + 1);

const DOOMED = Array.from({ length: 6 }, (_unused, index) => index + 1);

const TURNS = 120;

const seededOn = (tables: Tables, seed: number): Tables => ({
	...tables,
	demo: { ...tables.demo, seed },
});

const fought = (seed: number, lineOn: (demo: Demo) => string): Tables => {
	let tables = seededOn(opened(), seed);

	for (
		let turn = 0;
		turn < TURNS && fold(tables.demo.log).state.winner === "";
		turn += 1
	) {
		tables = sentTo(tables, lineOn(tables.demo));
	}

	return tables;
};

const hurtBy = (tables: Tables, id: string, amount: number): Tables =>
	mirroredOnto(
		tables,
		{
			...tables.demo,
			log: entriesOf(tables.demo.log, [
				{ actor: GM, event: Happened.Damaged({ id, amount, source: "" }) },
			]),
		},
		""
	);

const suggested = (demo: Demo): string => suggestionsOf(demo)[0] ?? "/done";

const fightingOnWhileDying = (demo: Demo): string => {
	const { state } = fold(demo.log);

	const foe = FIGHTERS.find(
		(fighter) =>
			fighter.side === "director" && statusOf(state, fighter.id) !== "dead"
	);

	const [open] = reachable(state);

	if (statusOf(state, HERO) !== "dying" || state.acted || foe === undefined) {
		return "/done";
	}

	return state.round % 2 === 0 && open !== undefined
		? `/move ${HERO} ${nameOfSquare(open)} main`
		: `/pr ${HERO} driving on ${foe.id}`;
};

const tagsOf = (tables: Tables): Array<string> =>
	tables.demo.log.map((entry) => entry.event._tag);

const seedRolling = (first: number, second: number): number => {
	const seed = Array.from(
		{ length: 20_000 },
		(_unused, index) => index + 1
	).find((candidate) => {
		const { rolls } = rollDice(candidate, 2, 10);

		return rolls[0] === first && rolls[1] === second;
	});

	if (seed === undefined) {
		throw new Error(`no seed rolls ${first} and ${second}`);
	}

	return seed;
};

const TIER_THREE = seedRolling(8, 8);

const NATURAL = seedRolling(10, 9);

interface Shove {
	readonly places: Places;
	readonly stopped: string;
	readonly stamina: ReadonlyArray<number>;
}

const SHOVES: ReadonlyArray<Shove> = [
	{
		places: new Map([
			["brann", "g3"],
			["bandit-bruiser", "h3"],
			["bandit-slinger", "j3"],
		]),
		stopped: "",
		stamina: [24, 10, 3],
	},
	{
		places: new Map([
			["brann", "g3"],
			["bandit-bruiser", "h3"],
			["bandit-slinger", "i3"],
		]),
		stopped: "bandit-slinger",
		stamina: [24, 9, 2],
	},
	{
		places: new Map([
			["brann", "d3"],
			["bandit-bruiser", "c3"],
		]),
		stopped: "wall",
		stamina: [24, 7, 3],
	},
	{
		places: new Map([
			["brann", "b4"],
			["bandit-bruiser", "a4"],
		]),
		stopped: "edge",
		stamina: [24, 10, 3],
	},
	{
		places: new Map([
			["brann", "m3"],
			["bandit-bruiser", "n4"],
			["bandit-slinger", "a1"],
		]),
		stopped: "wall",
		stamina: [24, 7, 3],
	},
];

const CROWDED: Places = new Map([
	["brann", "d6"],
	["bandit-slinger", "e6"],
	["bandit-bruiser", "f6"],
]);

const A_VISITORS_TURNS: ReadonlyArray<string> = [
	"/move brann d4",
	"/move brann g4 main",
	"/move brann f4 MAIN",
	"/move brann f5",
	"/undo",
	"/dist B s",
	"/dist b4 n7",
	"/dist bruiser Brann",
	"/roll d20",
	"/roll 3d6-2",
	"/say hello table",
	"/done",
	"/recover brann",
	"/pr brann driving blow on b s",
	"/done",
	"/pr brann glare",
	"/done",
	"/move brann a1 main",
	"/undo",
	"/recover brann",
	"/undo",
	"/pr brann acc on bruiser",
	"/done",
];

const BOTH_REFUSE: ReadonlyArray<ReadonlyArray<string>> = [
	["/move brann k4"],
	["/move brann b2"],
	["/move brann h4"],
	["/move brann b4"],
	["/move brann z9"],
	["/move brann g4 quickly"],
	["/pr brann glare on s"],
	["/pr brann driving on"],
	["/pr brann driving on nobody"],
	["/pr brann a on b"],
	["/recover brann"],
	["/recover brann now"],
	["/dist B"],
	["/dist B s b"],
	["/undo"],
	["/undo brann"],
	["/roll 2d"],
	["/move brann g4", "/pr brann driving on b", "/pr brann driving on b"],
	["/move brann g4", "/pr brann driving on b", "/move brann b4 main"],
	["/move brann g4", "/move brann b4 main", "/pr brann driving on b"],
];

const prefixesOf = (word: string): Array<string> =>
	Array.from({ length: word.length }, (_unused, index) =>
		word.slice(0, index + 1)
	);

const NAMES_TYPED: ReadonlyArray<string> = [
	...new Set(
		FIGHTERS.flatMap((fighter) => [
			fighter.mark,
			...prefixesOf(fighter.id),
			...prefixesOf(fighter.name),
			...prefixesOf(fighter.name.toUpperCase()),
			...fighter.name.toLowerCase().split(" ").flatMap(prefixesOf),
		])
	),
	"nobody",
	"x",
];

const ABILITIES_TYPED: ReadonlyArray<string> = [
	...new Set(
		[
			...BRANN.abilities.map((ability) => ability.name),
			"might",
			"agility",
			"reason",
			"intuition",
			"presence",
		].flatMap((name) => [
			...prefixesOf(name.toLowerCase()),
			...name.toLowerCase().split(" ").flatMap(prefixesOf),
		])
	),
	"cudgel",
	"x",
];

const demoPick = (text: string): string =>
	Result.match(whoOf(text), {
		onFailure: (refusal) => (refusal.includes("could be") ? "?" : ""),
		onSuccess: (fighter) => fighter.id,
	});

const realPick = (state: RealState, text: string): string => {
	const who = resolve(state.ds, text);

	if (isRefused(who)) {
		return who.refusal.includes("could be") ? "?" : "";
	}

	return demoIdOf(who.id);
};

const demoAbility = (text: string): string =>
	Result.match(decide(OPENING_LOG, `/pr ${HERO} ${text}`, DEMO.seed), {
		onFailure: () => "",
		onSuccess: ({ events }) =>
			events
				.flatMap(({ event }) =>
					Happened.guards.PowerRolled(event) ? [event.ability] : []
				)
				.join(""),
	});

const realAbility = (state: RealState, text: string): string => {
	const decision = rules.decide(
		state,
		PLAYER,
		commandOf(`/pr ${HERO} ${text}`),
		() => 5,
		STARTED
	);

	if (isRefused(decision)) {
		return "";
	}

	return decision.events
		.flatMap((event) =>
			event.type === "ds.power-rolled"
				? [
						decodePayload(Payloads["ds.power-rolled"], {
							actor: PLAYER,
							seq: 0,
							timestamp: "",
							...event,
						}).ability ?? "",
					]
				: []
		)
		.join("");
};

describe("the demo's Draw Steel against the real rules", () => {
	test("opens on the table the real commands set up", () => {
		const { real } = opened();

		expect(real.ds.heroes.map((hero) => hero.id)).toStrictEqual([HERO]);
		expect(real.ds.creatures.map((creature) => creature.id)).toStrictEqual(
			FIGHTERS.flatMap((fighter) =>
				fighter.side === "director" ? [realIdOf(fighter.id)] : []
			)
		);
	});

	test("plays the scripted autoplay to the same table, event for event", () => {
		let tables = opened();

		for (const beat of AUTOPLAY_SCRIPT) {
			if (beat.kind === "gm") {
				tables = mirroredOnto(tables, gmSaid(tables.demo, beat.text), "");
			}

			if (beat.kind === "send") {
				tables = sentTo(tables, beat.line);
			}
		}

		const { state } = fold(tables.demo.log);

		expect(state.round).toBe(3);
		expect(bodyOf(state, "bandit-slinger")?.stamina).toBe(0);
		expect(statusOf(state, "bandit-slinger")).toBe("dead");
	});

	test("plays out the fights its own suggestions lead to, under many seeds", () => {
		const winners = SEEDS.map(
			(seed) => fold(fought(seed, suggested).demo.log).state.winner
		);

		expect(winners).not.toContain("");
	}, 30_000);

	test("bleeds a dying hero who fights on, to the same death", () => {
		const fights = DOOMED.map((seed) => fought(seed, fightingOnWhileDying));

		const bledAfter = fights.flatMap((tables) =>
			tables.demo.log.flatMap((entry, index) =>
				Happened.guards.Bled(entry.event)
					? [tables.demo.log[index - 1]?.event._tag ?? ""]
					: []
			)
		);

		expect(bledAfter).toContain("Moved");
		expect(bledAfter).toContain("Damaged");
		expect(
			fights.map((tables) => fold(tables.demo.log).state.winner)
		).toContain("director");
	}, 30_000);

	test("shoves a struck foe into whatever the real push hits", () => {
		for (const shove of SHOVES) {
			const tables = walked(
				sentTo(
					seededOn(walked(opened(shove.places)), TIER_THREE),
					"/pr brann driving on b"
				)
			);

			const { state } = fold(tables.demo.log);

			expect(
				tables.demo.log.flatMap((entry) =>
					Happened.guards.ForceMoved(entry.event) ? [entry.event.stopped] : []
				)
			).toStrictEqual([shove.stopped]);
			expect(
				FIGHTERS.map((fighter) => bodyOf(state, fighter.id)?.stamina)
			).toStrictEqual([...shove.stamina]);
		}
	});

	test("gives a natural 19 its extra main action", () => {
		const close = sentTo(opened(), "/move brann g4");
		const once = sentTo(seededOn(close, NATURAL), "/pr brann driving on b");
		const twice = sentTo(seededOn(once, TIER_THREE), "/pr brann driving on b");

		expect(fold(once.demo.log).state.acted).toBe(false);
		expect(fold(twice.demo.log).state.acted).toBe(true);
		expect(
			fold(once.demo.log).feed.findLast((line) => line.kind === "roll")?.text
		).toContain(", natural 19, extra main action · tier 3");
	});

	test("never calls a hurt minion winded", () => {
		const { state } = fold(hurtBy(opened(), "bandit-slinger", 2).demo.log);

		expect(bodyOf(state, "bandit-slinger")?.stamina).toBe(1);
		expect(statusOf(state, "bandit-slinger")).toBe("");
	});

	test("caps a Recovery at the Stamina lost", () => {
		const tables = sentTo(hurtBy(opened(), HERO, 3), "/recover brann");
		const { state } = fold(tables.demo.log);

		expect(bodyOf(state, HERO)?.stamina).toBe(BRANN.stamina);
		expect(state.recoveries).toBe(RECOVERIES - 1);
	});

	test("prices a crowded, rough square the way the real table does", () => {
		const tables = walked(sentTo(walked(opened(CROWDED)), "/move brann f5"));

		expect(
			reachFrom(fold(opened(CROWDED).demo.log).state, HERO).cost
		).toContain(2);
		expect(bodyOf(fold(tables.demo.log).state, HERO)?.at).toStrictEqual({
			x: 5,
			y: 4,
		});
	});

	test("reads a visitor's own lines the way the real table does", () => {
		let tables = opened();

		for (const line of A_VISITORS_TURNS) {
			tables = walked(sentTo(tables, line));
		}

		expect(fold(tables.demo.log).state.round).toBeGreaterThan(3);
		expect(tagsOf(tables)).toContain("Retracted");
		expect(tagsOf(tables)).toContain("Recovered");
		expect(tagsOf(tables)).toContain("Measured");
	});

	test("refuses what the real table refuses", () => {
		for (const lines of BOTH_REFUSE) {
			let tables = opened();

			for (const line of lines.slice(0, -1)) {
				tables = sentTo(tables, line);
			}

			const last = lines.at(-1) ?? "";
			const parsed = parseInputLine(last, "chat", RULESET);

			const refusal =
				parsed.kind === "command"
					? refusalOf(tables.real, PLAYER, parsed.command, [])
					: JSON.stringify(parsed);

			expect([last, sent(tables.demo, last).refusal]).not.toStrictEqual([
				last,
				"",
			]);
			expect([last, refusal]).not.toStrictEqual([last, ""]);
		}
	});

	test("names creatures and abilities the way the real table does", () => {
		const { real } = opened();

		expect(NAMES_TYPED.map((text) => [text, demoPick(text)])).toStrictEqual(
			NAMES_TYPED.map((text) => [text, realPick(real, text)])
		);
		expect(
			ABILITIES_TYPED.map((text) => [text, demoAbility(text)])
		).toStrictEqual(
			ABILITIES_TYPED.map((text) => [text, realAbility(real, text)])
		);
	});
});
