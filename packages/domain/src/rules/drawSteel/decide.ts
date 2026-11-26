import { Predicate, Schema } from "effect";

import { parseNotation } from "../../dice.ts";
import { ifDefined, listIfDefined, orEmpty, when } from "../../present.ts";
import { charsOf, cleanText, hasControls, orList, quote } from "../../text.ts";
import { apart } from "../board/footprint.ts";
import { formatSquare } from "../board/grid.ts";
import { GM } from "../core/module.ts";
import type { Shared } from "../core/module.ts";
import { isRefused, rollFace } from "../engine.ts";
import type { Decision, Dice, NewEvent, Refused } from "../engine.ts";
import {
	clearedAtEnd,
	forceMove,
	loadMap,
	measure,
	move,
	occupants,
	place,
} from "./board.ts";
import { splitRoll, SQUAD_SIZE } from "./commands.ts";
import type { DsCommand, ForcedCommand, TypedRoll } from "./commands.ts";
import { event, Payloads } from "./events.ts";
import { modifiedDamage, powerRoll } from "./math.ts";
import { checkHeroSheet, checkStatBlock, ID } from "./schema.ts";
import {
	actionKindOf,
	isActionThatBleeds,
	isStrike,
	isTrait,
	tierDamage,
} from "./sheets.ts";
import type {
	Ability,
	ActionKind,
	Characteristic,
	Characteristics,
} from "./sheets.ts";
import {
	abilitiesOf,
	budgetOf,
	capitalized,
	CHARACTERISTICS,
	conditionsOf,
	controls,
	everyone,
	findWho,
	footprintOfWho,
	HELD,
	hasCondition,
	causedBy,
	heroHealth,
	heroOf,
	isDead,
	minionsLeft,
	nextSide,
	pick,
	plural,
	resolve,
	roundOver,
	slotFor,
} from "./state.ts";
import type {
	Budget,
	ConditionName,
	DrawSteelState,
	Hero,
	Who,
} from "./state.ts";

const refuse = (refusal: string): Refused => ({ refusal });

const decided = (...events: Array<NewEvent>): Decision => ({ events });

const NO_COMBAT = "No combat is running; /start one.";

const noCombat = (actor: string) =>
	actor === GM
		? NO_COMBAT
		: "No combat is running; the GM starts one with /start.";

const SAVE = 6;

const OWN = "You can only change your own hero.";

const changeable = (
	slice: DrawSteelState,
	actor: string,
	typed: string
): Who | Refused => {
	const who = resolve(slice, typed);

	if ("refusal" in who) {
		return who;
	}

	if (!controls(actor, who)) {
		return refuse(OWN);
	}

	return who;
};

const changeableHero = (
	slice: DrawSteelState,
	actor: string,
	typed: string,
	what: string
): Hero | Refused => {
	const who = resolve(slice, typed);

	if ("refusal" in who) {
		return who;
	}

	if (who.kind !== "hero") {
		return refuse(`Only heroes have ${what}; ${who.name} is a creature.`);
	}

	if (!controls(actor, who)) {
		return refuse(OWN);
	}

	if (isDead(who)) {
		return refuse(`${who.name} is dead.`);
	}

	return who.hero;
};

const modifiersOf = (slice: DrawSteelState, who: Who) =>
	who.kind === "hero"
		? who.hero.sheet
		: (slice.blocks[who.creature.block] ?? {});

const staminaOf = (who: Who) =>
	who.kind === "hero"
		? {
				stamina: who.hero.stamina,
				max: who.hero.sheet.stamina,
				temp: who.hero.temp,
			}
		: {
				stamina: who.creature.stamina,
				max: who.creature.max,
				temp: who.creature.temp,
			};

const slug = (name: string) =>
	name
		.normalize("NFKD")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "")
		.slice(0, 32);

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const addHero = (
	slice: DrawSteelState,
	command: Extract<DsCommand, { type: "hero" }>
): Decision => {
	if (command.sheet === undefined) {
		return refuse(`No hero sheet for '${quote(command.hero)}' was loaded.`);
	}

	const sheet = checkHeroSheet(command.sheet);

	if ("refusal" in sheet) {
		return sheet;
	}

	if (slice.creatures.some((c) => c.id === sheet.id)) {
		return refuse(`'${sheet.id}' is already a creature's id.`);
	}

	const hero = slice.heroes.find((h) => h.id === sheet.id);

	if (hero !== undefined) {
		const dead = heroHealth({ ...hero, sheet }) === "dead";

		if (dead !== (heroHealth(hero) === "dead")) {
			return refuse(
				dead
					? `That sheet's ${sheet.stamina} Stamina would kill ${sheet.name} at ${hero.stamina}; /heal them first.`
					: `${hero.sheet.name} is dead, and that sheet's ${sheet.stamina} Stamina would raise them; /heal them first.`
			);
		}
	}

	return decided(event("ds.hero-joined", { sheet }));
};

