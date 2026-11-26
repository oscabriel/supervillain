import { signed } from "../../dice.ts";
import { ifDefined, listIf, orEmpty, when } from "../../present.ts";
import { hasTerminalControls } from "../../text.ts";
import { squaresOf } from "../board/footprint.ts";
import {
	distance,
	formatSquare,
	malformed,
	sameSquare,
	standable,
} from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import type { FeedNote } from "../core/module.ts";
import { bad, payloadDecoder } from "../engine.ts";
import type { Envelope } from "../engine.ts";
import { occupants } from "./board.ts";
import { Payloads, isEventType } from "./events.ts";
import type { EventType, Payload } from "./events.ts";
import { safeSheet } from "./schema.ts";
import {
	actionKindOf,
	bestScore,
	isTrait,
	reachOf,
	TIER_PLUS,
} from "./sheets.ts";
import type { ActionKind, HeroSheet } from "./sheets.ts";
import {
	abilitiesOf,
	andList,
	capitalized,
	creatureHealth,
	findWho,
	footprintOfWho,
	heroHealth,
	minionsLeft,
	NO_COMBAT,
	plural,
	startedActions,
} from "./state.ts";
import type {
	Board,
	Combat,
	Condition,
	Creature,
	DrawSteelState,
	Health,
	Hero,
	TurnActions,
	Who,
} from "./state.ts";

interface Applied {
	readonly slice: DrawSteelState;
	readonly feed?: FeedNote;
}

export const formats = {
	ds: { speaker: false, separator: "" },
	"ds-roll": { speaker: false, separator: "" },
	"ds-turn": { speaker: false, separator: "" },
	"ds-act": { speaker: true, separator: " " },
	"ds-claim": { speaker: true, separator: " ", plainLabel: true },
} as const;

const decode = payloadDecoder(Payloads);

const EDGE_NOTES: ReadonlyMap<number, ReadonlyArray<string>> = new Map([
	[2, ["double edge"]],
	[-2, ["double bane"]],
]);

const EDGE_BONUS: ReadonlyMap<number, ReadonlyArray<string>> = new Map([
	[1, ["+2 edge"]],
	[-1, ["-2 bane"]],
]);

const who = (slice: DrawSteelState, envelope: Envelope, id: string): Who =>
	findWho(slice, id) ?? bad(envelope, `names '${id}', who isn't at the table`);

const hero = (slice: DrawSteelState, envelope: Envelope, id: string): Hero => {
	const found = who(slice, envelope, id);

	return found.kind === "hero"
		? found.hero
		: bad(envelope, `names '${id}', who isn't a hero`);
};

const withHero = (
	slice: DrawSteelState,
	id: string,
	f: (h: Hero) => Hero
): DrawSteelState => ({
	...slice,
	heroes: slice.heroes.map((h) => (h.id === id ? f(h) : h)),
});

const withCreature = (
	slice: DrawSteelState,
	id: string,
	f: (c: Creature) => Creature
): DrawSteelState => ({
	...slice,
	creatures: slice.creatures.map((c) => (c.id === id ? f(c) : c)),
});

const withWho = (
	slice: DrawSteelState,
	envelope: Envelope,
	id: string,
	f: <T extends Hero | Creature>(x: T) => T
): DrawSteelState =>
	who(slice, envelope, id).kind === "hero"
		? withHero(slice, id, f)
		: withCreature(slice, id, f);

const isDeadWho = (found: ReturnType<typeof findWho>): boolean => {
	if (found === undefined) {
		return false;
	}

	return found.kind === "hero"
		? heroHealth(found.hero) === "dead"
		: creatureHealth(found.creature) === "dead";
};

const releaseBy = (slice: DrawSteelState, holder: string): DrawSteelState => {
	const drop = (conditions: ReadonlyArray<Condition>) =>
		conditions.filter((c) => c.by !== holder);

	return {
		...slice,
		heroes: slice.heroes.map((h) =>
			h.conditions.some((c) => c.by === holder)
				? { ...h, conditions: drop(h.conditions) }
				: h
		),
		creatures: slice.creatures.map((c) =>
			c.conditions.some((cond) => cond.by === holder)
				? { ...c, conditions: drop(c.conditions) }
				: c
		),
	};
};

const buried = (
	before: DrawSteelState,
	after: DrawSteelState,
	id: string
): DrawSteelState => {
	const [was, now] = [findWho(before, id), findWho(after, id)];

	if (isDeadWho(was) || !isDeadWho(now)) {
		return after;
	}

	const cleared =
		now?.kind === "hero" && now.hero.conditions.length > 0
			? withHero(after, id, (h) => ({ ...h, conditions: [] }))
			: after;

	return releaseBy(cleared, id);
};

const healthSuffix = (health: Health | undefined) =>
	health === undefined ? "" : ` · ${health}`;

const meter = (slice: DrawSteelState, id: string): string => {
	const found = findWho(slice, id);

	if (found === undefined) {
		return "";
	}

	if (found.kind === "hero") {
		return `${found.hero.stamina}/${found.hero.sheet.stamina}${healthSuffix(heroHealth(found.hero))}`;
	}

	const c = found.creature;

	return `${c.stamina}/${c.max}${c.squad === undefined ? healthSuffix(creatureHealth(c)) : ""}`;
};

const nameOf = (slice: DrawSteelState, id: string) =>
	findWho(slice, id)?.name ?? id;

const DURATION_TEXT = {
	eot: " (EoT)",
	save: " (save ends)",
	end: " until the end of the encounter",
} as const;

const durationText = (condition: Condition): string =>
	DURATION_TEXT[condition.duration];

const isSafe = (text: string) => !hasTerminalControls(text);

