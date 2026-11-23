import { ifDefined, listIf, listIfDefined, when } from "../../present.ts";
import { cleanText, lengthOf, quote } from "../../text.ts";
import { checkGrid, formatSquare, NOT_GENERATED } from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import { forcedLine, towardFootprint } from "../board/movement.ts";
import { GM } from "../core/module.ts";
import { ID } from "../drawSteel/schema.ts";
import { pick, plural } from "../drawSteel/state.ts";
import { isRefused } from "../engine.ts";
import type { Decision, Dice, NewEvent, Refused } from "../engine.ts";
import {
	apartOf,
	cantStand,
	feetBetween,
	flankedBy,
	inReach,
	rangeCheck,
	routeTo,
	SQUARE_FEET,
} from "./board.ts";
import type { Route } from "./board.ts";
import {
	actionsFor,
	attackPenalties,
	defencePenalties,
	isBroken,
	nextAfter,
	offGuard,
	shieldBonus,
	skillPenalties,
	sortOrder,
	spellPenalties,
} from "./combat.ts";
import type { Cover, PfCommand, PfOf } from "./commands.ts";
import { event } from "./events.ts";
import type { CastResult, Damage, Maneuver, PersistentTick } from "./events.ts";
import {
	basicDamage,
	degree,
	mapPenalty,
	modifiers,
	parseDamage,
	partsText,
	resolveDamage,
	rollDamage,
	rollFlat,
	succeeded,
} from "./math.ts";
import type { Degree, Modifier } from "./math.ts";
import { checkPfSheet } from "./schema.ts";
import {
	hasTrait,
	isRanged,
	meleeReach,
	reachOfStrike,
	sizeRank,
	spaceOf,
	traitDie,
} from "./sheets.ts";
import type { PfSave, PfSheet, PfSpell, PfStrike } from "./sheets.ts";
import {
	canAct,
	COUNTERS,
	CONDITIONS,
	controls,
	creatureOf,
	deadAt,
	findCreature,
	hasCondition,
	hasReacted,
	HERO_POINTS_MAX,
	idFor,
	isDead,
	isOffGuard,
	occupantsOf,
	resolveCreature,
	saveBonus,
	skillBonus,
	spaceOfCreature,
	VALUED,
} from "./state.ts";
import type {
	PfCombat,
	PfCreature,
	PfLastCheck,
	PfLastHit,
	PfState,
	PfTurn,
} from "./state.ts";

export const NAME_MAX = 32;

const NO_MAP = "No map is loaded; the GM loads one with /map.";

const NO_ENCOUNTER = "No encounter is running; the GM starts one with /start.";

const refuse = (refusal: string): Refused => ({ refusal });

const decided = (...events: ReadonlyArray<NewEvent>): Decision => ({
	events: [...events],
});

const actionWord = (n: number): string => plural(n, "action");

const turnOf = (slice: PfState, c: PfCreature): PfTurn | undefined =>
	slice.combat?.turn?.id === c.id ? slice.combat.turn : undefined;

const gate = (
	slice: PfState,
	actor: string,
	c: PfCreature,
	cost: number
): Refused | undefined => {
	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	const { combat } = slice;

	if (combat === undefined || actor === GM) {
		return undefined;
	}

	const { turn } = combat;

	if (turn?.id !== c.id) {
		return refuse(`It isn't ${c.name}'s turn.`);
	}

	return turn.actions < cost
		? refuse(
				`${c.name} has ${actionWord(turn.actions)} left; that takes ${actionWord(cost)}.`
			)
		: undefined;
};

const reactionGate = (
	slice: PfState,
	actor: string,
	c: PfCreature
): Refused | undefined => {
	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	return slice.combat !== undefined && hasReacted(slice, c.id)
		? refuse(`${c.name} has used ↺ this round.`)
		: undefined;
};

const ableTo = (c: PfCreature): Refused | undefined => {
	if (isDead(c)) {
		return refuse(`${c.name} is dead.`);
	}

	return canAct(c) ? undefined : refuse(`${c.name} can't act right now.`);
};

const firstRefusal = (
	...checks: ReadonlyArray<Refused | undefined>
): Refused | undefined => checks.find((c) => c !== undefined);

const hasActed = (turn: PfTurn): boolean =>
	turn.actions < turn.granted || turn.attacks > 0 || turn.struck.length > 0;

const beforeHit = (c: PfCreature, hit: PfLastHit): PfCreature => ({
	...c,
	hp: hit.beforeHp,
	dying: hit.beforeDying,
	dead: c.dead && hit.beforeDying >= deadAt(c),
	conditions: hit.wasUnconscious
		? c.conditions
		: c.conditions.filter((k) => k.name !== "unconscious"),
});

const damageOf = (
	target: PfCreature,
	expression: string,
	total: number,
	rolls: ReadonlyArray<number>,
	damageType: string | undefined,
	critical: boolean
): Damage => {
	const resolved = resolveDamage(total, damageType, target.sheet);

	return {
		expression,
		rolls: [...rolls],
		total,
		...ifDefined(damageType, (value) => ({ damageType: value })),
		applied: resolved.applied,
		critical,
	};
};

export const strikeDamage = (
	strike: PfStrike,
	target: PfCreature,
	critical: boolean,
	dice: Dice
): Damage | undefined => {
	const parsed = parseDamage(strike.damage);

	if (isRefused(parsed)) {
		return undefined;
	}

	const deadly = traitDie(strike.traits, "deadly");
	const fatal = traitDie(strike.traits, "fatal");

	const rolled = rollDamage(parsed, dice, {
		critical,
		...ifDefined(deadly, (value) => ({ deadly: value })),
		...ifDefined(fatal, (value) => ({ fatal: value })),
	});

	return damageOf(
		target,
		rolled.expression,
		rolled.total,
		rolled.rolls,
		strike.damageType,
		critical
	);
};

const COVER_BONUS: Readonly<Record<Cover, number>> = {
	lesser: 1,
	standard: 2,
	greater: 4,
};

const coverOf = (cover: Cover | undefined): ReadonlyArray<Modifier> =>
	listIfDefined(cover, (c) => [
		{ type: "circumstance" as const, value: COVER_BONUS[c], label: "cover" },
	]);

const loadMap = (slice: PfState, command: PfOf<"pf-map">): Decision => {
	if (command.generate !== undefined) {
		return refuse(NOT_GENERATED);
	}

	if (command.id === undefined) {
		return slice.map === undefined
			? refuse("No map is loaded.")
			: decided(event("pf.map-cleared", {}));
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
		event("pf.map-loaded", {
			id: command.id,
			name: grid.name,
			terrain: [...grid.terrain],
			...ifDefined(grid.dressing, (value) => ({ dressing: [...value] })),
		})
	);
};