const addCreatures = (
	slice: DrawSteelState,
	command: Extract<DsCommand, { type: "add" }>
): Decision => {
	if (command.sheet === undefined) {
		return refuse(`No stat block for '${quote(command.monster)}' was loaded.`);
	}

	const block = checkStatBlock(command.sheet);

	if ("refusal" in block) {
		return block;
	}

	let baseName = block.name;
	let baseId = block.id;

	if (command.as !== undefined) {
		const name = cleanText(command.as);

		if (name === "" || name.length > 32 || hasControls(name)) {
			return refuse("Pick a plain name of up to 32 characters.");
		}

		baseName = name;
		baseId = ID.test(slug(name)) ? slug(name) : block.id;
	}

	const taken = new Set(everyone(slice).map((w) => w.id));
	const creatures: Array<{ id: string; name: string; squad?: number }> = [];

	const claim = (id: string, name: string, squad?: number) => {
		taken.add(id);
		creatures.push(squad === undefined ? { id, name } : { id, name, squad });
	};

	if (block.organization === "minion") {
		for (let left = command.count; left > 0; left -= SQUAD_SIZE) {
			const letter = charsOf(LETTERS).find((l) => !taken.has(`${baseId}-${l}`));

			if (letter === undefined) {
				return refuse(`There are too many squads of ${baseName} already.`);
			}

			claim(
				`${baseId}-${letter}`,
				`${baseName} ${letter.toUpperCase()}`,
				Math.min(left, SQUAD_SIZE)
			);
		}
	} else {
		const numberedAlready = [...taken].some(
			(id) =>
				id.startsWith(`${baseId}-`) &&
				/^\d+$/u.test(id.slice(baseId.length + 1))
		);

		if (command.count === 1 && !taken.has(baseId) && !numberedAlready) {
			claim(baseId, baseName);
		} else {
			for (
				let n = taken.has(baseId) ? 2 : 1;
				creatures.length < command.count;
				n += 1
			) {
				if (!taken.has(`${baseId}-${n}`)) {
					claim(`${baseId}-${n}`, `${baseName} ${n}`);
				}
			}
		}
	}

	return decided(event("ds.creatures-added", { block, creatures }));
};

const heldBy = (
	hero: Hero,
	actor: string,
	command: Extract<DsCommand, { type: "play" }>,
	shared: Shared
): string | undefined => {
	const holder = hero.player;

	if (holder === undefined) {
		return undefined;
	}

	const away = command.seated !== undefined && !command.seated.includes(holder);

	if (away && holder.startsWith("guest:")) {
		return undefined;
	}

	const { name } = hero.sheet;
	const by = `${name} is played by ${quote(shared.label(holder), 40)}`;

	if (actor === GM) {
		return away
			? `${by}, who isn't here; /unplay ${hero.id} first.`
			: `${by}; /unplay ${hero.id} first.`;
	}

	return away
		? `${by}, who isn't here; ask the GM to /unplay ${hero.id} if they aren't coming back.`
		: `${by}.`;
};

const freeHeroes = (slice: DrawSteelState): Refused => {
	const free = slice.heroes.filter(
		(h) => h.player === undefined && heroHealth(h) !== "dead"
	);

	if (slice.heroes.length === 0) {
		return refuse(
			"Usage: /play <hero>. There's no party yet; the GM brings heroes in with /hero."
		);
	}

	if (free.length === 0) {
		return refuse(
			"Usage: /play <hero>. Every hero is taken; the GM brings more in with /hero."
		);
	}

	return refuse(
		`Usage: /play <hero>. Free to play: ${free.map((h) => h.sheet.name).join(", ")}.`
	);
};

const play = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "play" }>,
	shared: Shared
): Decision => {
	if (command.hero === undefined) {
		return freeHeroes(slice);
	}

	const who = resolve(slice, command.hero);

	if ("refusal" in who) {
		return who.refusal.startsWith("Nobody at the table")
			? refuse(
					`Nobody in the party is called '${quote(command.hero)}'; the GM brings heroes in with /hero.`
				)
			: who;
	}

	if (who.kind !== "hero") {
		return refuse(`${who.name} is a creature; the GM plays it.`);
	}

	const { hero } = who;

	if (actor === GM) {
		if (command.player === undefined) {
			return refuse(
				"The GM plays every creature; /play <hero> <player> gives a hero to a player."
			);
		}

		const label = cleanText(command.player);
		const player = command.playerActor;

		if (player === undefined || player === GM) {
			return refuse(
				`Nobody at the table is called '${quote(command.player)}'.`
			);
		}

		const theirs = heroOf(slice, player);

		if (theirs !== undefined) {
			return refuse(`${quote(label)} already plays ${theirs.sheet.name}.`);
		}

		if (hero.player === player) {
			return refuse(`${quote(label)} already plays ${hero.sheet.name}.`);
		}

		const held = heldBy(hero, actor, command, shared);

		if (held !== undefined) {
			return refuse(held);
		}

		return decided(
			event("ds.hero-claimed", {
				hero: hero.id,
				player,
				label: quote(label, 40),
			})
		);
	}

	if (command.player !== undefined) {
		return refuse("Only the GM can give a hero to someone else.");
	}

	const own = heroOf(slice, actor);

	if (own !== undefined) {
		return refuse(`You already play ${own.sheet.name}.`);
	}

	const held = heldBy(hero, actor, command, shared);

	if (held !== undefined) {
		return refuse(held);
	}

	return decided(event("ds.hero-claimed", { hero: hero.id, player: actor }));
};

const unplay = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "unplay" }>
): Decision => {
	if (actor === GM) {
		if (command.hero === undefined) {
			return refuse("Name the hero to free: /unplay <hero>.");
		}

		const who = resolve(slice, command.hero);

		if ("refusal" in who) {
			return who;
		}

		if (who.kind !== "hero" || who.hero.player === undefined) {
			return refuse(`Nobody plays ${who.name}.`);
		}

		return decided(event("ds.hero-released", { hero: who.id }));
	}

	const own = heroOf(slice, actor);

	if (own === undefined) {
		return refuse("You don't play a hero.");
	}

	if (command.hero !== undefined) {
		const who = resolve(slice, command.hero);

		if ("refusal" in who) {
			return who;
		}

		if (who.id !== own.id) {
			return refuse("You can only stop playing your own hero.");
		}
	}

	return decided(event("ds.hero-released", { hero: own.id }));
};

