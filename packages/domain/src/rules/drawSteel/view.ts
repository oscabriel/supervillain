import type { TokenAction } from "../../actions.ts";
import { playerOf } from "../../party.ts";
import type { EncounterSpec, PartyMember } from "../../party.ts";
import { partyFirst, prepMaps, prepSteps } from "../../prep.ts";
import type { PrepCatalog, PrepItem, PrepToken, PrepView } from "../../prep.ts";
import {
	ifDefined,
	listIf,
	listIfDefined,
	orEmpty,
	when,
} from "../../present.ts";
import { GM } from "../core/module.ts";
import type { Refused } from "../engine.ts";
import { ADD_MAX } from "./commands.ts";
import { isTrait } from "./sheets.ts";
import type { Ability, Characteristics, DamageModifier } from "./sheets.ts";
import {
	abilitiesOf,
	budgetOf,
	capitalized,
	CHARACTERISTICS,
	controls,
	creatureHealth,
	everyone,
	findWho,
	heroHealth,
	marks,
	minionsLeft,
	perMinion,
	nextSide,
	resolve,
	sideOf,
	windedAt,
} from "./state.ts";
import type {
	Budget,
	Condition,
	Creature,
	DrawSteelState,
	Hero,
	Who,
} from "./state.ts";

export interface Combatant {
	readonly id: string;
	readonly name: string;
	readonly side: "heroes" | "director";
	readonly stamina: number;
	readonly max: number;
	readonly temp: number;
	readonly count?: number | undefined;
	readonly health?: "winded" | "dying" | "dead" | undefined;
	readonly deadAt?: number;
	readonly conditions: ReadonlyArray<string>;
	readonly resource?: string;
	readonly recoveries?: { readonly left: number; readonly max: number };
	readonly surges?: number;
	readonly acted: boolean;
	readonly acting: boolean;
	readonly mine: boolean;
	readonly free?: boolean;
	readonly mark?: string;
	readonly turnActions?: string;
	readonly actions?: CombatantActions;
	readonly penalty?: string;
}

export interface CombatantActions {
	readonly left: number;
	readonly max: number;
	readonly reaction: boolean;
}

export interface CombatView {
	readonly round: number;
	readonly active: boolean;
	readonly next?: "heroes" | "director" | undefined;
	readonly malice: number;
	readonly heroTokens: number;
	readonly victories?: number;
	readonly title?: string;
	readonly meterLabel?: string;
	readonly combatants: ReadonlyArray<Combatant>;
}

const CONDITION_SUFFIX = { eot: " (EoT)", save: " (save)", end: "" } as const;

const conditionText = (c: Condition, nameOf?: (id: string) => string) =>
	`${c.name}${c.by === undefined || nameOf === undefined ? "" : ` by ${nameOf(c.by)}`}${CONDITION_SUFFIX[c.duration]}`;

const budgetText = (budget: Budget): string => {
	if (budget.dazed) {
		return budget.main > 0
			? "dazed: one action left"
			: "dazed: no actions left";
	}

	const left = [
		...listIf(budget.main > 1, () => [`${budget.main} main`]),
		...listIf(budget.main === 1, () => ["main"]),
		...listIf(budget.maneuver > 0, () => ["maneuver"]),
		...listIf(budget.move > 0, () => ["move"]),
	];

	return left.length === 0 ? "no actions left" : `left: ${left.join(", ")}`;
};

const turnActionsOf = (slice: DrawSteelState, who: Who) => {
	const { combat } = slice;

	if (!combat.active) {
		return {};
	}

	if (combat.acting === who.id) {
		return { turnActions: budgetText(budgetOf(slice, who)) };
	}

	return (combat.triggered ?? []).includes(who.id)
		? { turnActions: "triggered action used" }
		: {};
};