const sheetFor = (
	sheet: PfSheet | undefined,
	what: string
): PfSheet | Refused => {
	if (sheet === undefined) {
		return refuse(`No sheet for ${what} was loaded.`);
	}

	return checkPfSheet(sheet);
};

const joinPc = (slice: PfState, command: PfOf<"pf-pc">): Decision => {
	const sheet = sheetFor(command.sheet, `'${quote(command.id)}'`);

	if (isRefused(sheet)) {
		return sheet;
	}

	const there = findCreature(slice, sheet.id);

	if (there !== undefined && there.kind !== "pc") {
		return refuse(`'${sheet.id}' is a creature's id already.`);
	}

	return decided(event("pf.pc-joined", { sheet }));
};

const addCreatures = (slice: PfState, command: PfOf<"pf-add">): Decision => {
	const block = sheetFor(command.sheet, `'${quote(command.monster)}'`);

	if (isRefused(block)) {
		return block;
	}

	const base = command.as === undefined ? block.name : cleanText(command.as);

	if (base === "" || lengthOf(base) > NAME_MAX) {
		return refuse(`Keep a creature's name to 1–${NAME_MAX} characters.`);
	}

	const already = slice.creatures.filter((c) => c.block === block.id).length;
	const numbered = command.count > 1 || already > 0;
	const taken: Array<string> = [];

	const creatures = Array.from({ length: command.count }, (_, i) => {
		const n = already + i + 1;
		const known = { creatures: [...slice.creatures] };
		let id = idFor(known, numbered ? `${block.id}-${n}` : block.id);

		for (let k = 2; taken.includes(id); k += 1) {
			id = `${block.id}-${n}-${k}`;
		}

		taken.push(id);

		return { id, name: numbered ? `${base} ${n}` : base };
	});

	return decided(
		event("pf.creatures-added", {
			block,
			...ifDefined(command.adjustment, (value) => ({ adjustment: value })),
			creatures,
		})
	);
};

const play = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-play">
): Decision => {
	if (actor === GM) {
		return refuse("The GM plays every creature already.");
	}

	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (c.kind !== "pc") {
		return refuse(`${c.name} isn't a PC.`);
	}

	if (c.player === actor) {
		return refuse(`You play ${c.name} already.`);
	}

	const holder = c.player;

	const left =
		holder !== undefined &&
		holder.startsWith("guest:") &&
		command.seated !== undefined &&
		!command.seated.includes(holder);

	if (holder !== undefined && !left) {
		return refuse(`Someone else plays ${c.name}.`);
	}

	const own = creatureOf(slice, actor);

	if (own !== undefined) {
		return refuse(`You play ${own.name}; /unplay first.`);
	}

	return decided(event("pf.pc-claimed", { id: c.id, player: actor }));
};

const unplay = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-unplay">
): Decision => {
	if (command.who === undefined) {
		const own = creatureOf(slice, actor);

		if (own === undefined) {
			return refuse(
				actor === GM ? "Usage: /unplay <who>" : "You don't play a PC."
			);
		}

		return decided(event("pf.pc-released", { id: own.id }));
	}

	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (c.player === undefined) {
		return refuse(`Nobody plays ${c.name}.`);
	}

	return actor !== GM && c.player !== actor
		? refuse(`You don't play ${c.name}.`)
		: decided(event("pf.pc-released", { id: c.id }));
};

const initiativeOf = (c: PfCreature, skill: string, dice: Dice): NewEvent => {
	const bonus =
		skillBonus(c, skill) + modifiers(skillPenalties(c, skill)).bonus;

	const natural = dice(20);

	return event("pf.initiative-rolled", {
		id: c.id,
		skill,
		natural,
		bonus,
		total: natural + bonus,
	});
};

const rollInitiative = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-init">,
	dice: Dice
): Decision => {
	if (command.who === undefined) {
		if (actor !== GM) {
			return refuse("Usage: /init <who> [skill]");
		}

		const waiting = slice.creatures.filter(
			(c) => c.initiative === undefined && !isDead(c)
		);

		return waiting.length === 0
			? refuse("Everyone has initiative already.")
			: decided(...waiting.map((c) => initiativeOf(c, "perception", dice)));
	}

	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	if (
		slice.combat !== undefined &&
		actor !== GM &&
		c.initiative !== undefined
	) {
		return refuse(`${c.name} has rolled initiative already.`);
	}

	return decided(initiativeOf(c, command.skill ?? "perception", dice));
};

const turnStarted = (
	slice: PfState,
	id: string,
	round: number,
	dice: Dice
): NewEvent => {
	const c = findCreature(slice, id);
	const counted = c === undefined ? { actions: 0 } : actionsFor(c);

	const recovery =
		c !== undefined && c.dying > 0 && !isDead(c)
			? (() => {
					const natural = dice(20);
					const dc = 10 + c.dying;

					return { natural, dc, degree: degree(natural, dc, natural) };
				})()
			: undefined;

	return event("pf.turn-started", {
		id,
		round,
		actions: counted.actions,
		...ifDefined(counted.stunned, (value) => ({ stunned: value })),
		...ifDefined(recovery, (value) => ({ recovery: value })),
	});
};

const start = (slice: PfState, dice: Dice): Decision => {
	if (slice.combat !== undefined) {
		return refuse("An encounter is running already; /end ends it.");
	}

	const standing = slice.creatures.filter((c) => !isDead(c));

	if (
		!standing.some((c) => c.side === "party") ||
		!standing.some((c) => c.side === "foes")
	) {
		return refuse(
			"An encounter needs someone standing on each side: /pc and /add."
		);
	}

	const rolls = standing
		.filter((c) => c.initiative === undefined)
		.map((c) => initiativeOf(c, "perception", dice));

	const rolled = new Map(
		rolls.map((e) => [
			"id" in e.payload ? String(e.payload.id) : "",
			"total" in e.payload ? Number(e.payload.total) : 0,
		])
	);

	const order = sortOrder(
		standing.map((c) => {
			const total = rolled.get(c.id);

			return total === undefined ? c : { ...c, initiative: total };
		})
	);

	const combat: PfCombat = { round: 1, order, delayed: [], reacted: [] };
	const first = nextAfter(slice, combat, undefined);

	return decided(
		...rolls,
		event("pf.combat-started", { order: [...order] }),
		...listIfDefined(first, (value) => [
			turnStarted(slice, value.id, value.round, dice),
		])
	);
};