const start = (slice: DrawSteelState, dice: Dice): Decision => {
	if (slice.combat.active) {
		return refuse("A combat is already running; /end it first.");
	}

	const face = rollFace(dice, 10);
	const living = slice.heroes.filter((h) => heroHealth(h) !== "dead");
	const total = living.reduce((sum, h) => sum + h.victories, 0);
	const victories = living.length === 0 ? 0 : Math.floor(total / living.length);
	const gains = Object.fromEntries(living.map((h) => [h.id, h.victories]));

	return decided(
		event("ds.combat-started", {
			roll: face,
			gains,
			malice: { victories, heroes: living.length, round: 1 },
		})
	);
};

const turnEnd = (slice: DrawSteelState, id: string, dice: Dice): NewEvent => {
	const who = findWho(slice, id);
	const conditions = who === undefined ? [] : conditionsOf(who);

	return event("ds.turn-ended", {
		id,
		ended: conditions.filter((c) => c.duration === "eot").map((c) => c.name),
		saves: conditions
			.filter((c) => c.duration === "save")
			.map((c) => {
				const face = rollFace(dice, 10);

				return { condition: c.name, roll: face, ends: face >= SAVE };
			}),
	});
};

const roundStart = (slice: DrawSteelState): NewEvent => {
	const round = slice.combat.round + 1;
	const heroes = slice.heroes.filter((h) => heroHealth(h) !== "dead").length;

	return event("ds.round-started", { round, heroes, malice: heroes + round });
};

const turnStart = (who: Who, dice: Dice): NewEvent => {
	if (who.kind !== "hero") {
		return event("ds.turn-started", { id: who.id });
	}

	const { perTurn } = who.hero.sheet.resource;

	if (Predicate.isNumber(perTurn) || /^\d+$/u.test(perTurn)) {
		const gain = Number(perTurn);

		return event(
			"ds.turn-started",
			gain === 0 ? { id: who.id } : { id: who.id, gain }
		);
	}

	const notation = parseNotation(perTurn);

	if ("refusal" in notation) {
		return event("ds.turn-started", { id: who.id });
	}

	const rolls = Array.from({ length: notation.count }, () =>
		rollFace(dice, notation.sides)
	);

	const gain = rolls.reduce((a, b) => a + b, 0) + notation.modifier;

	return event("ds.turn-started", { id: who.id, gain, rolls });
};

const turn = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "turn" }>,
	dice: Dice
): Decision => {
	const { combat } = slice;

	if (!combat.active) {
		return refuse(noCombat(actor));
	}

	const typed = command.who ?? heroOf(slice, actor)?.id;

	if (typed === undefined) {
		return refuse(
			actor === GM
				? "Name whose turn it is: /turn <who>."
				: "You don't play a hero; /play one."
		);
	}

	const who = resolve(slice, typed);

	if ("refusal" in who) {
		return who;
	}

	if (isDead(who)) {
		return refuse(`${who.name} is dead.`);
	}

	if (combat.acting === who.id) {
		return refuse(`It's already ${who.name}'s turn.`);
	}

	const over = roundOver(slice);

	if (actor !== GM) {
		if (!controls(actor, who)) {
			return refuse("You can only start your own hero's turn.");
		}

		if (combat.acting !== undefined) {
			return refuse(
				`${findWho(slice, combat.acting)?.name ?? combat.acting} is still acting.`
			);
		}

		if (combat.first === undefined) {
			return refuse("Nobody has said who goes first yet (/first).");
		}

		if (nextSide(slice) !== "heroes") {
			return refuse("It's the Director's turn to pick a creature.");
		}
	}

	if (combat.acted.includes(who.id) && !over) {
		return refuse(`${who.name} has already acted this round.`);
	}

	const events: Array<NewEvent> = [];

	if (combat.acting !== undefined) {
		events.push(turnEnd(slice, combat.acting, dice));
	}

	if (over) {
		events.push(roundStart(slice));
	}

	events.push(turnStart(who, dice));

	return { events };
};

const done = (slice: DrawSteelState, actor: string, dice: Dice): Decision => {
	if (!slice.combat.active) {
		return refuse(noCombat(actor));
	}

	const { acting } = slice.combat;

	if (acting === undefined) {
		return refuse("Nobody is acting.");
	}

	const who = findWho(slice, acting);

	if (actor !== GM && (who === undefined || !controls(actor, who))) {
		return refuse("You can only end your own hero's turn.");
	}

	return decided(turnEnd(slice, acting, dice));
};

const nextRound = (slice: DrawSteelState, dice: Dice): Decision => {
	if (!slice.combat.active) {
		return refuse(NO_COMBAT);
	}

	const events: Array<NewEvent> = [];

	if (slice.combat.acting !== undefined) {
		events.push(turnEnd(slice, slice.combat.acting, dice));
	}

	events.push(roundStart(slice));

	return { events };
};

const characteristicsOf = (
	slice: DrawSteelState,
	who: Who
): Characteristics | undefined =>
	who.kind === "hero"
		? who.hero.sheet.characteristics
		: slice.blocks[who.creature.block]?.characteristics;

const bleeding = (who: Who): boolean =>
	conditionsOf(who).some((c) => c.name === "bleeding") ||
	(who.kind === "hero" && heroHealth(who.hero) === "dying");

const bleed = (
	slice: DrawSteelState,
	who: Who,
	bleeds: boolean,
	dice: Dice
): Array<NewEvent> => {
	if (!bleeds || !bleeding(who) || isDead(who)) {
		return [];
	}

	const level =
		who.kind === "hero"
			? who.hero.sheet.level
			: (slice.blocks[who.creature.block]?.level ?? 0);

	return [event("ds.bled", { id: who.id, roll: rollFace(dice, 6), level })];
};