const heroJoined = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { sheet } = decode("ds.hero-joined", envelope);

	if (!safeSheet(sheet)) {
		bad(envelope, "holds control characters");
	}

	if (slice.creatures.some((c) => c.id === sheet.id)) {
		bad(envelope, `reuses the id '${sheet.id}'`);
	}

	const summary = `${sheet.class} ${sheet.level}, ${sheet.stamina} Stamina.`;
	const existing = slice.heroes.find((h) => h.id === sheet.id);

	if (existing !== undefined) {
		const next = withHero(slice, sheet.id, (h) => ({
			...h,
			sheet,
			stamina: Math.min(h.stamina, sheet.stamina),
			recoveries: Math.min(h.recoveries, sheet.recoveries),
		}));

		return {
			slice: next,
			feed: {
				kind: "ds",
				text: `${sheet.name}'s sheet is reloaded: ${summary}`,
			},
		};
	}

	const joined: Hero = {
		id: sheet.id,
		sheet,
		stamina: sheet.stamina,
		temp: 0,
		recoveries: sheet.recoveries,
		resource: 0,
		surges: 0,
		victories: sheet.victories,
		xp: 0,
		conditions: [],
	};

	return {
		slice: { ...slice, heroes: [...slice.heroes, joined] },
		feed: { kind: "ds", text: `${sheet.name} joins the party: ${summary}` },
	};
};

const creaturesAdded = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { block, creatures } = decode("ds.creatures-added", envelope);

	if (!safeSheet(block) || !creatures.every((c) => isSafe(c.name))) {
		bad(envelope, "holds control characters");
	}

	const taken = new Set([
		...slice.heroes.map((h) => h.id),
		...slice.creatures.map((c) => c.id),
	]);

	const added = creatures.map((c): Creature => {
		if (taken.has(c.id)) {
			bad(envelope, `reuses the id '${c.id}'`);
		}

		if (
			c.squad !== undefined &&
			(c.squad < 1 || block.organization !== "minion")
		) {
			bad(envelope, `has a bad squad for '${c.id}'`);
		}

		taken.add(c.id);
		const max = block.stamina * (c.squad ?? 1);

		const creature = {
			id: c.id,
			name: c.name,
			block: block.id,
			stamina: max,
			max,
			temp: 0,
			conditions: [],
		};

		return c.squad === undefined ? creature : { ...creature, squad: c.squad };
	});

	const names = creatures.map((c) =>
		c.squad === undefined ? c.name : `${c.name} (${plural(c.squad, "minion")})`
	);

	return {
		slice: {
			...slice,
			creatures: [...slice.creatures, ...added],
			blocks: { ...slice.blocks, [block.id]: block },
		},
		feed: {
			kind: "ds",
			text: `${andList(names)} ${names.length === 1 ? "joins" : "join"} the fight.`,
		},
	};
};

const heroClaimed = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { hero: id, player, label } = decode("ds.hero-claimed", envelope);
	const claimed = hero(slice, envelope, id);

	if (label !== undefined && !isSafe(label)) {
		bad(envelope, "holds control characters");
	}

	if (slice.heroes.some((h) => h.player === player && h.id !== id)) {
		bad(envelope, "gives a player a second hero");
	}

	const next = withHero(slice, id, (h) => ({ ...h, player }));

	return {
		slice: next,
		feed: {
			kind: "ds-claim",
			text: `takes ${claimed.sheet.name}.`,
			speaker: player,
		},
	};
};

const heroReleased = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { hero: id } = decode("ds.hero-released", envelope);
	const released = hero(slice, envelope, id);
	const next = withHero(slice, id, ({ player: _player, ...h }) => h);
	const { name } = released.sheet;

	return {
		slice: next,
		feed:
			released.player === envelope.actor
				? { kind: "ds-act", text: `stops playing ${name}.` }
				: { kind: "ds", text: `Nobody plays ${name} now.` },
	};
};

const combatStarted = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { roll, gains, malice } = decode("ds.combat-started", envelope);

	if (slice.combat.active) {
		bad(envelope, "starts a combat while one runs");
	}

	if (roll < 1 || roll > 10) {
		bad(envelope, `has a d10 of ${roll}`);
	}

	let next: DrawSteelState = slice;
	const gained: Array<string> = [];

	for (const [id, gain] of Object.entries(gains)) {
		const h = hero(slice, envelope, id);
		next = withHero(next, id, (x) => ({ ...x, resource: x.resource + gain }));

		if (gain !== 0) {
			gained.push(`${h.sheet.name} ${signed(gain)} ${h.sheet.resource.name}`);
		}
	}

	const added = malice.victories + malice.heroes + malice.round;
	const total = slice.malice + added;
	next = {
		...next,
		malice: total,
		combat: { active: true, round: 1, roll, acted: [] },
	};
	const picker = roll >= 6 ? "the players pick" : "the Director picks";

	const text = [
		`Combat begins, round 1. d10: ${roll}, so ${picker} who goes first, and the GM types /first heroes or /first director.`,
		`Malice ${signed(added) || "+0"} (${malice.victories} for Victories, ${plural(malice.heroes, "hero", "heroes")}, round ${malice.round}) → ${total}.`,
		...listIf(gained.length > 0, () => [`${gained.join(", ")}.`]),
		...listIf(slice.tokens === 0 && slice.heroes.length > 0, () => [
			"The party has no hero tokens; /token reset gives one per hero.",
		]),
	].join(" ");

	return { slice: next, feed: { kind: "ds-turn", text } };
};

const firstSet = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { side } = decode("ds.first-set", envelope);

	if (!slice.combat.active) {
		bad(envelope, "comes outside combat");
	}

	return {
		slice: { ...slice, combat: { ...slice.combat, first: side } },
		feed: {
			kind: "ds-turn",
			text:
				side === "heroes"
					? "The heroes go first each round."
					: "The Director goes first each round.",
		},
	};
};