const persistentTicks = (
	c: PfCreature,
	dice: Dice
): ReadonlyArray<PersistentTick> =>
	c.persistent.map((p) => {
		const parsed = parseDamage(p.dice);

		const rolled = isRefused(parsed)
			? { rolls: [], total: 0 }
			: rollFlat(parsed, dice);

		const natural = dice(20);

		return {
			damageType: p.damageType,
			dice: p.dice,
			rolls: [...rolled.rolls],
			total: rolled.total,
			applied: resolveDamage(rolled.total, p.damageType, c.sheet).applied,
			natural,
			ended: natural >= 15,
		};
	});

const turnEnded = (c: PfCreature, dice: Dice): NewEvent =>
	event("pf.turn-ended", {
		id: c.id,
		persistent: [...persistentTicks(c, dice)],
	});

const current = (slice: PfState): PfCreature | Refused => {
	const id = slice.combat?.turn?.id;
	const c = id === undefined ? undefined : findCreature(slice, id);

	return c ?? refuse(NO_ENCOUNTER);
};

const done = (slice: PfState, actor: string, dice: Dice): Decision => {
	const { combat } = slice;
	const c = current(slice);

	if (combat === undefined || isRefused(c)) {
		return refuse(NO_ENCOUNTER);
	}

	if (!controls(actor, c)) {
		return refuse(`It's ${c.name}'s turn, not yours to end.`);
	}

	const next = nextAfter(slice, combat, c.id);

	return decided(
		turnEnded(c, dice),
		...listIfDefined(next, (value) => [
			turnStarted(slice, value.id, value.round, dice),
		])
	);
};

const jumpTo = (
	slice: PfState,
	command: PfOf<"pf-turn">,
	dice: Dice
): Decision => {
	const { combat } = slice;

	if (combat === undefined) {
		return refuse(NO_ENCOUNTER);
	}

	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (isDead(c)) {
		return refuse(`${c.name} is dead.`);
	}

	if (combat.turn?.id === c.id) {
		return refuse(`It's ${c.name}'s turn already.`);
	}

	const now =
		combat.turn === undefined ? undefined : findCreature(slice, combat.turn.id);

	return decided(
		...listIfDefined(now, (value) => [turnEnded(value, dice)]),
		turnStarted(slice, c.id, combat.round, dice)
	);
};

const delay = (slice: PfState, actor: string, dice: Dice): Decision => {
	const { combat } = slice;
	const c = current(slice);

	if (combat?.turn === undefined || isRefused(c)) {
		return refuse(NO_ENCOUNTER);
	}

	if (!controls(actor, c)) {
		return refuse(`It's ${c.name}'s turn, not yours to delay.`);
	}

	const refused = ableTo(c);

	if (refused !== undefined) {
		return refused;
	}

	if (!combat.order.includes(c.id)) {
		return refuse(`${c.name} isn't in the initiative order to delay from.`);
	}

	if (hasActed(combat.turn)) {
		return refuse(
			`${c.name} has acted this turn; Delay comes at the start of a turn, before anything else.`
		);
	}

	const next = nextAfter(slice, combat, c.id);

	if (next === undefined || next.id === c.id) {
		return refuse(
			`Nobody else is in the initiative order to go before ${c.name}.`
		);
	}

	return decided(
		event("pf.delayed", { id: c.id }),
		turnStarted(slice, next.id, next.round, dice)
	);
};

const rejoin = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-join">
): Decision => {
	const { combat } = slice;

	if (combat?.turn === undefined) {
		return refuse(NO_ENCOUNTER);
	}

	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	if (!combat.delayed.includes(c.id) || combat.order.includes(c.id)) {
		return refuse(`${c.name} isn't delaying.`);
	}

	if (!combat.order.includes(combat.turn.id)) {
		return refuse(
			`${c.name} can only return after a turn in the initiative order.`
		);
	}

	return decided(event("pf.rejoined", { id: c.id, after: combat.turn.id }));
};

const pickStrike = (c: PfCreature, typed: string): PfStrike | Refused =>
	c.sheet.strikes.length === 0
		? refuse(`${c.name} has no Strikes on its sheet.`)
		: pick(
				c.sheet.strikes,
				(s) => [s.name],
				(s) => s.name,
				typed,
				`${c.name} has no Strike called '${quote(typed)}': ${c.sheet.strikes.map((s) => s.name).join(", ")}.`
			);

interface Roll {
	readonly natural: number;
	readonly bonus: number;
	readonly total: number;
}

const rolled = (dice: Dice, bonus: number): Roll => {
	const natural = dice(20);

	return { natural, bonus, total: natural + bonus };
};

interface Parties {
	readonly a: PfCreature;
	readonly t: PfCreature;
}

const parties = (
	slice: PfState,
	who: string,
	target: string
): Parties | Refused => {
	const a = resolveCreature(slice, who);

	if (isRefused(a)) {
		return a;
	}

	const t = resolveCreature(slice, target);

	if (isRefused(t)) {
		return t;
	}

	if (isDead(t)) {
		return refuse(`${t.name} is dead.`);
	}

	return t.id === a.id ? refuse(`${a.name} can't target itself.`) : { a, t };
};

const attackModifiers = (
	slice: PfState,
	a: PfCreature,
	t: PfCreature,
	weapon: PfStrike,
	command: PfOf<"pf-strike">,
	penalty: number
) => {
	const reaction = command.reaction === true;
	const turn = reaction ? undefined : turnOf(slice, a);
	const agile = hasTrait(weapon.traits, "agile");
	const flurry = a.sheet.flurry === true;
	const map = turn === undefined ? 0 : mapPenalty(turn.attacks, agile, flurry);

	const sweep =
		hasTrait(weapon.traits, "sweep") &&
		turn !== undefined &&
		turn.struck.some((id) => id !== t.id);

	return {
		map,
		attack: modifiers([
			{ type: "untyped", value: map, label: "MAP" },
			{ type: "untyped", value: penalty, label: "range" },
			{ type: "untyped", value: command.modifier ?? 0, label: "situational" },
			...listIf(sweep, () => [
				{ type: "circumstance" as const, value: 1, label: "sweep" },
			]),
			...attackPenalties(a, weapon),
		]),
	};
};

const flankedText = (
	slice: PfState,
	a: PfCreature,
	t: PfCreature,
	weapon: PfStrike
): ReadonlyArray<Modifier> => {
	if (isRanged(weapon) || isOffGuard(t)) {
		return [];
	}

	const flanker = flankedBy(slice, a, t, reachOfStrike(weapon));

	return listIfDefined(flanker, (f) => [
		{
			type: "circumstance" as const,
			value: -2,
			label: `off-guard (flanked with ${f.name})`,
		},
	]);
};