const MIGHT_OR_AGILITY: ReadonlySet<Characteristic> = new Set<Characteristic>([
	"might",
	"agility",
]);

const moveAndBleed = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "move" }>,
	dice: Dice
): Decision => {
	const moved = move(slice, actor, command);

	if (!("events" in moved)) {
		return moved;
	}

	const spends = moved.events.some(
		(e) =>
			e.type === "ds.moved" &&
			Schema.is(Payloads["ds.moved"])(e.payload) &&
			e.payload.main === true
	);

	if (!spends) {
		return moved;
	}

	const who = resolve(slice, command.who);

	if ("refusal" in who) {
		return moved;
	}

	const { moved: thisTurn } = slice.combat;
	const spentAlready = thisTurn?.id === who.id && thisTurn.main;

	return {
		events: [...moved.events, ...bleed(slice, who, !spentAlready, dice)],
	};
};

const targetsOf = (
	slice: DrawSteelState,
	who: Who,
	typed: ReadonlyArray<string>
): Array<{ readonly target: Who; readonly apart?: number }> | Refused => {
	const targets: Array<{ readonly target: Who; readonly apart?: number }> = [];
	const from = slice.map?.tokens[who.id];

	for (const name of typed) {
		const target = resolve(slice, name);

		if ("refusal" in target) {
			return target;
		}

		if (isDead(target)) {
			return refuse(`${target.name} is dead.`);
		}

		if (targets.some((t) => t.target.id === target.id)) {
			continue;
		}

		const at = slice.map?.tokens[target.id];
		targets.push(
			from === undefined || at === undefined
				? { target }
				: {
						target,
						apart: apart(
							from,
							footprintOfWho(slice, who),
							at,
							footprintOfWho(slice, target)
						),
					}
		);
	}

	return targets;
};

type Choice =
	| {
			readonly kind: "ability";
			readonly name: string;
			readonly ability: Ability;
	  }
	| { readonly kind: "characteristic"; readonly name: Characteristic };

interface RollChoice {
	readonly bonus: number;
	readonly named?:
		| { readonly ability: string }
		| { readonly characteristic: Characteristic };
	readonly chosen?: Ability;
	readonly bleeds: boolean;
}

const abilityRoll = (
	ability: Ability,
	scores: Characteristics | undefined
): RollChoice | { readonly use: Ability } => {
	const uses = ability.characteristics ?? [];

	const bleeds =
		isActionThatBleeds(ability) || uses.some((c) => MIGHT_OR_AGILITY.has(c));

	const named = { ability: ability.name };

	if (ability.bonus !== undefined) {
		return { bonus: ability.bonus, named, chosen: ability, bleeds };
	}

	if (uses.length === 0) {
		return { use: ability };
	}

	return {
		bonus: Math.max(...uses.map((c) => scores?.[c] ?? 0)),
		named,
		chosen: ability,
		bleeds,
	};
};

const chosenRoll = (
	who: Who,
	typed: TypedRoll,
	abilities: ReadonlyArray<Ability>,
	scores: Characteristics | undefined
): RollChoice | { readonly use: Ability } | Refused => {
	const choices: Array<Choice> = [
		...abilities.map((ability): Choice => ({
			kind: "ability",
			name: ability.name,
			ability,
		})),
		...CHARACTERISTICS.map((c): Choice => ({
			kind: "characteristic",
			name: c,
		})),
	];

	const choice = pick(
		choices,
		(c) => [c.name],
		(c) => (c.kind === "ability" ? c.name : capitalized(c.name)),
		typed.roll,
		`${who.name} has no ability or characteristic called '${quote(typed.roll)}'.`
	);

	if (isRefused(choice)) {
		return choice;
	}

	if (choice.kind === "ability") {
		return abilityRoll(choice.ability, scores);
	}

	return {
		bonus: scores?.[choice.name] ?? 0,
		named: { characteristic: choice.name },
		bleeds: MIGHT_OR_AGILITY.has(choice.name),
	};
};

const roller = (
	slice: DrawSteelState,
	actor: string,
	typed: string
): Who | Refused => {
	const who = resolve(slice, typed);

	if (isRefused(who)) {
		return who;
	}

	if (!controls(actor, who)) {
		return refuse("You can only roll for your own hero.");
	}

	return isDead(who) ? refuse(`${who.name} is dead.`) : who;
};

const typedRoll = (
	ability: string | undefined,
	abilities: ReadonlyArray<Ability>
): TypedRoll | Refused | undefined =>
	ability === undefined
		? undefined
		: splitRoll(
				ability,
				abilities.map((a) => a.name)
			);

const costOf = (chosen: Ability | undefined): number | undefined =>
	chosen?.cost !== undefined && chosen.cost > 0 ? chosen.cost : undefined;