const roundStarted = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { round, heroes, malice } = decode("ds.round-started", envelope);

	if (!slice.combat.active) {
		bad(envelope, "comes outside combat");
	}

	if (round !== slice.combat.round + 1) {
		bad(envelope, `skips from round ${slice.combat.round}`);
	}

	if (slice.combat.acting !== undefined) {
		bad(envelope, "starts a round during a turn");
	}

	const total = slice.malice + malice;

	return {
		slice: {
			...slice,
			malice: total,
			combat: { ...slice.combat, round, acted: [] },
		},
		feed: {
			kind: "ds-turn",
			text: `Round ${round}. Malice +${malice} (${plural(heroes, "hero", "heroes")}, round ${round}) → ${total}.`,
		},
	};
};

const turnStarted = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, gain, rolls } = decode("ds.turn-started", envelope);

	if (!slice.combat.active) {
		bad(envelope, "comes outside combat");
	}

	if (slice.combat.acting !== undefined) {
		bad(envelope, "starts a turn during another");
	}

	const found = who(slice, envelope, id);

	const acted = slice.combat.acted.includes(id)
		? slice.combat.acted
		: [...slice.combat.acted, id];

	const {
		moved: _moved,
		actions: _actions,
		triggered,
		...combat
	} = slice.combat;

	const ready = (triggered ?? []).filter((t) => t !== id);

	let next: DrawSteelState = {
		...slice,
		combat: {
			...combat,
			acted,
			acting: id,
			actions: startedActions(id),
			...when(ready.length > 0, () => ({ triggered: ready })),
		},
	};

	let text = `${found.name}'s turn.`;

	if (gain !== undefined) {
		const h = hero(slice, envelope, id);
		next = withHero(next, id, (x) => ({ ...x, resource: x.resource + gain }));

		const dice =
			rolls === undefined
				? ""
				: ` (${h.sheet.resource.perTurn}: ${rolls.join(", ")})`;

		text += ` ${h.sheet.resource.name} ${signed(gain) || "+0"}${dice} → ${h.resource + gain}.`;
	}

	return { slice: next, feed: { kind: "ds-turn", text } };
};

const turnEnded = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, ended, saves } = decode("ds.turn-ended", envelope);

	if (slice.combat.acting !== id) {
		bad(envelope, `ends a turn '${id}' isn't taking`);
	}

	if (saves.some((s) => s.roll < 1 || s.roll > 10)) {
		bad(envelope, "has a save that isn't a d10");
	}

	const gone = new Set([
		...ended,
		...saves.filter((s) => s.ends).map((s) => s.condition),
	]);

	const {
		acting: _acting,
		moved: _moved,
		actions: _actions,
		...combat
	} = slice.combat;

	const next = withWho({ ...slice, combat }, envelope, id, (x) => ({
		...x,
		conditions: x.conditions.filter((c) => !gone.has(c.name)),
	}));

	const parts = [
		`${nameOf(slice, id)}'s turn ends.`,
		...ended.map((c) => `${capitalized(c)} ends.`),
		...saves.map(
			(s) =>
				`Save against ${s.condition}: ${s.roll}, ${s.ends ? "it ends" : "it goes on"}.`
		),
	];

	return { slice: next, feed: { kind: "ds-turn", text: parts.join(" ") } };
};

const combatEnded = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { cleared = [] } = decode("ds.combat-ended", envelope);

	if (!slice.combat.active) {
		bad(envelope, "comes outside combat");
	}

	const gone = new Set(cleared);

	const left = slice.creatures.find(
		(c) => slice.map?.tokens[c.id] !== undefined && !gone.has(c.id)
	);

	if (left !== undefined) {
		bad(envelope, `leaves '${left.id}' on the map`);
	}

	const map =
		slice.map === undefined
			? undefined
			: {
					...slice.map,
					tokens: Object.fromEntries(
						Object.entries(slice.map.tokens).filter(([id]) => !gone.has(id))
					),
				};

	return {
		slice: {
			...slice,
			...ifDefined(map, (value) => ({ map: value })),
			combat: NO_COMBAT,
			creatures: [],
			blocks: {},
			malice: 0,
			heroes: slice.heroes.map((h) => ({
				...h,
				resource: 0,
				surges: 0,
				temp: 0,
				conditions: [],
			})),
		},
		feed: {
			kind: "ds-turn",
			text: "Combat ends. Heroic resources, surges and Malice are lost; temporary Stamina and conditions end.",
		},
	};
};

const rested = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { dead = [] } = decode("ds.rested", envelope);
	const resting = slice.heroes.filter((h) => !dead.includes(h.id));

	const xp = resting
		.filter((h) => h.victories > 0)
		.map((h) => `${h.sheet.name} ${h.victories}`);

	const named = dead.map((id) => hero(slice, envelope, id).sheet.name);

	const text = [
		"The party rests: Stamina and Recoveries are back to full.",
		...listIf(xp.length > 0, () => [`Victories become XP: ${xp.join(", ")}.`]),
		...listIf(named.length > 0, () => [
			`${andList(named)} ${named.length === 1 ? "is dead and doesn't" : "are dead and don't"} recover.`,
		]),
	].join(" ");

	return {
		slice: {
			...slice,
			heroes: slice.heroes.map((h) =>
				dead.includes(h.id)
					? h
					: {
							...h,
							stamina: h.sheet.stamina,
							recoveries: h.sheet.recoveries,
							temp: 0,
							victories: 0,
							xp: h.xp + h.victories,
						}
			),
		},
		feed: { kind: "ds", text },
	};
};