const strike = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-strike">,
	dice: Dice
): Decision => {
	const both = parties(slice, command.who, command.target);

	if (isRefused(both)) {
		return both;
	}

	const { a, t } = both;
	const weapon = pickStrike(a, command.weapon);

	if (isRefused(weapon)) {
		return weapon;
	}

	const reaction = command.reaction === true;

	const refused = firstRefusal(
		reaction ? reactionGate(slice, actor, a) : gate(slice, actor, a, 1),
		ableTo(a)
	);

	if (refused !== undefined) {
		return refused;
	}

	const range = rangeCheck(a, t, weapon);

	if (range.refusal !== undefined) {
		return refuse(range.refusal);
	}

	const { map, attack } = attackModifiers(
		slice,
		a,
		t,
		weapon,
		command,
		range.penalty
	);

	const defence = modifiers([
		...defencePenalties(t, "ac"),
		...offGuard(t),
		...flankedText(slice, a, t, weapon),
		...coverOf(command.cover),
		...shieldBonus(t),
	]);

	const ac = t.sheet.ac + defence.bonus;
	const roll = rolled(dice, weapon.bonus + attack.bonus);
	const result = degree(roll.total, ac, roll.natural);

	const damage = succeeded(result)
		? strikeDamage(weapon, t, result === "crit-success", dice)
		: undefined;

	const notes = [attack.parts, defence.parts].flatMap((parts) =>
		parts.length > 0 ? [partsText(parts)] : []
	);

	return decided(
		event("pf.struck", {
			id: a.id,
			target: t.id,
			weapon: weapon.name,
			...roll,
			ac,
			degree: result,
			map,
			reaction,
			notes,
			...ifDefined(damage, (value) => ({ damage: value })),
		})
	);
};

type MoveCommand =
	| PfOf<"pf-stride">
	| PfOf<"pf-step">
	| PfOf<"pf-crawl">
	| PfOf<"pf-move">;

const KIND_OF = {
	"pf-stride": "stride",
	"pf-step": "step",
	"pf-crawl": "crawl",
	"pf-move": "move",
} as const;

const HELD_FAST = ["immobilized", "grabbed", "restrained"] as const;

type MoveKind = (typeof KIND_OF)[keyof typeof KIND_OF];

const freeMoveRefusal = (
	slice: PfState,
	actor: string,
	c: PfCreature
): Refused | undefined => {
	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	return slice.combat !== undefined && actor !== GM
		? refuse("In an encounter, /stride, /step or /crawl.")
		: undefined;
};

const footingRefusal = (
	c: PfCreature,
	kind: MoveKind,
	actor: string
): Refused | undefined => {
	const held = HELD_FAST.find((name) => hasCondition(c, name));

	if (held !== undefined && !(kind === "move" && actor === GM)) {
		return refuse(`${c.name} is ${held} and can't move.`);
	}

	const prone = hasCondition(c, "prone");

	if (prone && (kind === "stride" || kind === "step")) {
		return refuse(`${c.name} is prone: /stand, or /crawl.`);
	}

	return !prone && kind === "crawl"
		? refuse(`${c.name} isn't prone; /step instead.`)
		: undefined;
};

const routeRefusal = (
	c: PfCreature,
	kind: MoveKind,
	named: string,
	route: Route | undefined
): Refused | undefined => {
	const careful = kind === "step" || kind === "crawl";

	if (route === undefined) {
		return refuse(
			careful
				? `${c.name} can't ${kind} to ${named}: it isn't 5 ft of plain ground away.`
				: `${c.name} can't get to ${named}.`
		);
	}

	if (careful && route.feet > SQUARE_FEET) {
		return refuse(
			`${named} is ${route.feet} ft away; a ${kind === "step" ? "Step" : "Crawl"} goes 5 ft.`
		);
	}

	return kind === "stride" && route.feet > c.sheet.speed
		? refuse(
				`${named} is ${route.feet} ft away; ${c.name}'s Speed is ${c.sheet.speed} ft.`
			)
		: undefined;
};

const moveBy = (
	slice: PfState,
	actor: string,
	command: MoveCommand
): Decision => {
	const kind = KIND_OF[command.type];

	if (slice.map === undefined) {
		return refuse(NO_MAP);
	}

	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	const { at } = c;

	if (at === undefined) {
		return refuse(`${c.name} isn't on the map; /place them first.`);
	}

	const named = formatSquare(command.to);
	const why = cantStand(slice, c, command.to);

	const refused = firstRefusal(
		kind === "move"
			? freeMoveRefusal(slice, actor, c)
			: firstRefusal(gate(slice, actor, c, 1), ableTo(c)),
		footingRefusal(c, kind, actor),
		at.x === command.to.x && at.y === command.to.y
			? refuse(`${c.name} is on ${named} already.`)
			: undefined,
		why === undefined ? undefined : refuse(why)
	);

	if (refused !== undefined) {
		return refused;
	}

	const parity = turnOf(slice, c)?.diagonalParity ?? 0;
	const careful = kind === "step" || kind === "crawl";
	const route = routeTo(slice, c, command.to, parity, careful);
	const unrouted = routeRefusal(c, kind, named, route);

	if (unrouted !== undefined || route === undefined) {
		return unrouted ?? refuse(`${c.name} can't get to ${named}.`);
	}

	return decided(
		event("pf.moved", {
			id: c.id,
			to: command.to,
			feet: route.feet,
			kind,
			parity: route.parity,
		})
	);
};

const place = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-place">
): Decision => {
	if (slice.map === undefined) {
		return refuse(NO_MAP);
	}

	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (!controls(actor, c)) {
		return refuse("You can only place your own PC.");
	}

	if (actor !== GM && slice.combat !== undefined && c.at !== undefined) {
		return refuse(`${c.name} is on the map already; /stride instead.`);
	}

	const why = cantStand(slice, c, command.to);

	return why === undefined
		? decided(event("pf.placed", { id: c.id, at: command.to }))
		: refuse(why);
};

const measure = (slice: PfState, command: PfOf<"pf-dist">): Decision => {
	const a = resolveCreature(slice, command.who);

	if (isRefused(a)) {
		return a;
	}

	const b = resolveCreature(slice, command.target);

	if (isRefused(b)) {
		return b;
	}

	const feet = feetBetween(a, b);

	return feet === undefined
		? refuse("Both need to be on the map.")
		: decided(event("pf.measured", { id: a.id, target: b.id, feet }));
};