const powerRollFor = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "pr" }>,
	dice: Dice
): Decision => {
	const who = roller(slice, actor, command.who);

	if (isRefused(who)) {
		return who;
	}

	const scores = characteristicsOf(slice, who);
	const abilities = abilitiesOf(slice, who);

	const typed = typedRoll(command.ability, abilities);

	if (isRefused(typed)) {
		return typed;
	}

	const aimed = targetsOf(slice, who, [
		...orEmpty(command.targets),
		...orEmpty(typed?.targets),
	]);

	if ("refusal" in aimed) {
		return aimed;
	}

	const choice =
		typed === undefined
			? { bonus: command.bonus ?? 0, bleeds: false }
			: chosenRoll(who, typed, abilities, scores);

	if (isRefused(choice)) {
		return choice;
	}

	if ("use" in choice) {
		return useAbility(slice, actor, who, choice.use, aimed, dice);
	}

	const { bonus, named, chosen, bleeds } = choice;

	const cost = costOf(chosen);
	const short = cost === undefined ? undefined : shortOf(slice, who, cost);

	if (short !== undefined) {
		return refuse(`${short}; ${chosen?.name ?? ""} costs ${cost ?? 0}.`);
	}

	const spends =
		chosen === undefined ? {} : spending(slice, actor, who, chosen);

	if (isRefused(spends)) {
		return spends;
	}

	const modifiers = conditionModifiers(
		who,
		chosen,
		aimed.map((a) => a.target)
	);

	const pair = [rollFace(dice, 10), rollFace(dice, 10)] as const;

	const { edges, banes } = netModifiers(command, typed, modifiers);

	const { total, tier } = powerRoll(pair, bonus, edges, banes);
	const hurt = tierDamage(chosen?.[`tier${tier}`], scores);

	return decided(
		event("ds.power-rolled", {
			id: who.id,
			...named,
			dice: [pair[0], pair[1]],
			bonus,
			edges,
			banes,
			total,
			tier,
			...ifDefined(cost, (value) => ({ cost: value })),
			...when(aimed.length > 0, () => ({
				targets: aimed.map(({ target, apart: away }) => ({
					id: target.id,
					...ifDefined(away, (value) => ({ apart: value })),
				})),
			})),
			...spends,
			...when(modifiers.length > 0, () => ({ conditions: modifiers })),
		}),
		...listIfDefined(hurt, (value) =>
			aimed.flatMap(({ target }) =>
				damageEvents(slice, target, value.amount, value.type)
			)
		),
		...bleed(slice, who, bleeds, dice)
	);
};

interface ConditionModifier {
	readonly id: string;
	readonly condition: ConditionName;
	readonly edges: number;
	readonly banes: number;
}

const netModifiers = (
	command: { readonly edges: number; readonly banes: number },
	typed: TypedRoll | undefined,
	modifiers: ReadonlyArray<ConditionModifier>
) => ({
	edges: Math.min(
		command.edges + (typed?.edges ?? 0) + sumOf(modifiers, "edges"),
		2
	),
	banes: Math.min(
		command.banes + (typed?.banes ?? 0) + sumOf(modifiers, "banes"),
		2
	),
});

const sumOf = (
	modifiers: ReadonlyArray<ConditionModifier>,
	key: "edges" | "banes"
): number => modifiers.reduce((sum, m) => sum + m[key], 0);

const conditionModifiers = (
	who: Who,
	ability: Ability | undefined,
	targets: ReadonlyArray<Who>
): Array<ConditionModifier> => {
	const ids = targets.map((t) => t.id);

	const attacks =
		targets.length > 0 || (ability !== undefined && isStrike(ability));

	const frightened = causedBy(who, "frightened");
	const taunted = causedBy(who, "taunted");
	const grabbed = causedBy(who, "grabbed");
	const [first] = targets;

	const own = (
		condition: ConditionName,
		applies: boolean,
		banes: number
	): Array<ConditionModifier> =>
		applies ? [{ id: who.id, condition, edges: 0, banes }] : [];

	const against = (
		condition: ConditionName,
		applies: (target: Who) => boolean
	): Array<ConditionModifier> =>
		first !== undefined && targets.every(applies)
			? [{ id: first.id, condition, edges: 1, banes: 0 }]
			: [];

	return [
		...own("weakened", hasCondition(who, "weakened"), 1),
		...own("prone", hasCondition(who, "prone") && attacks, 1),
		...own("restrained", hasCondition(who, "restrained"), 1),
		...own(
			"frightened",
			frightened !== undefined && ids.includes(frightened),
			1
		),
		...own(
			"taunted",
			taunted !== undefined && ids.length > 0 && !ids.includes(taunted),
			2
		),
		...own(
			"grabbed",
			grabbed !== undefined && ids.length > 0 && !ids.includes(grabbed),
			1
		),
		...against("restrained", (t) => hasCondition(t, "restrained")),
		...against("frightened", (t) => causedBy(t, "frightened") === who.id),
	];
};

const ACTION_NAMES = {
	main: "main action",
	maneuver: "maneuver",
	move: "move action",
	triggered: "triggered action",
} as const satisfies Record<ActionKind, string>;

const spentText = (who: Who, kind: ActionKind, budget: Budget): string => {
	if (kind === "triggered") {
		return budget.dazed
			? `${who.name} is dazed and can't take triggered actions.`
			: `${who.name} has used their triggered action this round.`;
	}

	return budget.dazed
		? `${who.name} is dazed and has taken their one action this turn.`
		: `${who.name} has no ${ACTION_NAMES[kind]} left this turn.`;
};

const spending = (
	slice: DrawSteelState,
	actor: string,
	who: Who,
	ability: Ability
): { readonly action?: ActionKind } | Refused => {
	const kind = actionKindOf(ability);
	const { combat } = slice;

	if (kind === undefined || !combat.active) {
		return {};
	}

	if (kind !== "triggered" && combat.acting !== who.id) {
		return {};
	}

	const budget = budgetOf(slice, who);
	const slot = slotFor(budget, kind);

	if (slot !== undefined) {
		return { action: slot };
	}

	return actor === GM ? { action: kind } : refuse(spentText(who, kind, budget));
};