const withScores = (text: string, sheet: HeroSheet) =>
	text.replace(TIER_PLUS, (match, n: string, letters?: string) => {
		if (letters === undefined) {
			return match;
		}

		const score = bestScore(letters, sheet.characteristics);

		return `${n} + ${letters} (${score}) = ${Math.max(0, Number(n) + score)}`;
	});

interface Spent {
	readonly next: DrawSteelState;
	readonly paid: string;
}

const spend = (
	slice: DrawSteelState,
	envelope: Envelope,
	found: Who,
	cost: number | undefined
): Spent => {
	if (cost !== undefined && cost < 0) {
		bad(envelope, "has a negative cost");
	}

	if (found.kind === "creature" && slice.malice - (cost ?? 0) < 0) {
		bad(envelope, "spends Malice the Director doesn't have");
	}

	if (cost === undefined || cost === 0) {
		return { next: slice, paid: "" };
	}

	if (found.kind === "hero") {
		const after = found.hero.resource - cost;

		return {
			next: withHero(slice, found.id, (h) => ({ ...h, resource: after })),
			paid: ` (${cost} ${found.hero.sheet.resource.name} → ${after})`,
		};
	}

	const malice = slice.malice - cost;

	return { next: { ...slice, malice }, paid: ` (${cost} Malice → ${malice})` };
};

const sentences = (parts: ReadonlyArray<string | undefined>) =>
	parts
		.flatMap((p) =>
			p === undefined || p === "" ? [] : [p.replace(/\.$/u, "")]
		)
		.join(". ");

const rollHead = (
	p: Payload<"ds.power-rolled">,
	name: string,
	at: string,
	paid: string
): string => {
	if (p.ability !== undefined) {
		return `${name} uses ${p.ability}${at}${paid}:`;
	}

	return p.characteristic === undefined
		? `${name} rolls${at}:`
		: `${name} rolls ${capitalized(p.characteristic)}${at}:`;
};

const spentOn = (
	actions: TurnActions,
	action: Exclude<ActionKind, "triggered">,
	extra: number
): TurnActions => ({
	...actions,
	[action]: actions[action] + 1,
	extra: actions.extra + extra,
});

const withAction = (
	slice: DrawSteelState,
	id: string,
	action: ActionKind | undefined,
	extra = 0
): DrawSteelState => {
	const { combat } = slice;

	if (action === undefined || !combat.active) {
		return slice;
	}

	if (action === "triggered") {
		const used = combat.triggered ?? [];

		return used.includes(id)
			? slice
			: { ...slice, combat: { ...combat, triggered: [...used, id] } };
	}

	if (combat.acting !== id) {
		return slice;
	}

	const actions =
		combat.actions?.id === id ? combat.actions : startedActions(id);

	const next: Combat = {
		...combat,
		actions: spentOn(actions, action, extra),
	};

	return { ...slice, combat: next };
};

const MODIFIER_WORDS: ReadonlyMap<number, string> = new Map([
	[2, "double edge"],
	[1, "edge"],
	[-1, "bane"],
	[-2, "double bane"],
]);

const modifierText = (
	slice: DrawSteelState,
	envelope: Envelope,
	p: Payload<"ds.power-rolled">
): string => {
	const said = (p.conditions ?? []).map((m) => {
		const whose = m.id === p.id ? "" : `${who(slice, envelope, m.id).name} `;
		const what = MODIFIER_WORDS.get(m.edges - m.banes) ?? "no change";

		return `${whose}${m.condition}: ${what}`;
	});

	return said.length === 0 ? "" : ` (${said.join("; ")})`;
};

const powerRolled = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const p = decode("ds.power-rolled", envelope);
	const found = who(slice, envelope, p.id);

	if (p.dice.some((d) => d < 1 || d > 10)) {
		bad(envelope, "has dice that aren't d10s");
	}

	const targets = (p.targets ?? []).map((t) => ({
		...t,
		name: who(slice, envelope, t.id).name,
	}));

	const ability = abilitiesOf(slice, found).find((a) => a.name === p.ability);
	const printed = ability?.[`tier${p.tier}`];

	const tierText =
		printed !== undefined && found.kind === "hero"
			? withScores(printed, found.hero.sheet)
			: printed;

	const { next: paidFor, paid } = spend(slice, envelope, found, p.cost);

	const at =
		targets.length === 0 ? "" : ` on ${andList(targets.map((t) => t.name))}`;

	const head = rollHead(p, found.name, at, paid);

	const net = Math.min(p.edges, 2) - Math.min(p.banes, 2);
	const natural = p.dice[0] + p.dice[1] >= 19;

	const critical =
		natural &&
		p.action === "main" &&
		ability !== undefined &&
		actionKindOf(ability) === "main" &&
		paidFor.combat.acting === p.id;

	const next = withAction(paidFor, p.id, p.action, critical ? 1 : 0);

	const notes = [
		...orEmpty(EDGE_NOTES.get(net)),
		...listIf(natural, () => [`natural ${p.dice[0] + p.dice[1]}`]),
		...listIf(critical, () => ["extra main action"]),
	];

	const said = sentences([
		tierText,
		ability?.effect === undefined ? undefined : `Effect: ${ability.effect}`,
	]);

	const reach = ability === undefined ? undefined : reachOf(ability);

	const far = targets.flatMap((t) =>
		reach !== undefined && t.apart !== undefined && t.apart > reach
			? [`${t.name} is ${plural(t.apart, "square")} away`]
			: []
	);

	const stop = ability?.effect === undefined ? "" : ".";
	const spoken = said === "" ? "" : ` · ${said}${stop}`;

	const text = [
		head,
		`[${p.dice[0]}, ${p.dice[1]}]`,
		...listIf(p.bonus !== 0, () => [signed(p.bonus)]),
		...orEmpty(EDGE_BONUS.get(net)),
		`= ${p.total}${notes.length > 0 ? `, ${notes.join(", ")}` : ""}${modifierText(slice, envelope, p)}`,
		`· tier ${p.tier}${spoken}`,
		...listIf(far.length > 0, () => [
			`(${far.join("; ")}; ${ability?.distance})`,
		]),
	].join(" ");

	return { slice: next, feed: { kind: "ds-roll", text } };
};