const simpleAction = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-stand"> | PfOf<"pf-drop"> | PfOf<"pf-shield">
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	const refused = firstRefusal(gate(slice, actor, c, 1), ableTo(c));

	if (refused !== undefined) {
		return refused;
	}

	const prone = hasCondition(c, "prone");

	if (command.type === "pf-stand") {
		return prone
			? decided(event("pf.stood", { id: c.id }))
			: refuse(`${c.name} isn't prone.`);
	}

	if (command.type === "pf-drop") {
		return prone
			? refuse(`${c.name} is prone already.`)
			: decided(event("pf.dropped-prone", { id: c.id }));
	}

	if (c.sheet.shield === undefined) {
		return refuse(`${c.name} has no shield.`);
	}

	if (isBroken(c)) {
		return refuse(`${c.name}'s shield is broken.`);
	}

	return c.shield?.raised === true
		? refuse(`${c.name}'s shield is raised already.`)
		: decided(event("pf.shield-raised", { id: c.id }));
};

const block = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-block">
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	const hit = c.lastHit;

	const refused = firstRefusal(
		reactionGate(slice, actor, c),
		hit === undefined ? undefined : ableTo(beforeHit(c, hit))
	);

	if (refused !== undefined) {
		return refused;
	}

	const stats = c.sheet.shield;

	if (stats === undefined || c.shield?.raised !== true) {
		return refuse(`${c.name} has no shield raised: /shield first.`);
	}

	if (isBroken(c)) {
		return refuse(`${c.name}'s shield is broken.`);
	}

	if (hit === undefined) {
		return refuse(`${c.name} hasn't taken a hit to block.`);
	}

	if (hit.blocked) {
		return refuse(`${c.name} has blocked that hit already.`);
	}

	const damage = command.damage ?? hit.dealt;

	if (damage < 1) {
		return refuse("Block damage of 1 or more.");
	}

	if (damage > hit.dealt) {
		return refuse(
			`${c.name} took ${hit.dealt} from that hit; block up to ${hit.dealt}.`
		);
	}

	const prevented = Math.min(stats.hardness, damage);

	return decided(
		event("pf.shield-blocked", {
			id: c.id,
			damage,
			prevented,
			shieldTaken: damage - prevented,
		})
	);
};

interface ManeuverRule {
	readonly skill: string;
	readonly save: PfSave;
	readonly attack: boolean;
	readonly sized: boolean;
}

const MANEUVER_RULES: Readonly<Record<Maneuver, ManeuverRule>> = {
	grapple: { skill: "athletics", save: "fort", attack: true, sized: true },
	trip: { skill: "athletics", save: "ref", attack: true, sized: true },
	shove: { skill: "athletics", save: "fort", attack: true, sized: true },
	disarm: { skill: "athletics", save: "ref", attack: true, sized: false },
	demoralize: {
		skill: "intimidation",
		save: "will",
		attack: false,
		sized: false,
	},
};

const MANEUVER_OF = {
	"pf-grapple": "grapple",
	"pf-trip": "trip",
	"pf-shove": "shove",
	"pf-disarm": "disarm",
	"pf-demoralize": "demoralize",
} as const;

type ManeuverCommand =
	| PfOf<"pf-grapple">
	| PfOf<"pf-trip">
	| PfOf<"pf-shove">
	| PfOf<"pf-disarm">
	| PfOf<"pf-demoralize">;

const DEMORALIZE_FEET = 30;

const shoved = (
	slice: PfState,
	a: PfCreature,
	t: PfCreature,
	result: Degree
): Square | undefined => {
	const terrain = slice.map?.terrain;

	if (terrain === undefined || a.at === undefined || t.at === undefined) {
		return undefined;
	}

	const af = spaceOfCreature(a).footprint;
	const tf = spaceOfCreature(t).footprint;
	const step = towardFootprint(a.at, af, t.at, tf);

	const forced = forcedLine(
		terrain,
		t.at,
		step,
		result === "crit-success" ? 2 : 1,
		occupantsOf(slice, t.id),
		{ at: a.at, away: true, footprint: af },
		tf
	);

	return forced.path.at(-1);
};

const tripDamage = (t: PfCreature, dice: Dice): Damage | undefined => {
	const parsed = parseDamage("1d6");

	if (isRefused(parsed)) {
		return undefined;
	}

	const r = rollFlat(parsed, dice);

	return damageOf(t, r.expression, r.total, r.rolls, "bludgeoning", false);
};

const maneuverBy = (
	slice: PfState,
	actor: string,
	command: ManeuverCommand,
	dice: Dice
): Decision => {
	const maneuver = MANEUVER_OF[command.type];
	const rule = MANEUVER_RULES[maneuver];
	const a = resolveCreature(slice, command.who);

	if (isRefused(a)) {
		return a;
	}

	const t = resolveCreature(slice, command.target);

	if (isRefused(t)) {
		return t;
	}

	const refused = firstRefusal(
		gate(slice, actor, a, 1),
		ableTo(a),
		isDead(t) ? refuse(`${t.name} is dead.`) : undefined,
		t.id === a.id ? refuse(`${a.name} can't ${maneuver} itself.`) : undefined,
		rule.sized && sizeRank(t.sheet.size) > sizeRank(a.sheet.size) + 1
			? refuse(`${t.name} is too big for ${a.name} to ${maneuver}.`)
			: undefined
	);

	if (refused !== undefined) {
		return refused;
	}

	const apart = apartOf(a, t);
	const reach = rule.attack ? meleeReach(a.sheet) : DEMORALIZE_FEET;

	if (apart !== undefined && !inReach(apart, reach)) {
		return refuse(
			`${t.name} is ${feetBetween(a, t) ?? 0} ft away; ${a.name} reaches ${reach} ft.`
		);
	}

	const turn = turnOf(slice, a);
	const map = rule.attack ? mapPenalty(turn?.attacks ?? 0, false, false) : 0;

	const bonus =
		skillBonus(a, rule.skill) +
		modifiers([
			{ type: "untyped", value: map, label: "MAP" },
			{ type: "untyped", value: command.modifier ?? 0, label: "situational" },
			...skillPenalties(a, rule.skill),
		]).bonus;

	const dc =
		10 +
		saveBonus(t, rule.save) +
		modifiers(defencePenalties(t, rule.save)).bonus;

	const roll = rolled(dice, bonus);
	const result = degree(roll.total, dc, roll.natural);

	const tripped =
		maneuver === "trip" && result === "crit-success"
			? tripDamage(t, dice)
			: undefined;

	const to =
		maneuver === "shove" && succeeded(result)
			? shoved(slice, a, t, result)
			: undefined;

	return decided(
		event("pf.maneuvered", {
			id: a.id,
			target: t.id,
			maneuver,
			skill: rule.skill,
			natural: roll.natural,
			bonus: roll.bonus,
			total: roll.total,
			dc,
			degree: result,
			map,
			...ifDefined(tripped, (value) => ({ damage: value })),
			...ifDefined(to, (value) => ({ to: value })),
		})
	);
};

const SKILL_WORD = /^[a-z][a-z-]*$/u;