const combatant = (
	slice: DrawSteelState,
	who: Who,
	actor: string,
	labelOf?: (actor: string) => string,
	marked?: ReadonlyMap<string, string>
): Combatant => {
	const { combat } = slice;
	const acting = combat.acting === who.id;

	const mark =
		slice.map?.tokens[who.id] === undefined ? undefined : marked?.get(who.id);

	const nameOf = (id: string) => findWho(slice, id)?.name ?? id;

	const shared = {
		id: who.id,
		side: sideOf(who),
		acted: combat.acted.includes(who.id) && !acting,
		acting,
		...ifDefined(mark, (value) => ({ mark: value })),
		...turnActionsOf(slice, who),
	};

	if (who.kind === "hero") {
		const h = who.hero;
		const health = heroHealth(h);

		const player =
			h.player !== undefined && h.player !== actor
				? labelOf?.(h.player)
				: undefined;

		return {
			...shared,
			name: player === undefined ? h.sheet.name : `${h.sheet.name} (${player})`,
			stamina: h.stamina,
			max: h.sheet.stamina,
			temp: h.temp,
			...ifDefined(health, (value) => ({ health: value })),
			...when(health === "dying", () => ({
				deadAt: -windedAt(h.sheet.stamina),
			})),
			conditions: heroConditions(h, nameOf),
			resource: `${h.sheet.resource.name} ${h.resource}`,
			recoveries: { left: h.recoveries, max: h.sheet.recoveries },
			surges: h.surges,
			mine: h.player === actor,
			...when(h.player === undefined && health !== "dead", () => ({
				free: true,
			})),
		};
	}

	const c = who.creature;
	const health = creatureHealth(c);

	return {
		...shared,
		name: c.name,
		stamina: c.stamina,
		max: c.max,
		temp: c.temp,
		...when(c.squad !== undefined, () => ({ count: minionsLeft(c) })),
		...ifDefined(health, (value) => ({ health: value })),
		conditions: c.conditions.map((condition) =>
			conditionText(condition, nameOf)
		),
		mine: false,
	};
};

const heroConditions = (
	h: Hero,
	nameOf: (id: string) => string
): ReadonlyArray<string> => [
	...listIf(
		heroHealth(h) === "dying" &&
			!h.conditions.some((c) => c.name === "bleeding"),
		() => ["bleeding"]
	),
	...h.conditions.map((c) => conditionText(c, nameOf)),
];

export const combatView = (
	slice: DrawSteelState,
	actor: string,
	labelOf?: (actor: string) => string
): CombatView | undefined => {
	const { combat } = slice;

	if (!combat.active && slice.heroes.length === 0) {
		return undefined;
	}

	const shown = combat.active
		? everyone(slice)
		: everyone(slice).filter((w) => w.kind === "hero");

	const leading = combat.first ?? "heroes";
	const marked = slice.map === undefined ? undefined : marks(slice);

	const ordered = [
		...shown.filter((w) => sideOf(w) === leading),
		...shown.filter((w) => sideOf(w) !== leading),
	];

	const next = nextSide(slice);
	const living = slice.heroes.filter((h) => heroHealth(h) !== "dead");

	const victories =
		living.length === 0
			? undefined
			: Math.floor(living.reduce((s, h) => s + h.victories, 0) / living.length);

	return {
		round: combat.round,
		active: combat.active,
		...ifDefined(next, (value) => ({ next: value })),
		malice: slice.malice,
		heroTokens: slice.tokens,
		...ifDefined(victories, (value) => ({ victories: value })),
		combatants: ordered.map((w) => combatant(slice, w, actor, labelOf, marked)),
	};
};

export const withHeroes =
	(slice: DrawSteelState, labelOf: (actor: string) => string) =>
	(actor: string): string => {
		const hero = slice.heroes.find((h) => h.player === actor);

		return hero === undefined
			? labelOf(actor)
			: `${labelOf(actor)} (${hero.sheet.name})`;
	};

const signedScore = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

const characteristicsLine = (scores: Characteristics) =>
	CHARACTERISTICS.map(
		(c) => `${capitalized(c)} ${signedScore(scores[c])}`
	).join(" · ");

const modifierList = (ms: ReadonlyArray<DamageModifier>) =>
	ms.map((m) => `${m.type} ${m.value}`).join(", ");

const modifiersLine = (
	immunities: ReadonlyArray<DamageModifier> | undefined,
	weaknesses: ReadonlyArray<DamageModifier> | undefined
) => {
	const parts = [
		...listIf(orEmpty(immunities).length > 0, () => [
			`Immune: ${modifierList(orEmpty(immunities))}`,
		]),
		...listIf(orEmpty(weaknesses).length > 0, () => [
			`Weak: ${modifierList(orEmpty(weaknesses))}`,
		]),
	];

	return parts.length === 0 ? [] : [parts.join(" · ")];
};

const rollText = (ability: Ability): string | undefined => {
	if (ability.bonus !== undefined) {
		return `2d10 ${signedScore(ability.bonus).replace(/^(?<sign>[+-])/u, "$<sign> ")}`;
	}

	const uses = ability.characteristics ?? [];

	return uses.length > 0
		? `2d10 + ${uses.map(capitalized).join(" or ")}`
		: undefined;
};