const abilityUsed = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const p = decode("ds.ability-used", envelope);
	const found = who(slice, envelope, p.id);

	if (!isSafe(p.ability)) {
		bad(envelope, "holds control characters");
	}

	const effect = abilitiesOf(slice, found).find(
		(a) => a.name === p.ability
	)?.effect;

	const { next: paidFor, paid } = spend(slice, envelope, found, p.cost);
	const next = withAction(paidFor, p.id, p.action);
	const text = `${found.name} uses ${p.ability}${paid}${effect === undefined ? "." : `: ${effect}`}`;

	return { slice: next, feed: { kind: "ds-roll", text } };
};

const bled = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, roll, level } = decode("ds.bled", envelope);
	const found = who(slice, envelope, id);

	if (roll < 1 || roll > 6) {
		bad(envelope, `has a d6 of ${roll}`);
	}

	if (level < 0) {
		bad(envelope, "has a negative level");
	}

	const loss = roll + level;

	const lost = withWho(slice, envelope, id, (x) => ({
		...x,
		stamina: "sheet" in x ? x.stamina - loss : Math.max(0, x.stamina - loss),
	}));

	const next = buried(slice, lost, id);

	return {
		slice: next,
		feed: {
			kind: "ds",
			text: `${found.name} bleeds and loses ${loss} Stamina (1d6: ${roll}, + level ${level}) → ${meter(next, id)}`,
		},
	};
};

const windedTraits = (
	before: Who,
	after: Who | undefined,
	slice: DrawSteelState
): string => {
	if (before.kind !== "creature" || after?.kind !== "creature") {
		return "";
	}

	if (creatureHealth(before.creature) !== undefined) {
		return "";
	}

	if (creatureHealth(after.creature) !== "winded") {
		return "";
	}

	return (slice.blocks[after.creature.block]?.abilities ?? [])
		.flatMap((a) =>
			isTrait(a) && WINDED_TRAIT.test(a.effect ?? "")
				? [` · ${a.name}: ${a.effect ?? ""}`]
				: []
		)
		.join("");
};

const damageDetails = (
	p: Payload<"ds.damaged">,
	fromTemp: number
): ReadonlyArray<string> => {
	const weakness = p.weakness === undefined ? "" : ` +${p.weakness} weakness`;
	const immunity = p.immunity === undefined ? "" : ` -${p.immunity} immunity`;

	return [
		...listIf(p.weakness !== undefined || p.immunity !== undefined, () => [
			`${p.amount}${weakness}${immunity}`,
		]),
		...listIf(fromTemp > 0, () => [`${fromTemp} to temporary Stamina`]),
	];
};

const squadNote = (before: number, after: Who | undefined): string => {
	if (after?.kind !== "creature" || after.creature.squad === undefined) {
		return "";
	}

	const left = minionsLeft(after.creature);
	const died = before - left;

	if (left === 0) {
		return " · the squad is dead";
	}

	const verb = died === 1 ? "dies" : "die";

	return died > 0 ? ` · ${plural(died, "minion")} ${verb}, ${left} left` : "";
};

const strikeSource = (
	slice: DrawSteelState,
	p: Payload<"ds.damaged">
): string => {
	if (p.source === undefined) {
		return "";
	}

	const together =
		p.minions === undefined ? "" : ` (${plural(p.minions, "minion")})`;

	const far =
		p.apart !== undefined && p.apart > 1
			? ` from ${plural(p.apart, "square")} away`
			: "";

	return `${nameOf(slice, p.source)} free strikes${together}${far}: `;
};

const WINDED_TRAIT = /half (?:its |their )?stamina|winded/iu;

const damaged = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const p = decode("ds.damaged", envelope);
	const target = who(slice, envelope, p.id);

	if (p.dealt < 0 || p.amount < 0) {
		bad(envelope, "deals negative damage");
	}

	if (p.type !== undefined && !isSafe(p.type)) {
		bad(envelope, "holds control characters");
	}

	const temp = target.kind === "hero" ? target.hero.temp : target.creature.temp;
	const fromTemp = Math.min(temp, p.dealt);
	const before = target.kind === "creature" ? minionsLeft(target.creature) : 0;

	const hit = withWho(slice, envelope, p.id, (x) => ({
		...x,
		temp: x.temp - fromTemp,
		stamina:
			"sheet" in x
				? x.stamina - (p.dealt - fromTemp)
				: Math.max(0, x.stamina - (p.dealt - fromTemp)),
	}));

	const next = buried(slice, hit, p.id);
	const details = damageDetails(p, fromTemp);
	const after = findWho(next, p.id);
	const squad = squadNote(before, after);

	if (p.minions !== undefined && p.minions < 1) {
		bad(envelope, "has a squad strike of no minions");
	}

	const source = strikeSource(slice, p);
	const text = `${source}${target.name} takes ${p.dealt}${p.type === undefined ? "" : ` ${p.type}`} damage${details.length > 0 ? ` (${details.join("; ")})` : ""} → ${meter(next, p.id)}${squad}${windedTraits(target, after, next)}`;

	return { slice: next, feed: { kind: "ds", text } };
};