const skillCheck = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-check">,
	dice: Dice
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	if (!SKILL_WORD.test(command.skill)) {
		return refuse(`'${quote(command.skill)}' isn't a skill.`);
	}

	const bonus =
		skillBonus(c, command.skill) +
		modifiers([
			{ type: "untyped", value: command.modifier ?? 0, label: "situational" },
			...skillPenalties(c, command.skill),
		]).bonus;

	const roll = rolled(dice, bonus);

	return decided(
		event("pf.checked", {
			id: c.id,
			skill: command.skill,
			...roll,
			...ifDefined(command.dc, (dc) => ({
				dc,
				degree: degree(roll.total, dc, roll.natural),
			})),
		})
	);
};

const basicRoll = (
	expression: string,
	dice: Dice
):
	| { readonly rolls: ReadonlyArray<number>; readonly total: number }
	| Refused => {
	const amount = /^\d+$/u.test(expression) ? Number(expression) : undefined;

	if (amount !== undefined) {
		return { rolls: [], total: amount };
	}

	const parsed = parseDamage(expression);

	return isRefused(parsed) ? parsed : rollFlat(parsed, dice);
};

const savingThrow = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-save">,
	dice: Dice
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	const bonus =
		saveBonus(c, command.save) +
		modifiers(defencePenalties(c, command.save)).bonus;

	const roll = rolled(dice, bonus);
	const result = degree(roll.total, command.dc, roll.natural);
	const { basic } = command;
	const base = basic === undefined ? undefined : basicRoll(basic, dice);

	if (base !== undefined && isRefused(base)) {
		return base;
	}

	const damage =
		basic === undefined || base === undefined
			? undefined
			: damageOf(
					c,
					`${basic} (basic, ${result})`,
					basicDamage(result, base.total),
					base.rolls,
					command.damageType,
					result === "crit-failure"
				);

	return decided(
		event("pf.saved", {
			id: c.id,
			save: command.save,
			...roll,
			dc: command.dc,
			degree: result,
			...ifDefined(damage, (value) => ({ damage: value })),
		})
	);
};

const flatCheck = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-flat">,
	dice: Dice
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	const natural = dice(20);

	return decided(
		event("pf.flat-checked", {
			id: c.id,
			natural,
			dc: command.dc,
			success: natural >= command.dc,
		})
	);
};

const pickSpell = (c: PfCreature, typed: string): PfSpell | Refused => {
	const list = c.sheet.spells?.list ?? [];

	return list.length === 0
		? refuse(`${c.name} has no spells on its sheet.`)
		: pick(
				list,
				(s) => [s.name],
				(s) => s.name,
				typed,
				`${c.name} has no spell called '${quote(typed)}'.`
			);
};

const slotsLeft = (c: PfCreature, rank: number): number | undefined => {
	const slots = c.sheet.spells?.slots;

	if (slots === undefined || rank === 0) {
		return undefined;
	}

	const count = slots.find((s) => s.rank === rank)?.count ?? 0;
	const used = c.slotsUsed.find((s) => s.rank === rank)?.used ?? 0;

	return count - used;
};

const castOn = (
	slice: PfState,
	c: PfCreature,
	spell: PfSpell,
	targets: ReadonlyArray<PfCreature>,
	map: number,
	dice: Dice
): ReadonlyArray<CastResult> => {
	const { spells } = c.sheet;
	const expression = spell.heal ?? spell.damage;

	const parsed = expression === undefined ? undefined : parseDamage(expression);

	const shared =
		parsed === undefined || isRefused(parsed) || spell.attack === true
			? undefined
			: rollFlat(parsed, dice);

	return targets.map((t): CastResult => {
		if (spell.heal !== undefined) {
			return { target: t.id, healed: shared?.total ?? 0 };
		}

		if (spell.attack === true) {
			const bonus =
				(spells?.attack ?? 0) +
				modifiers([
					{ type: "untyped", value: map, label: "MAP" },
					...spellPenalties(c),
				]).bonus;

			const ac =
				t.sheet.ac +
				modifiers([
					...defencePenalties(t, "ac"),
					...offGuard(t),
					...shieldBonus(t),
				]).bonus;

			const roll = rolled(dice, bonus);
			const result = degree(roll.total, ac, roll.natural);

			const hit =
				succeeded(result) && parsed !== undefined && !isRefused(parsed)
					? rollDamage(parsed, dice, { critical: result === "crit-success" })
					: undefined;

			return {
				target: t.id,
				...roll,
				dc: ac,
				degree: result,
				...ifDefined(hit, (value) => ({
					damage: damageOf(
						t,
						value.expression,
						value.total,
						value.rolls,
						spell.damageType,
						result === "crit-success"
					),
				})),
			};
		}

		if (spell.save !== undefined) {
			const dc = (spells?.dc ?? 10) + modifiers(spellPenalties(c)).bonus;

			const bonus =
				saveBonus(t, spell.save) +
				modifiers(defencePenalties(t, spell.save)).bonus;

			const roll = rolled(dice, bonus);
			const result = degree(roll.total, dc, roll.natural);

			return {
				target: t.id,
				...roll,
				dc,
				degree: result,
				...ifDefined(shared, (value) => ({
					damage: damageOf(
						t,
						`${value.expression} (basic, ${result})`,
						basicDamage(result, value.total),
						value.rolls,
						spell.damageType,
						result === "crit-failure"
					),
				})),
			};
		}

		return {
			target: t.id,
			...ifDefined(shared, (value) => ({
				damage: damageOf(
					t,
					value.expression,
					value.total,
					value.rolls,
					spell.damageType,
					false
				),
			})),
		};
	});
};

const spellTargets = (
	slice: PfState,
	c: PfCreature,
	spell: PfSpell,
	command: PfOf<"pf-cast">
): ReadonlyArray<PfCreature> | Refused => {
	const targets: Array<PfCreature> = [];

	for (const typed of command.targets) {
		const t = resolveCreature(slice, typed);

		if (isRefused(t)) {
			return t;
		}

		targets.push(t);
	}

	const needsTarget =
		spell.attack === true ||
		spell.save !== undefined ||
		spell.damage !== undefined;

	if (targets.length === 0 && needsTarget) {
		return refuse(
			`Name ${spell.name}'s targets: /cast ${c.id} ${command.spell} on <targets>.`
		);
	}

	const aimed =
		targets.length === 0 && spell.heal !== undefined ? [c] : targets;

	const dead = aimed.find((t) => isDead(t));

	return dead === undefined ? aimed : refuse(`${dead.name} is dead.`);
};