const useAbility = (
	slice: DrawSteelState,
	actor: string,
	who: Who,
	ability: Ability,
	aimed: ReadonlyArray<unknown>,
	dice: Dice
): Decision => {
	if (isTrait(ability)) {
		return refuse(
			`${ability.name} is a trait: it's always on, so there's nothing to use.`
		);
	}

	if (aimed.length > 0) {
		return refuse(
			`${ability.name} has no power roll, so it deals no damage to aim.`
		);
	}

	const cost =
		ability.cost !== undefined && ability.cost > 0 ? ability.cost : undefined;

	const short = cost === undefined ? undefined : shortOf(slice, who, cost);

	if (short !== undefined) {
		return refuse(`${short}; ${ability.name} costs ${cost}.`);
	}

	const spends = spending(slice, actor, who, ability);

	if (isRefused(spends)) {
		return spends;
	}

	return decided(
		event("ds.ability-used", {
			id: who.id,
			ability: ability.name,
			...ifDefined(cost, (value) => ({ cost: value })),
			...spends,
		}),
		...bleed(slice, who, isActionThatBleeds(ability), dice)
	);
};

const shortOf = (
	slice: DrawSteelState,
	who: Who,
	cost: number
): string | undefined => {
	if (who.kind === "creature") {
		return slice.malice < cost
			? `The Director has only ${slice.malice} Malice`
			: undefined;
	}

	const { resource, sheet } = who.hero;

	return resource - cost < (sheet.resource.min ?? 0)
		? `${sheet.name} has ${resource} ${sheet.resource.name}`
		: undefined;
};

const damage = (
	slice: DrawSteelState,
	who: Who,
	amount: number,
	type: string | undefined,
	source?: {
		readonly id: string;
		readonly minions?: number;
		readonly apart?: number;
	}
): Decision => {
	if (isDead(who)) {
		return refuse(`${who.name} is dead.`);
	}

	return decided(...damageEvents(slice, who, amount, type, source));
};

const damageEvents = (
	slice: DrawSteelState,
	who: Who,
	amount: number,
	type: string | undefined,
	source?: {
		readonly id: string;
		readonly minions?: number;
		readonly apart?: number;
	}
): Array<NewEvent> => {
	const { dealt, weakness, immunity } = modifiedDamage(
		amount,
		type,
		modifiersOf(slice, who)
	);

	return [
		event("ds.damaged", {
			id: who.id,
			amount,
			...ifDefined(type, (value) => ({ type: value })),
			...when(weakness > 0, () => ({ weakness })),
			...when(immunity > 0, () => ({ immunity })),
			dealt,
			...ifDefined(source, (value) => ({ source: value.id })),
			...ifDefined(source?.minions, (value) => ({ minions: value })),
			...ifDefined(source?.apart, (value) => ({ apart: value })),
		}),
	];
};

const freeStrike = (
	slice: DrawSteelState,
	command: Extract<DsCommand, { type: "fs" }>
): Decision => {
	const striker = resolve(slice, command.who);

	if ("refusal" in striker) {
		return striker;
	}

	if (striker.kind !== "creature") {
		return refuse(
			`Only a creature has a free strike to make; ${striker.name} is a hero.`
		);
	}

	if (isDead(striker)) {
		return refuse(`${striker.name} is dead.`);
	}

	const target = resolve(slice, command.target);

	if ("refusal" in target) {
		return target;
	}

	const strike = slice.blocks[striker.creature.block]?.freeStrike ?? 0;
	const { minions } = command;

	const [from, to] = [
		slice.map?.tokens[striker.id],
		slice.map?.tokens[target.id],
	];

	const away =
		from === undefined || to === undefined
			? undefined
			: apart(
					from,
					footprintOfWho(slice, striker),
					to,
					footprintOfWho(slice, target)
				);

	const by = {
		id: striker.id,
		...ifDefined(away, (value) => ({ apart: value })),
	};

	if (minions === undefined) {
		return damage(slice, target, strike, command.damageType, by);
	}

	if (striker.creature.squad === undefined) {
		return refuse(
			`Only a minion squad strikes together; ${striker.name} is one creature.`
		);
	}

	const left = minionsLeft(striker.creature);

	if (minions > left) {
		return refuse(`${striker.name} has only ${plural(left, "minion")}.`);
	}

	return damage(slice, target, strike * minions, command.damageType, {
		...by,
		minions,
	});
};

const heal = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "heal" }>
): Decision => {
	const who = changeable(slice, actor, command.who);

	if ("refusal" in who) {
		return who;
	}

	if (who.kind === "creature" && who.creature.squad !== undefined) {
		return refuse("Minions can't regain Stamina.");
	}

	if (isDead(who) && actor !== GM) {
		return refuse(`${who.name} is dead.`);
	}

	const board = slice.map;
	const at = board?.tokens[who.id];

	if (board !== undefined && at !== undefined && isDead(who)) {
		const there = occupants(slice, board, who.id)(at);

		if (there !== undefined) {
			return refuse(
				`${findWho(slice, there.id)?.name} stands where ${who.name} lies, at ${formatSquare(at)}; /move them first.`
			);
		}
	}

	const { stamina, max } = staminaOf(who);

	if (stamina >= max) {
		return refuse(`${who.name} is already at full Stamina.`);
	}

	return decided(
		event("ds.healed", {
			id: who.id,
			amount: Math.min(command.amount, max - stamina),
		})
	);
};

const temp = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "temp" }>
): Decision => {
	const who = changeable(slice, actor, command.who);

	if ("refusal" in who) {
		return who;
	}

	if (who.kind === "creature" && who.creature.squad !== undefined) {
		return refuse("Minions can't gain temporary Stamina.");
	}

	if (isDead(who)) {
		return refuse(`${who.name} is dead.`);
	}

	const now = staminaOf(who).temp;

	if (command.amount <= now) {
		return refuse(
			`${who.name} already has ${now} temporary Stamina, and it doesn't stack.`
		);
	}

	return decided(event("ds.temp-set", { id: who.id, temp: command.amount }));
};