const healed = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, amount } = decode("ds.healed", envelope);
	const target = who(slice, envelope, id);

	if (amount < 0) {
		bad(envelope, "heals a negative amount");
	}

	if (target.kind === "creature" && target.creature.squad !== undefined) {
		bad(envelope, "heals minions");
	}

	const [stamina, max] =
		target.kind === "hero"
			? [target.hero.stamina, target.hero.sheet.stamina]
			: [target.creature.stamina, target.creature.max];

	if (stamina + amount > max) {
		bad(envelope, `heals '${id}' past full Stamina`);
	}

	const next = withWho(slice, envelope, id, (x) => ({
		...x,
		stamina: x.stamina + amount,
	}));

	return {
		slice: next,
		feed: {
			kind: "ds",
			text: `${target.name} regains ${amount} Stamina → ${meter(next, id)}`,
		},
	};
};

const tempSet = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, temp } = decode("ds.temp-set", envelope);
	const target = who(slice, envelope, id);

	if (temp < 0) {
		bad(envelope, "sets negative temporary Stamina");
	}

	const next = withWho(slice, envelope, id, (x) => ({ ...x, temp }));

	return {
		slice: next,
		feed: { kind: "ds", text: `${target.name} has ${temp} temporary Stamina.` },
	};
};

const recovered = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, amount, ally } = decode("ds.recovered", envelope);
	const h = hero(slice, envelope, id);

	if (h.recoveries < 1) {
		bad(envelope, "spends a Recovery the hero doesn't have");
	}

	if (amount < 0) {
		bad(envelope, "heals a negative amount");
	}

	const next = withHero(slice, id, (x) => ({
		...x,
		stamina: x.stamina + amount,
		recoveries: x.recoveries - 1,
	}));

	const how = ally ? " through an ally" : "";

	return {
		slice: next,
		feed: {
			kind: "ds",
			text: `${h.sheet.name} spends a Recovery${how} and regains ${amount} Stamina → ${meter(next, id)} (${h.recoveries - 1}/${h.sheet.recoveries} left)`,
		},
	};
};

const conditionSet = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, condition, duration, by } = decode("ds.condition-set", envelope);
	const target = who(slice, envelope, id);
	const source = by === undefined ? undefined : who(slice, envelope, by);

	const set: Condition =
		by === undefined
			? { name: condition, duration }
			: { name: condition, duration, by };

	const reset = (conditions: ReadonlyArray<Condition>) =>
		conditions.map((c) => (c.name === condition ? set : c));

	const next = withWho(slice, envelope, id, (x) => ({
		...x,
		conditions: x.conditions.some((c) => c.name === condition)
			? reset(x.conditions)
			: [...x.conditions, set],
	}));

	return {
		slice: next,
		feed: {
			kind: "ds",
			text: `${target.name} is ${condition}${source === undefined ? "" : ` by ${source.name}`}${durationText(set)}.`,
		},
	};
};

const conditionRemoved = (
	slice: DrawSteelState,
	envelope: Envelope
): Applied => {
	const { id, condition } = decode("ds.condition-removed", envelope);
	const target = who(slice, envelope, id);

	const next = withWho(slice, envelope, id, (x) => ({
		...x,
		conditions: x.conditions.filter((c) => c.name !== condition),
	}));

	return {
		slice: next,
		feed: { kind: "ds", text: `${target.name} is no longer ${condition}.` },
	};
};

const saved = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, condition, roll, ends } = decode("ds.saved", envelope);
	const target = who(slice, envelope, id);

	if (roll < 1 || roll > 10) {
		bad(envelope, `has a d10 of ${roll}`);
	}

	const next = ends
		? withWho(slice, envelope, id, (x) => ({
				...x,
				conditions: x.conditions.filter((c) => c.name !== condition),
			}))
		: slice;

	const text = ends
		? `${target.name} saves against ${condition}: ${roll}, it ends.`
		: `${target.name} fails a save against ${condition}: ${roll}.`;

	return { slice: next, feed: { kind: "ds-roll", text } };
};

const gainOrSpend = (name: string, by: number, what: string, after: number) =>
	`${name} ${by > 0 ? "gains" : "spends"} ${what} → ${after}.`;

const resourceChanged = (
	slice: DrawSteelState,
	envelope: Envelope
): Applied => {
	const { id, by } = decode("ds.resource-changed", envelope);
	const h = hero(slice, envelope, id);

	const next = withHero(slice, id, (x) => ({
		...x,
		resource: x.resource + by,
	}));

	return {
		slice: next,
		feed: {
			kind: "ds",
			text: gainOrSpend(
				h.sheet.name,
				by,
				`${Math.abs(by)} ${h.sheet.resource.name}`,
				h.resource + by
			),
		},
	};
};

const surgesChanged = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, by } = decode("ds.surges-changed", envelope);
	const h = hero(slice, envelope, id);

	if (h.surges + by < 0) {
		bad(envelope, "spends surges the hero doesn't have");
	}

	const next = withHero(slice, id, (x) => ({ ...x, surges: x.surges + by }));

	return {
		slice: next,
		feed: {
			kind: "ds",
			text: gainOrSpend(
				h.sheet.name,
				by,
				plural(Math.abs(by), "surge"),
				h.surges + by
			),
		},
	};
};

const maliceChanged = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { by, reason } = decode("ds.malice-changed", envelope);

	if (slice.malice + by < 0) {
		bad(envelope, "spends Malice the Director doesn't have");
	}

	if (reason !== undefined && !isSafe(reason)) {
		bad(envelope, "holds control characters");
	}

	const malice = slice.malice + by;
	const why = reason === undefined ? "" : ` (${reason})`;

	return {
		slice: { ...slice, malice },
		feed: { kind: "ds", text: `Malice ${signed(by)}${why} → ${malice}.` },
	};
};