const castSpell = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-cast">,
	dice: Dice
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	const spell = pickSpell(c, command.spell);

	if (isRefused(spell)) {
		return spell;
	}

	const rank = command.rank ?? spell.rank;
	const actions = spell.actions ?? 2;

	const refused = firstRefusal(
		gate(slice, actor, c, actions),
		ableTo(c),
		rank < spell.rank
			? refuse(`${spell.name} is a rank ${spell.rank} spell.`)
			: undefined
	);

	if (refused !== undefined) {
		return refused;
	}

	const left = slotsLeft(c, rank);

	if (left !== undefined && left < 1) {
		return refuse(`${c.name} has no rank ${rank} spell slots left.`);
	}

	const aimed = spellTargets(slice, c, spell, command);

	if (isRefused(aimed)) {
		return aimed;
	}

	const map =
		spell.attack === true
			? mapPenalty(turnOf(slice, c)?.attacks ?? 0, false, false)
			: 0;

	return decided(
		event("pf.cast", {
			id: c.id,
			spell: spell.name,
			rank,
			actions,
			slot: left !== undefined,
			attack: spell.attack === true,
			map,
			results: [...castOn(slice, c, spell, aimed, map, dice)],
		})
	);
};

const amountOf = (
	typed: string,
	dice: Dice
):
	| {
			readonly expression: string;
			readonly rolls: ReadonlyArray<number>;
			readonly total: number;
	  }
	| Refused => {
	if (/^\d+$/u.test(typed)) {
		return { expression: typed, rolls: [], total: Number(typed) };
	}

	const parsed = parseDamage(typed);

	return isRefused(parsed) ? parsed : rollFlat(parsed, dice);
};

const damage = (
	slice: PfState,
	command: PfOf<"pf-dmg">,
	dice: Dice
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (isDead(c)) {
		return refuse(`${c.name} is dead.`);
	}

	const amount = amountOf(command.amount, dice);

	if (isRefused(amount)) {
		return amount;
	}

	const critical = command.critical === true;
	const total = critical ? amount.total * 2 : amount.total;

	return decided(
		event("pf.damaged", {
			id: c.id,
			damage: damageOf(
				c,
				critical ? `2×(${amount.expression})` : amount.expression,
				total,
				amount.rolls,
				command.damageType,
				critical
			),
		})
	);
};

const heal = (
	slice: PfState,
	command: PfOf<"pf-heal">,
	dice: Dice
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (isDead(c)) {
		return refuse(`${c.name} is dead.`);
	}

	const amount = amountOf(command.amount, dice);

	if (isRefused(amount)) {
		return amount;
	}

	return decided(
		event("pf.healed", {
			id: c.id,
			amount: amount.total,
			...when(amount.rolls.length > 0, () => ({
				expression: amount.expression,
				rolls: [...amount.rolls],
			})),
		})
	);
};

const temp = (slice: PfState, command: PfOf<"pf-temp">): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	return decided(event("pf.temp-set", { id: c.id, temp: command.amount }));
};

const conditionNamed = (name: string) =>
	[...CONDITIONS, ...COUNTERS].find((n) => n === name);

const setPersistent = (c: PfCreature, command: PfOf<"pf-cond">): Decision => {
	const damageType = command.damageType ?? "";

	if (command.remove === true) {
		return c.persistent.some((p) => p.damageType === damageType)
			? decided(event("pf.persistent-removed", { id: c.id, damageType }))
			: refuse(`${c.name} has no persistent ${damageType} damage.`);
	}

	const dice = command.dice ?? "";
	const parsed = /^\d+$/u.test(dice) ? undefined : parseDamage(dice);

	return parsed !== undefined && isRefused(parsed)
		? parsed
		: decided(event("pf.persistent-set", { id: c.id, damageType, dice }));
};

const setCondition = (slice: PfState, command: PfOf<"pf-cond">): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (command.name === "persistent") {
		return setPersistent(c, command);
	}

	const name = conditionNamed(command.name);

	if (name === undefined) {
		return refuse(`'${quote(command.name)}' isn't a condition.`);
	}

	if (command.remove === true) {
		return decided(event("pf.condition-removed", { id: c.id, name }));
	}

	const by =
		command.by === undefined ? undefined : resolveCreature(slice, command.by);

	if (by !== undefined && isRefused(by)) {
		return by;
	}

	const counter = COUNTERS.some((n) => n === name);
	const valued = counter || VALUED.some((n) => n === name);
	const value = valued ? (command.value ?? 1) : undefined;

	if (!valued && command.value !== undefined) {
		return refuse(`${name} has no value.`);
	}

	if (c.kind !== "pc" && counter) {
		return refuse(`Only PCs are ${name}; a creature dies at 0 HP.`);
	}

	return decided(
		event("pf.condition-set", {
			id: c.id,
			name,
			...ifDefined(value, (v) => ({ value: v })),
			...ifDefined(command.expires, (at) => ({
				expires: { at, of: by?.id ?? c.id },
			})),
			...ifDefined(by, (source) => ({ by: source.id })),
		})
	);
};

const heroPoints = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-hp">
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	if (c.kind !== "pc") {
		return refuse("Only PCs have Hero Points.");
	}

	const by = command.by ?? 0;

	if (
		actor !== GM &&
		(command.reset === true || by > 0 || c.player !== actor)
	) {
		return refuse("Only the GM gives Hero Points; you can spend your own.");
	}

	const points =
		command.reset === true
			? 1
			: Math.max(0, Math.min(HERO_POINTS_MAX, c.heroPoints + by));

	if (by < 0 && c.heroPoints + by < 0) {
		return refuse(`${c.name} has ${plural(c.heroPoints, "Hero Point")}.`);
	}

	return decided(event("pf.hero-points-set", { id: c.id, points }));
};

const rerollRefusal = (actor: string, c: PfCreature): Refused | undefined => {
	const last = c.lastCheck;

	if (!controls(actor, c)) {
		return refuse(`You don't play ${c.name}.`);
	}

	if (c.kind !== "pc") {
		return refuse("Only PCs have Hero Points.");
	}

	if (c.heroPoints < 1) {
		return refuse(`${c.name} has no Hero Points.`);
	}

	if (last === undefined) {
		return refuse(`${c.name} has no check to reroll.`);
	}

	if (last.fortune) {
		return refuse(
			"That check was rerolled already: one fortune effect per check."
		);
	}

	return last.kind === "strike" &&
		last.degree !== undefined &&
		succeeded(last.degree)
		? refuse(
				"That Strike hit and dealt its damage; only a miss can be rerolled."
			)
		: undefined;
};

const rerolledDegree = (
	last: PfLastCheck,
	natural: number,
	total: number
): Degree | undefined => {
	const { dc } = last;

	if (dc === undefined) {
		return undefined;
	}

	if (last.kind !== "flat") {
		return degree(total, dc, natural);
	}

	return natural >= dc ? "success" : "failure";
};