const recover = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "recover" }>
): Decision => {
	const hero = changeableHero(slice, actor, command.who, "Recoveries");

	if ("refusal" in hero) {
		return hero;
	}

	const { name } = hero.sheet;

	if (heroHealth(hero) === "dying" && !command.ally && slice.combat.active) {
		return refuse(
			`${name} is dying and can't Catch Breath; /recover ${hero.id} ally if an ally's ability lets them spend one.`
		);
	}

	if (hero.recoveries <= 0) {
		return refuse(`${name} has no Recoveries left.`);
	}

	const max = hero.sheet.stamina;

	if (hero.stamina >= max) {
		return refuse(`${name} is already at full Stamina.`);
	}

	const value = hero.sheet.recoveryValue ?? Math.floor(max / 3);

	return decided(
		event("ds.recovered", {
			id: hero.id,
			amount: Math.min(value, max - hero.stamina),
			ally: command.ally,
		})
	);
};

const sourceOfCondition = (
	slice: DrawSteelState,
	who: Who,
	command: Extract<DsCommand, { type: "cond" }>
): Who | Refused | undefined => {
	if (command.by === undefined) {
		return undefined;
	}

	if (!HELD.includes(command.condition)) {
		return refuse(
			`Only ${orList([...HELD])} name who did it; ${command.condition} doesn't.`
		);
	}

	const source = resolve(slice, command.by);

	if (isRefused(source)) {
		return source;
	}

	return source.id === who.id
		? refuse(`${who.name} can't be ${command.condition} by themselves.`)
		: source;
};

const condition = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "cond" }>
): Decision => {
	const who = changeable(slice, actor, command.who);

	if ("refusal" in who) {
		return who;
	}

	const has = conditionsOf(who).find((c) => c.name === command.condition);

	if (command.remove === true) {
		if (has === undefined) {
			return refuse(`${who.name} isn't ${command.condition}.`);
		}

		return decided(
			event("ds.condition-removed", {
				id: who.id,
				condition: command.condition,
			})
		);
	}

	if (isDead(who)) {
		return refuse(`${who.name} is dead.`);
	}

	const source = sourceOfCondition(slice, who, command);

	if (isRefused(source)) {
		return source;
	}

	const duration = command.duration ?? "end";

	if (has?.duration === duration && has.by === source?.id) {
		return refuse(`${who.name} is already ${command.condition} (${duration}).`);
	}

	return decided(
		event("ds.condition-set", {
			id: who.id,
			condition: command.condition,
			duration,
			...ifDefined(source, (value) => ({ by: value.id })),
		})
	);
};

const save = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "save" }>,
	dice: Dice
): Decision => {
	const who = changeable(slice, actor, command.who);

	if ("refusal" in who) {
		return who;
	}

	const saves = conditionsOf(who).filter((c) => c.duration === "save");

	if (saves.length === 0) {
		return refuse(`${who.name} has nothing a save ends.`);
	}

	const chosen =
		command.condition === undefined
			? saves
			: saves.filter((c) => c.name === command.condition);

	if (chosen.length === 0) {
		return refuse(
			`${who.name} isn't ${command.condition} with a save to end it.`
		);
	}

	return {
		events: chosen.map((c) => {
			const face = rollFace(dice, 10);

			return event("ds.saved", {
				id: who.id,
				condition: c.name,
				roll: face,
				ends: face >= SAVE,
			});
		}),
	};
};

const resource = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "res" }>
): Decision => {
	const hero = changeableHero(slice, actor, command.who, "a heroic resource");

	if ("refusal" in hero) {
		return hero;
	}

	const { name, min = 0 } = hero.sheet.resource;

	if (hero.resource + command.by < min) {
		return refuse(
			min === 0
				? `${hero.sheet.name} has only ${hero.resource} ${name}.`
				: `${hero.sheet.name} can't go below ${min} ${name}.`
		);
	}

	return decided(event("ds.resource-changed", { id: hero.id, by: command.by }));
};

const surge = (
	slice: DrawSteelState,
	actor: string,
	command: Extract<DsCommand, { type: "surge" }>
): Decision => {
	const hero = changeableHero(slice, actor, command.who, "surges");

	if ("refusal" in hero) {
		return hero;
	}

	if (hero.surges + command.by < 0) {
		return refuse(
			`${hero.sheet.name} has only ${plural(hero.surges, "surge")}.`
		);
	}

	return decided(event("ds.surges-changed", { id: hero.id, by: command.by }));
};

const malice = (
	slice: DrawSteelState,
	command: Extract<DsCommand, { type: "malice" }>
): Decision => {
	const { by, reason } = command;

	if (slice.malice + by < 0) {
		return refuse(`The Director has only ${slice.malice} Malice.`);
	}

	return decided(
		event("ds.malice-changed", reason === undefined ? { by } : { by, reason })
	);
};

const token = (
	slice: DrawSteelState,
	actor: string,
	change: number | "reset"
): Decision => {
	if (change === "reset") {
		if (actor !== GM) {
			return refuse("Only the GM can reset hero tokens.");
		}

		return decided(event("ds.tokens-reset", { tokens: slice.heroes.length }));
	}

	if (change > 0 && actor !== GM) {
		return refuse("Only the GM can add hero tokens.");
	}

	if (actor !== GM && heroOf(slice, actor) === undefined) {
		return refuse("Only a player with a hero spends hero tokens; /play one.");
	}

	if (slice.tokens + change < 0) {
		return refuse(`The party has only ${plural(slice.tokens, "hero token")}.`);
	}

	return decided(event("ds.tokens-changed", { by: change }));
};