const tokensChanged = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { by } = decode("ds.tokens-changed", envelope);

	if (slice.tokens + by < 0) {
		bad(envelope, "spends hero tokens the party doesn't have");
	}

	const tokens = slice.tokens + by;

	const text =
		by < 0
			? `spends ${plural(-by, "hero token")} → ${tokens}.`
			: `gives the party ${plural(by, "hero token")} → ${tokens}.`;

	return { slice: { ...slice, tokens }, feed: { kind: "ds-act", text } };
};

const tokensReset = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { tokens } = decode("ds.tokens-reset", envelope);

	if (tokens < 0) {
		bad(envelope, "sets negative hero tokens");
	}

	return {
		slice: { ...slice, tokens },
		feed: { kind: "ds", text: `Hero tokens reset to ${tokens}, one per hero.` },
	};
};

const victoriesChanged = (
	slice: DrawSteelState,
	envelope: Envelope
): Applied => {
	const { ids, by } = decode("ds.victories-changed", envelope);
	let next = slice;

	for (const id of ids) {
		const h = hero(slice, envelope, id);

		if (h.victories + by < 0) {
			bad(envelope, "takes Victories below 0");
		}

		next = withHero(next, id, (x) => ({ ...x, victories: x.victories + by }));
	}

	const list = ids.map((id) => {
		const h = hero(next, envelope, id);

		return `${h.sheet.name} ${h.victories}`;
	});

	return {
		slice: next,
		feed: { kind: "ds", text: `Victories ${signed(by)}: ${list.join(", ")}.` },
	};
};

const boardOf = (slice: DrawSteelState, envelope: Envelope): Board =>
	slice.map ?? bad(envelope, "comes with no map loaded");

const withToken = (
	slice: DrawSteelState,
	board: Board,
	id: string,
	at: Square
): DrawSteelState => ({
	...slice,
	map: { ...board, tokens: { ...board.tokens, [id]: at } },
});

const checkFree = (
	slice: DrawSteelState,
	envelope: Envelope,
	board: Board,
	id: string,
	at: Square
): void => {
	const taken = occupants(slice, board, id);
	const footprint = footprintOfWho(slice, who(slice, envelope, id));

	for (const square of squaresOf(at, footprint)) {
		const there = taken(square);

		if (there !== undefined) {
			bad(
				envelope,
				`puts '${id}' at ${formatSquare(at)}, where '${there.id}' stands`
			);
		}
	}
};

const standsOn = (
	board: Board,
	at: Square,
	footprint: ReturnType<typeof footprintOfWho>
): boolean =>
	squaresOf(at, footprint).every((square) => standable(board.terrain, square));

const checkPath = (
	slice: DrawSteelState,
	envelope: Envelope,
	board: Board,
	id: string,
	from: Square,
	path: ReadonlyArray<Square>
): void => {
	const footprint = footprintOfWho(slice, who(slice, envelope, id));
	let here = from;

	for (const square of path) {
		if (distance(here, square) !== 1 || !standsOn(board, square, footprint)) {
			bad(envelope, `has a path that can't go to ${formatSquare(square)}`);
		}

		here = square;
	}
};

const mapLoaded = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, name, terrain, dressing } = decode("ds.map-loaded", envelope);

	const why = malformed({
		name,
		terrain,
		...ifDefined(dressing, (value) => ({ dressing: value })),
	});

	if (why !== undefined) {
		bad(envelope, `has a bad grid: ${why}`);
	}

	const width = terrain[0]?.length ?? 0;

	return {
		slice: {
			...slice,
			map: {
				id,
				name,
				terrain: [...terrain],
				...ifDefined(dressing, (value) => ({ dressing: [...value] })),
				tokens: {},
			},
		},
		feed: {
			kind: "ds",
			text: `The map is ${name}, ${width} by ${terrain.length}.`,
		},
	};
};

const mapCleared = (slice: DrawSteelState, envelope: Envelope): Applied => {
	decode("ds.map-cleared", envelope);
	boardOf(slice, envelope);
	const { map: _map, ...rest } = slice;

	return { slice: rest, feed: { kind: "ds", text: "The map is put away." } };
};

const placed = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, at } = decode("ds.placed", envelope);
	const board = boardOf(slice, envelope);
	const found = who(slice, envelope, id);

	if (!standsOn(board, at, footprintOfWho(slice, found))) {
		bad(envelope, `places '${id}' where nobody can stand`);
	}

	checkFree(slice, envelope, board, id, at);

	return {
		slice: withToken(slice, board, id, at),
		feed: {
			kind: "ds",
			text: `${found.name} is placed at ${formatSquare(at)}.`,
		},
	};
};

const movedActions = (
	combat: Combat,
	id: string,
	main: boolean
): TurnActions => {
	const wasMain = combat.moved?.id === id && combat.moved.main;

	const actions =
		combat.actions?.id === id ? combat.actions : startedActions(id);

	return {
		...actions,
		move: Math.max(1, actions.move),
		main: actions.main + (main && !wasMain ? 1 : 0),
	};
};