const rerolledHit = (
	slice: PfState,
	c: PfCreature,
	last: PfLastCheck,
	result: Degree | undefined,
	dice: Dice
): Damage | undefined => {
	if (last.kind !== "strike" || result === undefined || !succeeded(result)) {
		return undefined;
	}

	const target =
		last.target === undefined ? undefined : findCreature(slice, last.target);

	const weapon = c.sheet.strikes.find((s) => s.name === last.weapon);

	return target === undefined || weapon === undefined
		? undefined
		: strikeDamage(weapon, target, result === "crit-success", dice);
};

const reroll = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-reroll">,
	dice: Dice
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	const refused = rerollRefusal(actor, c);
	const last = c.lastCheck;

	if (refused !== undefined || last === undefined) {
		return refused ?? refuse(`${c.name} has no check to reroll.`);
	}

	const natural = dice(20);
	const total = natural + last.bonus;
	const result = rerolledDegree(last, natural, total);
	const hit = rerolledHit(slice, c, last, result, dice);

	return decided(
		event("pf.rerolled", {
			id: c.id,
			natural,
			total,
			...ifDefined(result, (value) => ({ degree: value })),
			...ifDefined(hit, (value) => ({ damage: value })),
		})
	);
};

const heroicRecovery = (
	slice: PfState,
	actor: string,
	command: PfOf<"pf-recover">
): Decision => {
	const c = resolveCreature(slice, command.who);

	if (isRefused(c)) {
		return c;
	}

	const refused = firstRefusal(
		controls(actor, c) ? undefined : refuse(`You don't play ${c.name}.`),
		c.kind === "pc" ? undefined : refuse("Only PCs have Hero Points."),
		isDead(c) ? refuse(`${c.name} is dead.`) : undefined,
		c.dying < 1 ? refuse(`${c.name} isn't dying.`) : undefined,
		c.heroPoints < 1 ? refuse(`${c.name} has no Hero Points.`) : undefined
	);

	return (
		refused ??
		decided(event("pf.heroic-recovery", { id: c.id, spent: c.heroPoints }))
	);
};

const rest = (slice: PfState): Decision => {
	if (slice.combat !== undefined) {
		return refuse("End the encounter first (/end).");
	}

	const party = slice.creatures.filter((c) => c.kind === "pc" && !isDead(c));

	if (party.length === 0) {
		return refuse("Nobody in the party can rest.");
	}

	return decided(
		event("pf.rested", {
			healed: party.map((c) => ({
				id: c.id,
				hp: Math.min(
					c.sheet.hp - c.hp,
					Math.max(1, c.sheet.attributes.con) * Math.max(1, c.sheet.level)
				),
			})),
		})
	);
};

const endEncounter = (slice: PfState): Decision =>
	slice.combat === undefined
		? refuse(NO_ENCOUNTER)
		: decided(event("pf.combat-ended", {}));

type Handler = (
	slice: PfState,
	actor: string,
	command: PfCommand,
	dice: Dice
) => Decision;

const isType = <T extends PfCommand["type"]>(
	command: PfCommand,
	type: T
): command is PfOf<T> => command.type === type;

const by =
	<T extends PfCommand["type"]>(
		type: T,
		run: (
			slice: PfState,
			actor: string,
			command: PfOf<T>,
			dice: Dice
		) => Decision
	): Handler =>
	(slice, actor, command, dice) =>
		isType(command, type)
			? run(slice, actor, command, dice)
			: refuse(`There is no "${command.type}" command.`);

const HANDLERS = {
	"pf-pc": by("pf-pc", (slice, _actor, command) => joinPc(slice, command)),
	"pf-add": by("pf-add", (slice, _actor, command) =>
		addCreatures(slice, command)
	),
	"pf-play": by("pf-play", play),
	"pf-unplay": by("pf-unplay", unplay),
	"pf-init": by("pf-init", rollInitiative),
	"pf-start": by("pf-start", (slice, _actor, _command, dice) =>
		start(slice, dice)
	),
	"pf-turn": by("pf-turn", (slice, _actor, command, dice) =>
		jumpTo(slice, command, dice)
	),
	"pf-done": by("pf-done", (slice, actor, _command, dice) =>
		done(slice, actor, dice)
	),
	"pf-delay": by("pf-delay", (slice, actor, _command, dice) =>
		delay(slice, actor, dice)
	),
	"pf-join": by("pf-join", rejoin),
	"pf-end": by("pf-end", (slice) => endEncounter(slice)),
	"pf-strike": by("pf-strike", strike),
	"pf-stride": by("pf-stride", moveBy),
	"pf-step": by("pf-step", moveBy),
	"pf-crawl": by("pf-crawl", moveBy),
	"pf-move": by("pf-move", moveBy),
	"pf-place": by("pf-place", place),
	"pf-stand": by("pf-stand", simpleAction),
	"pf-drop": by("pf-drop", simpleAction),
	"pf-shield": by("pf-shield", simpleAction),
	"pf-block": by("pf-block", block),
	"pf-grapple": by("pf-grapple", maneuverBy),
	"pf-trip": by("pf-trip", maneuverBy),
	"pf-shove": by("pf-shove", maneuverBy),
	"pf-disarm": by("pf-disarm", maneuverBy),
	"pf-demoralize": by("pf-demoralize", maneuverBy),
	"pf-check": by("pf-check", skillCheck),
	"pf-save": by("pf-save", savingThrow),
	"pf-flat": by("pf-flat", flatCheck),
	"pf-cast": by("pf-cast", castSpell),
	"pf-dmg": by("pf-dmg", (slice, _actor, command, dice) =>
		damage(slice, command, dice)
	),
	"pf-heal": by("pf-heal", (slice, _actor, command, dice) =>
		heal(slice, command, dice)
	),
	"pf-temp": by("pf-temp", (slice, _actor, command) => temp(slice, command)),
	"pf-cond": by("pf-cond", (slice, _actor, command) =>
		setCondition(slice, command)
	),
	"pf-hp": by("pf-hp", heroPoints),
	"pf-reroll": by("pf-reroll", reroll),
	"pf-recover": by("pf-recover", heroicRecovery),
	"pf-rest": by("pf-rest", (slice) => rest(slice)),
	"pf-map": by("pf-map", (slice, _actor, command) => loadMap(slice, command)),
	"pf-dist": by("pf-dist", (slice, _actor, command) => measure(slice, command)),
} as const satisfies Record<PfCommand["type"], Handler>;

export const decide = (
	slice: PfState,
	actor: string,
	command: PfCommand,
	dice: Dice
): Decision => HANDLERS[command.type](slice, actor, command, dice);

export const spaceFor = spaceOf;