const abilityLines = (ability: Ability): Array<string> => {
	const facts = [
		ability.kind,
		ability.cost === undefined ? undefined : `cost ${ability.cost}`,
		ability.keywords !== undefined && ability.keywords.length > 0
			? ability.keywords.join(", ")
			: undefined,
		ability.distance,
		ability.target,
	].filter((f): f is string => f !== undefined && f !== "");

	const roll = rollText(ability);

	const head = `${ability.name}${facts.length > 0 ? ` (${facts.join("; ")})` : ""}${roll === undefined ? "" : `: ${roll}`}`;

	return [
		head,
		...listIfDefined(ability.tier1, (value) => [`  ≤11: ${value}`]),
		...listIfDefined(ability.tier2, (value) => [`  12-16: ${value}`]),
		...listIfDefined(ability.tier3, (value) => [`  17+: ${value}`]),
		...listIfDefined(ability.effect, (value) => [`  Effect: ${value}`]),
	];
};

const squadPart = (
	c: Creature,
	health: string | undefined
): ReadonlyArray<string> => {
	if (c.squad !== undefined) {
		return [`${minionsLeft(c)} of ${c.squad} minions, ${perMinion(c)} each`];
	}

	return health === undefined ? [] : [health];
};

const boardActions = (
	slice: DrawSteelState,
	who: Who
): ReadonlyArray<TokenAction> => {
	if (slice.map === undefined) {
		return [];
	}

	return slice.map.tokens[who.id] === undefined
		? [{ label: "Place", pick: "square", line: `/place ${who.id}` }]
		: [{ label: "Move", pick: "square", line: `/move ${who.id}` }];
};

const conditionsLine = (
	slice: DrawSteelState,
	conditions: ReadonlyArray<Condition>
) =>
	conditions.length === 0
		? []
		: [
				`Conditions: ${conditions
					.map((c) => conditionText(c, (id) => findWho(slice, id)?.name ?? id))
					.join(", ")}`,
			];

export const sheetText = (
	slice: DrawSteelState,
	typed: string
): string | Refused => {
	const who = resolve(slice, typed);

	if ("refusal" in who) {
		return who;
	}

	if (who.kind === "hero") {
		const h = who.hero;
		const s = h.sheet;
		const health = heroHealth(h);
		const winded = windedAt(s.stamina);
		const value = s.recoveryValue ?? Math.floor(s.stamina / 3);

		return [
			`${s.name}: ${s.class} ${s.level}`,
			[
				`Stamina ${h.stamina}/${s.stamina}`,
				...listIf(h.temp > 0, () => [`temp ${h.temp}`]),
				`${health === "dying" ? "dying and bleeding" : (health ?? "healthy")} (winded at ${winded}, dead at -${winded})`,
				`Recoveries ${h.recoveries}/${s.recoveries}, ${value} each`,
			].join(" · "),
			`${s.resource.name} ${h.resource} (+${s.resource.perTurn} a turn) · surges ${h.surges} · Victories ${h.victories} · XP ${h.xp}`,
			characteristicsLine(s.characteristics),
			`Speed ${s.speed} · Stability ${s.stability}${s.size === undefined ? "" : ` · Size ${s.size}`}`,
			...modifiersLine(s.immunities, s.weaknesses),
			...conditionsLine(slice, h.conditions),
			"",
			...s.abilities.flatMap(abilityLines),
		].join("\n");
	}

	const c = who.creature;
	const b = slice.blocks[c.block];

	if (b === undefined) {
		return `${c.name}: Stamina ${c.stamina}/${c.max}`;
	}

	const what = [`level ${b.level} ${b.organization}`, b.role?.toLowerCase()]
		.filter((x) => x !== undefined)
		.join(" ");

	const health = creatureHealth(c);

	return [
		`${c.name}: ${c.name === b.name ? "" : `${b.name}, `}${what}`,
		[
			`Stamina ${c.stamina}/${c.max}`,
			...listIf(c.temp > 0, () => [`temp ${c.temp}`]),
			...squadPart(c, health),
			`Free strike ${b.freeStrike}`,
		].join(" · "),
		characteristicsLine(b.characteristics),
		`Speed ${b.speed} · Stability ${b.stability}${b.size === undefined ? "" : ` · Size ${b.size}`}`,
		...modifiersLine(b.immunities, b.weaknesses),
		...listIf(c.squad !== undefined && b.withCaptain !== undefined, () => [
			`With a captain: ${b.withCaptain}`,
		]),
		...conditionsLine(slice, c.conditions),
		...listIf(b.abilities.length > 0, () => [
			"",
			...b.abilities.flatMap(abilityLines),
		]),
	].join("\n");
};