const moved = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { id, path, cost, speed, spent, allowance, main } = decode(
		"ds.moved",
		envelope
	);

	const board = boardOf(slice, envelope);
	const found = who(slice, envelope, id);

	const from =
		board.tokens[id] ?? bad(envelope, `moves '${id}', who isn't on the map`);

	const to = path.at(-1) ?? bad(envelope, "has an empty path");
	checkPath(slice, envelope, board, id, from, path);
	checkFree(slice, envelope, board, id, to);

	if (cost < path.length) {
		bad(envelope, "costs less than its squares");
	}

	let next = withToken(slice, board, id, to);
	let turn = "";
	let over = cost > speed ? `, over speed ${speed}` : "";

	if (spent !== undefined || allowance !== undefined) {
		if (spent === undefined || allowance === undefined) {
			bad(envelope, "has half a turn's movement");
		}

		if (slice.combat.acting !== id) {
			bad(envelope, `counts a turn '${id}' isn't taking`);
		}

		if (spent < cost) {
			bad(envelope, "spends less than it moves");
		}

		next = {
			...next,
			combat: {
				...next.combat,
				moved: { id, spent, main: main === true },
				actions: movedActions(slice.combat, id, main === true),
			},
		};

		if (spent > cost || main === true) {
			turn = `, ${spent} of ${allowance} this turn${main === true ? " with the main action" : ""}`;
		}

		over = spent > allowance ? `, over speed ${speed}` : "";
	}

	return {
		slice: next,
		feed: {
			kind: "ds",
			text: `${found.name} moves to ${formatSquare(to)} (${plural(cost, "square")} of movement${turn}${over}).`,
		},
	};
};

const FORCED_VERBS = { push: "pushed", pull: "pulled", slide: "slid" } as const;

const parenthesis = (parts: ReadonlyArray<string>) => {
	const said = parts.filter((p) => p !== "");

	return said.length === 0 ? "" : ` (${said.join("; ")})`;
};

const forceMoved = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const p = decode("ds.force-moved", envelope);
	const board = boardOf(slice, envelope);
	const found = who(slice, envelope, p.id);

	const from =
		board.tokens[p.id] ??
		bad(envelope, `moves '${p.id}', who isn't on the map`);

	if (p.from !== undefined && !sameSquare(p.from, from)) {
		bad(
			envelope,
			`moves '${p.id}' from ${formatSquare(p.from)}, but they stand at ${formatSquare(from)}`
		);
	}

	checkPath(slice, envelope, board, p.id, from, p.path);

	if (p.slam !== undefined && p.slam.remaining < 1) {
		bad(envelope, "slams with nothing left");
	}

	const slammed = p.slam?.into;

	const into =
		slammed === undefined || slammed === "wall"
			? "a wall"
			: who(slice, envelope, slammed).name;

	const to = p.path.at(-1);

	if (to !== undefined) {
		checkFree(slice, envelope, board, p.id, to);
	}

	const verb = FORCED_VERBS[p.kind];
	const by = p.source === undefined ? "" : ` by ${nameOf(slice, p.source)}`;

	const text = [
		`${found.name} is ${verb}`,
		to === undefined
			? `${by} but doesn't move`
			: ` ${plural(p.path.length, "square")}${by} to ${formatSquare(to)}`,
		p.slam === undefined
			? ""
			: ` and slams into ${into} with ${plural(p.slam.remaining, "square")} to go`,
		p.edge === true ? ", stopped by the map's edge" : "",
		parenthesis([
			p.stability > 0
				? `${p.kind} ${p.distance}, stability ${p.stability}`
				: "",
			p.apart !== undefined && p.apart > 1
				? `${plural(p.apart, "square")} away`
				: "",
		]),
		".",
	].join("");

	return {
		slice: to === undefined ? slice : withToken(slice, board, p.id, to),
		feed: { kind: "ds", text },
	};
};

const measured = (slice: DrawSteelState, envelope: Envelope): Applied => {
	const { from, to, distance: squares } = decode("ds.measured", envelope);

	if (squares < 0) {
		bad(envelope, "measures a negative distance");
	}

	const label = (point: { readonly id?: string; readonly at: Square }) =>
		point.id === undefined
			? formatSquare(point.at)
			: `${who(slice, envelope, point.id).name} (${formatSquare(point.at)})`;

	return {
		slice,
		feed: {
			kind: "ds-act",
			text: `measures ${label(from)} to ${label(to)}: ${plural(squares, "square")}.`,
		},
	};
};

type Applier = (slice: DrawSteelState, envelope: Envelope) => Applied;

const appliers = {
	"ds.hero-joined": heroJoined,
	"ds.hero-claimed": heroClaimed,
	"ds.hero-released": heroReleased,
	"ds.creatures-added": creaturesAdded,
	"ds.combat-started": combatStarted,
	"ds.first-set": firstSet,
	"ds.round-started": roundStarted,
	"ds.turn-started": turnStarted,
	"ds.turn-ended": turnEnded,
	"ds.combat-ended": combatEnded,
	"ds.rested": rested,
	"ds.power-rolled": powerRolled,
	"ds.ability-used": abilityUsed,
	"ds.bled": bled,
	"ds.damaged": damaged,
	"ds.healed": healed,
	"ds.temp-set": tempSet,
	"ds.recovered": recovered,
	"ds.condition-set": conditionSet,
	"ds.condition-removed": conditionRemoved,
	"ds.saved": saved,
	"ds.resource-changed": resourceChanged,
	"ds.surges-changed": surgesChanged,
	"ds.malice-changed": maliceChanged,
	"ds.tokens-changed": tokensChanged,
	"ds.tokens-reset": tokensReset,
	"ds.victories-changed": victoriesChanged,
	"ds.map-loaded": mapLoaded,
	"ds.map-cleared": mapCleared,
	"ds.placed": placed,
	"ds.moved": moved,
	"ds.force-moved": forceMoved,
	"ds.measured": measured,
} as const satisfies Record<EventType, Applier>;

export const apply = (slice: DrawSteelState, envelope: Envelope): Applied => {
	if (!isEventType(envelope.type)) {
		throw new Error(`ds can't apply "${envelope.type}"`);
	}

	return appliers[envelope.type](slice, envelope);
};