const victory = (
	slice: DrawSteelState,
	command: Extract<DsCommand, { type: "victory" }>
): Decision => {
	if (slice.heroes.length === 0) {
		return refuse("There's no party yet; /hero brings one in.");
	}

	let heroes: ReadonlyArray<Hero> = slice.heroes.filter(
		(h) => heroHealth(h) !== "dead"
	);

	if (command.who !== undefined) {
		const who = resolve(slice, command.who);

		if ("refusal" in who) {
			return who;
		}

		if (who.kind !== "hero") {
			return refuse(`Only heroes earn Victories; ${who.name} is a creature.`);
		}

		if (isDead(who)) {
			return refuse(`${who.name} is dead and earns no Victories.`);
		}

		heroes = [who.hero];
	}

	if (heroes.length === 0) {
		return refuse("Every hero is dead; there's nobody to earn Victories.");
	}

	const short = heroes.find((h) => h.victories + command.by < 0);

	if (short !== undefined) {
		return refuse(
			`${short.sheet.name} has only ${plural(short.victories, "Victory", "Victories")}.`
		);
	}

	return decided(
		event("ds.victories-changed", {
			ids: heroes.map((h) => h.id),
			by: command.by,
		})
	);
};

const rest = (slice: DrawSteelState): NewEvent => {
	const dead = slice.heroes
		.filter((h) => heroHealth(h) === "dead")
		.map((h) => h.id);

	return event("ds.rested", dead.length === 0 ? {} : { dead });
};

const endCombat = (slice: DrawSteelState): Decision => {
	if (!slice.combat.active) {
		return refuse(NO_COMBAT);
	}

	const cleared = clearedAtEnd(slice);

	return decided(
		event(
			"ds.combat-ended",
			cleared.length === 0 ? {} : { cleared: [...cleared] }
		)
	);
};

const restParty = (slice: DrawSteelState): Decision => {
	if (slice.combat.active) {
		return refuse("Finish the combat first (/end).");
	}

	if (slice.heroes.length === 0) {
		return refuse("There's no party to rest.");
	}

	return decided(rest(slice));
};

type Handler = (
	slice: DrawSteelState,
	actor: string,
	command: DsCommand,
	dice: Dice,
	shared: Shared
) => Decision;

const isType = <T extends DsCommand["type"]>(
	command: DsCommand,
	type: T
): command is Extract<DsCommand, { readonly type: T }> => command.type === type;

const by =
	<T extends DsCommand["type"]>(
		type: T,
		run: (
			slice: DrawSteelState,
			actor: string,
			command: Extract<DsCommand, { readonly type: T }>,
			dice: Dice,
			shared: Shared
		) => Decision
	): Handler =>
	(slice, actor, command, dice, shared) =>
		isType(command, type)
			? run(slice, actor, command, dice, shared)
			: refuse(`There is no "${command.type}" command.`);

const forced = (
	slice: DrawSteelState,
	actor: string,
	command: ForcedCommand<"push" | "pull" | "slide">
): Decision => forceMove(slice, actor, command);

const HANDLERS = {
	hero: by("hero", (slice, _actor, command) => addHero(slice, command)),
	add: by("add", (slice, _actor, command) => addCreatures(slice, command)),
	play: by("play", (slice, actor, command, _dice, shared) =>
		play(slice, actor, command, shared)
	),
	unplay: by("unplay", (slice, actor, command) =>
		unplay(slice, actor, command)
	),
	start: by("start", (slice, _actor, _command, dice) => start(slice, dice)),
	first: by("first", (slice, _actor, command) =>
		slice.combat.active
			? decided(event("ds.first-set", { side: command.side }))
			: refuse(NO_COMBAT)
	),
	turn: by("turn", (slice, actor, command, dice) =>
		turn(slice, actor, command, dice)
	),
	done: by("done", (slice, actor, _command, dice) => done(slice, actor, dice)),
	round: by("round", (slice, _actor, _command, dice) => nextRound(slice, dice)),
	end: by("end", (slice) => endCombat(slice)),
	rest: by("rest", (slice) => restParty(slice)),
	pr: by("pr", (slice, actor, command, dice) =>
		powerRollFor(slice, actor, command, dice)
	),
	dmg: by("dmg", (slice, actor, command) => {
		const who = changeable(slice, actor, command.who);

		return isRefused(who)
			? who
			: damage(slice, who, command.amount, command.damageType);
	}),
	fs: by("fs", (slice, _actor, command) => freeStrike(slice, command)),
	heal: by("heal", (slice, actor, command) => heal(slice, actor, command)),
	temp: by("temp", (slice, actor, command) => temp(slice, actor, command)),
	recover: by("recover", (slice, actor, command) =>
		recover(slice, actor, command)
	),
	cond: by("cond", (slice, actor, command) => condition(slice, actor, command)),
	save: by("save", (slice, actor, command, dice) =>
		save(slice, actor, command, dice)
	),
	res: by("res", (slice, actor, command) => resource(slice, actor, command)),
	surge: by("surge", (slice, actor, command) => surge(slice, actor, command)),
	malice: by("malice", (slice, _actor, command) => malice(slice, command)),
	token: by("token", (slice, actor, command) =>
		token(slice, actor, command.change)
	),
	victory: by("victory", (slice, _actor, command) => victory(slice, command)),
	map: by("map", (slice, _actor, command) => loadMap(slice, command)),
	place: by("place", (slice, actor, command) => place(slice, actor, command)),
	move: by("move", (slice, actor, command, dice) =>
		moveAndBleed(slice, actor, command, dice)
	),
	dist: by("dist", (slice, _actor, command) => measure(slice, command)),
	push: by("push", forced),
	pull: by("pull", forced),
	slide: by("slide", forced),
} as const satisfies Record<DsCommand["type"], Handler>;

export const decide = (
	slice: DrawSteelState,
	actor: string,
	command: DsCommand,
	dice: Dice,
	shared: Shared
): Decision => HANDLERS[command.type](slice, actor, command, dice, shared);