export const tokenActions = (
	slice: DrawSteelState,
	actor: string,
	id: string
): ReadonlyArray<TokenAction> | undefined => {
	const who = findWho(slice, id);

	if (who === undefined || !controls(actor, who)) {
		return undefined;
	}

	const abilities = abilitiesOf(slice, who);

	return [
		...boardActions(slice, who),
		...abilities
			.filter((a) => !isTrait(a))
			.map((a) => ({
				label: a.name,
				pick: "targets" as const,
				line: `/pr ${who.id} ${a.name}`,
			})),
		...listIf(who.kind === "creature" && actor === GM, () => [
			{
				label: "Free strike",
				pick: "target" as const,
				line: `/fs ${who.id}`,
			},
		]),
		...listIf(slice.combat.active && slice.combat.acting === who.id, () => [
			{ label: "End turn", pick: "none" as const, line: "/done" },
		]),
	];
};

export const drawSteelPrep = (
	slice: DrawSteelState,
	catalog: PrepCatalog
): PrepView => {
	const inPlay = new Set(slice.heroes.map((h) => h.id));

	const added = (block: string) =>
		slice.creatures.filter((c) => c.block === block).length;

	const board = slice.map;

	const living = everyone(slice).filter(
		(w) => w.kind === "hero" || w.creature.stamina > 0
	);

	const place = living
		.filter((w) => board?.tokens[w.id] === undefined)
		.map((w): PrepToken => ({
			id: w.id,
			name: w.name,
			figure:
				w.kind === "hero"
					? { id: w.id, side: "heroes" }
					: { id: w.creature.block, side: "director" },
		}));

	const joining = catalog.heroes.filter((h) => !inPlay.has(h.id));

	return {
		steps: prepSteps(
			board !== undefined,
			living.map((w) => ({
				side: sideOf(w),
				placed: board?.tokens[w.id] !== undefined,
			}))
		),
		maps: prepMaps(catalog, board),
		place: board === undefined ? [] : partyFirst(place),
		sections: [
			{
				title: "heroes",
				items: joining.map((h): PrepItem => ({
					kind: "send",
					label: h.name,
					line: `/hero ${h.id}`,
					figure: { id: h.id, side: "heroes" },
				})),
				...when(catalog.heroes.length === 0, () => ({
					note: "no sheets in heroes/",
				})),
				...when(joining.length > 1, () => ({
					all: joining.map((h) => `/hero ${h.id}`),
				})),
			},
			{
				title: "monsters",
				items: catalog.monsters.map((m): PrepItem => {
					const n = added(m.id);

					return {
						kind: "count",
						label: m.name,
						line: `/add ${m.id}`,
						max: ADD_MAX,
						figure: { id: m.id, side: "director" },
						...when(n > 0, () => ({ note: `×${n}` })),
					};
				}),
				...when(catalog.monsters.length === 0, () => ({
					note: "no stat blocks in monsters/",
				})),
			},
		],
		start: slice.combat.active
			? { note: `round ${slice.combat.round}` }
			: { line: "/start" },
	};
};

export const dsParty = (
	slice: DrawSteelState,
	actor: string,
	label: (actor: string) => string
): ReadonlyArray<PartyMember> =>
	slice.heroes.map((hero): PartyMember => {
		const health = heroHealth(hero);

		return {
			id: hero.id,
			name: hero.sheet.name,
			...playerOf(hero.player, actor, label),
			mine: hero.player === actor,
			free: hero.player === undefined,
			down: health === "dying" || health === "dead",
			health: {
				label: "stamina",
				value: hero.stamina,
				max: hero.sheet.stamina,
			},
			summary: `${hero.sheet.class} ${hero.sheet.level} · recoveries ${hero.recoveries}/${hero.sheet.recoveries} · victories ${hero.victories}`,
			tags: hero.conditions.map((c) => c.name),
		};
	});

export const dsFightLines = (
	encounter: EncounterSpec
): ReadonlyArray<string> => [
	...listIfDefined(encounter.map, (id) => [`/map ${id}`]),
	...encounter.monsters.map((m) =>
		(m.count ?? 1) === 1 ? `/add ${m.id}` : `/add ${m.id} x${m.count ?? 1}`
	),
];

export const dsResyncLines = (
	slice: DrawSteelState,
	changed: ReadonlyArray<string>
): ReadonlyArray<string> =>
	slice.heroes
		.filter((h) => changed.includes(h.id))
		.map((h) => `/hero ${h.id}`);
