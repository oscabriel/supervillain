import type { TokenAction } from "../../actions.ts";
import { signed } from "../../dice.ts";
import { partyFirst, prepMaps, prepSteps } from "../../prep.ts";
import type { PrepCatalog, PrepItem, PrepView } from "../../prep.ts";
import {
	ifDefined,
	listIf,
	listIfDefined,
	orEmpty,
	when,
} from "../../present.ts";
import type { MapToken, MapView } from "../board/view.ts";
import type { Combatant, CombatView } from "../drawSteel/view.ts";
import type { Refused } from "../engine.ts";
import { reachableFrom } from "./board.ts";
import { isBroken, mapPenaltyFor, maxActions } from "./combat.ts";
import { ADD_MAX } from "./commands.ts";
import { budgetFor, creatureXp, THREATS, threatOf } from "./math.ts";
import { hasTrait, spaceOf } from "./sheets.ts";
import type { PfAbility, PfSheet } from "./sheets.ts";
import {
	controls,
	creatureOf,
	findCreature,
	hasReacted,
	isDead,
	isPc,
	mapSide,
	marksOf,
	partyLevel,
	resolveCreature,
} from "./state.ts";
import type { PfCondition, PfCreature, PfState } from "./state.ts";

const conditionText = (k: PfCondition): string =>
	`${k.name}${k.value === undefined ? "" : ` ${k.value}`}`;

const countersOf = (c: PfCreature): ReadonlyArray<string> => [
	...listIf(c.dying > 0, () => [`dying ${c.dying}`]),
	...listIf(c.wounded > 0, () => [`wounded ${c.wounded}`]),
	...listIf(c.doomed > 0, () => [`doomed ${c.doomed}`]),
];

const shown = (slice: PfState): ReadonlyArray<PfCreature> => {
	const { combat } = slice;

	if (combat === undefined) {
		return slice.creatures;
	}

	const inOrder = combat.order.flatMap((id) => {
		const c = findCreature(slice, id);

		return c === undefined ? [] : [c];
	});

	const delayed = combat.delayed.flatMap((id) => {
		const c = findCreature(slice, id);

		return c === undefined ? [] : [c];
	});

	const listed = new Set([...combat.order, ...combat.delayed]);

	return [
		...inOrder,
		...delayed,
		...slice.creatures.filter((c) => !listed.has(c.id)),
	];
};

const healthOf = (c: PfCreature): Pick<Combatant, "health"> => {
	if (isDead(c)) {
		return { health: "dead" };
	}

	return c.dying > 0 ? { health: "dying" } : {};
};

export const pfBand = (
	slice: PfState,
	actor: string,
	labelOf?: (actor: string) => string
): CombatView | undefined => {
	const { combat } = slice;

	if (combat === undefined && !slice.creatures.some(isPc)) {
		return undefined;
	}

	const marks = slice.map === undefined ? undefined : marksOf(slice.creatures);
	const turn = combat?.turn;

	const combatant = (c: PfCreature): Combatant => {
		const player =
			c.player !== undefined && c.player !== actor
				? labelOf?.(c.player)
				: undefined;

		const mark = c.at === undefined ? undefined : marks?.get(c.id);
		const acting = turn?.id === c.id;
		const map = acting ? mapPenaltyFor(c, turn.attacks) : 0;
		const delayed = (combat?.delayed ?? []).includes(c.id);

		return {
			id: c.id,
			name: player === undefined ? c.name : `${c.name} (${player})`,
			side: mapSide(c),
			stamina: c.hp,
			max: c.sheet.hp,
			temp: c.temp,
			...healthOf(c),
			conditions: [
				...countersOf(c),
				...c.conditions.map(conditionText),
				...c.persistent.map((p) => `persistent ${p.damageType} ${p.dice}`),
				...listIf(delayed, () => ["delaying"]),
				...listIf(c.shield?.raised === true, () => ["shield raised"]),
			],
			...when(isPc(c), () => ({ resource: `hero points ${c.heroPoints}` })),
			acted: false,
			acting,
			mine: c.player === actor,
			...when(isPc(c) && c.player === undefined && !isDead(c), () => ({
				free: true,
			})),
			...ifDefined(mark, (value) => ({ mark: value })),
			...when(combat !== undefined, () => ({
				actions: {
					left: acting ? turn.actions : 0,
					max: acting ? turn.max : maxActions(c),
					reaction: !hasReacted(slice, c.id),
				},
			})),
			...when(map !== 0, () => ({ penalty: `MAP ${map}` })),
		};
	};

	const acting = turn === undefined ? undefined : findCreature(slice, turn.id);

	return {
		round: combat?.round ?? 0,
		active: combat !== undefined,
		malice: 0,
		heroTokens: 0,
		meterLabel: "HP",
		title:
			combat === undefined
				? " party "
				: ` round ${combat.round}${acting === undefined ? "" : ` · ${acting.name}'s turn`} `,
		combatants: shown(slice).map(combatant),
	};
};

const standing = (c: PfCreature | undefined): PfCreature | undefined =>
	c !== undefined && c.at !== undefined && !isDead(c) ? c : undefined;

const reachFor = (slice: PfState, actor: string): PfCreature | undefined => {
	const id = slice.combat?.turn?.id;
	const acting = id === undefined ? undefined : findCreature(slice, id);

	return standing(acting) ?? standing(creatureOf(slice, actor));
};

export const pfMap = (slice: PfState, actor: string): MapView | undefined => {
	const { map } = slice;

	if (map === undefined) {
		return undefined;
	}

	const marks = marksOf(slice.creatures);

	const tokens = slice.creatures.flatMap((c): Array<MapToken> => {
		if (c.at === undefined) {
			return [];
		}

		const space = spaceOf(c.sheet.size);

		return [
			{
				id: c.id,
				mark: marks.get(c.id) ?? "??",
				name: c.name,
				x: c.at.x,
				y: c.at.y,
				side: mapSide(c),
				...ifDefined(c.block, (block) => ({ figure: block })),
				...when(space.footprint > 1, () => ({ footprint: space.footprint })),
				...when(space.tiny, () => ({ tiny: true })),
				mine: c.player === actor,
				acting: slice.combat?.turn?.id === c.id,
				dead: isDead(c),
			},
		];
	});

	const subject = reachFor(slice, actor);
	const turn = slice.combat?.turn;

	const own =
		subject !== undefined && turn?.id === subject.id ? turn : undefined;

	const speed = subject?.sheet.speed ?? 0;
	const parity = own?.diagonalParity ?? 0;

	const reach =
		subject === undefined || (own !== undefined && own.actions < 1)
			? []
			: reachableFrom(slice, subject, speed, parity);

	return {
		name: map.name,
		width: map.terrain[0]?.length ?? 0,
		height: map.terrain.length,
		terrain: map.terrain,
		...ifDefined(map.dressing, (value) => ({ dressing: value })),
		tokens: [...tokens.filter((t) => t.dead), ...tokens.filter((t) => !t.dead)],
		reach,
		...ifDefined(subject, (value) => ({
			reachLabel: `${value.name} can Stride ${speed} ft${parity === 1 ? ", next diagonal 10 ft" : ""}`,
		})),
	};
};

const strikeText = (s: PfSheet["strikes"][number]): string => {
	const traits =
		s.traits === undefined || s.traits.length === 0
			? ""
			: ` (${s.traits.join(", ")})`;

	const range = s.range === undefined ? "" : `, range ${s.range} ft`;

	return `${s.range === undefined ? "Melee" : "Ranged"} ◆ ${s.name} ${signed(s.bonus) || "+0"}${traits}${range}, ${s.damage} ${s.damageType}`;
};

const amounts = (
	label: string,
	list:
		| ReadonlyArray<{ readonly type: string; readonly value: number }>
		| undefined
): ReadonlyArray<string> =>
	list === undefined || list.length === 0
		? []
		: [`${label} ${list.map((a) => `${a.type} ${a.value}`).join(", ")}`];

const bonusText = (n: number): string => signed(n) || "+0";

const headLine = (c: PfCreature): string => {
	const s = c.sheet;
	const kind = [s.ancestry, s.class].filter((x) => x !== undefined).join(" ");
	const traits = orEmpty(s.traits);
	const adjusted = c.adjustment === undefined ? "" : ` (${c.adjustment})`;
	const trailing = traits.length === 0 ? "" : ` · ${traits.join(", ")}`;

	return `${c.name}${adjusted} · ${kind === "" ? "Creature" : kind} ${s.level} · ${s.size}${trailing}`;
};

const defenceLine = (c: PfCreature): string => {
	const s = c.sheet;
	const immune = orEmpty(s.immunities);

	const defences = [
		...listIf(immune.length > 0, () => [`Immunities ${immune.join(", ")}`]),
		...amounts("Weaknesses", s.weaknesses),
		...amounts("Resistances", s.resistances),
	];

	const temp = c.temp > 0 ? ` (+${c.temp} temp)` : "";

	return `HP ${c.hp}/${s.hp}${temp}${defences.length === 0 ? "" : `; ${defences.join("; ")}`}`;
};

const shieldLine = (c: PfCreature): ReadonlyArray<string> =>
	listIfDefined(c.sheet.shield, (stats) => [
		`Shield +${stats.bonus} (Hardness ${stats.hardness}, HP ${c.shield?.hp ?? 0}/${stats.hp}, BT ${stats.broken})${isBroken(c) ? " broken" : ""}`,
	]);

const spellLine = (c: PfCreature): ReadonlyArray<string> =>
	listIfDefined(c.sheet.spells, (spells) => {
		const tradition =
			spells.tradition === undefined ? "" : ` (${spells.tradition})`;

		const dc = spells.dc === undefined ? "" : ` DC ${spells.dc}`;

		const attack =
			spells.attack === undefined ? "" : `, attack ${bonusText(spells.attack)}`;

		const list = spells.list
			.map(
				(sp) => `${sp.name} (${sp.rank === 0 ? "cantrip" : `rank ${sp.rank}`})`
			)
			.join(", ");

		return [`Spells${tradition}${dc}${attack}: ${list}`];
	});

const abilityText = (ab: PfAbility): string => {
	const actions = ab.actions === undefined ? "" : ` [${ab.actions}]`;

	return `${ab.name}${actions}${ab.text === undefined ? "" : `: ${ab.text}`}`;
};

export const sheetLines = (c: PfCreature): ReadonlyArray<string> => {
	const s = c.sheet;
	const a = s.attributes;
	const counters = countersOf(c);
	const skills = s.skills.map((k) => `${k.name} ${bonusText(k.bonus)}`);
	const classDc = s.classDc === undefined ? "" : `; class DC ${s.classDc}`;

	return [
		headLine(c),
		`Perception ${bonusText(s.perception)}; Skills ${skills.length === 0 ? "none" : skills.join(", ")}`,
		`Str ${bonusText(a.str)}, Dex ${bonusText(a.dex)}, Con ${bonusText(a.con)}, Int ${bonusText(a.int)}, Wis ${bonusText(a.wis)}, Cha ${bonusText(a.cha)}`,
		`AC ${s.ac}; Fort ${bonusText(s.saves.fort)}, Ref ${bonusText(s.saves.ref)}, Will ${bonusText(s.saves.will)}${classDc}`,
		defenceLine(c),
		...shieldLine(c),
		`Speed ${s.speed} ft`,
		...s.strikes.map(strikeText),
		...orEmpty(s.abilities).map(abilityText),
		...spellLine(c),
		...listIf(isPc(c), () => [
			`Hero Points ${c.heroPoints}${counters.length === 0 ? "" : ` · ${counters.join(", ")}`}`,
		]),
	];
};

export const pfSheet = (slice: PfState, typed: string): string | Refused => {
	const c = resolveCreature(slice, typed);

	return "refusal" in c ? c : sheetLines(c).join("\n");
};

export const withPcs =
	(slice: PfState, labelOf: (actor: string) => string) =>
	(actor: string): string => {
		const own = creatureOf(slice, actor);

		return own === undefined
			? labelOf(actor)
			: `${labelOf(actor)} (${own.name})`;
	};

const firstWord = (name: string): string =>
	(name.split(/\s+/u)[0] ?? name).toLowerCase();

const boardMoves = (
	c: PfCreature,
	onMap: boolean
): ReadonlyArray<TokenAction> => {
	if (!onMap) {
		return [];
	}

	return c.at === undefined
		? [{ label: "Place", pick: "square", line: `/place ${c.id}` }]
		: [
				{ label: "Stride ◆", pick: "square", line: `/stride ${c.id}` },
				{ label: "Step ◆", pick: "square", line: `/step ${c.id}` },
			];
};

export const pfActions = (
	slice: PfState,
	actor: string,
	id: string
): ReadonlyArray<TokenAction> | undefined => {
	const c = findCreature(slice, id);

	if (c === undefined || !controls(actor, c)) {
		return undefined;
	}

	const onMap = slice.map !== undefined;
	const acting = slice.combat?.turn?.id === c.id;

	const move = boardMoves(c, onMap);

	return [
		...c.sheet.strikes.map((s): TokenAction => ({
			label: `Strike ◆ ${s.name}${hasTrait(s.traits, "agile") ? " (agile)" : ""}`,
			pick: "target",
			line: `/strike ${c.id} ${firstWord(s.name)}`,
		})),
		...move,
		...listIf(c.sheet.shield !== undefined && !isBroken(c), () => [
			{
				label: "Raise a Shield ◆",
				pick: "none" as const,
				line: `/shield ${c.id}`,
			},
		]),
		{ label: "Demoralize ◆", pick: "target", line: `/demoralize ${c.id}` },
		{ label: "Grapple ◆", pick: "target", line: `/grapple ${c.id}` },
		{ label: "Trip ◆", pick: "target", line: `/trip ${c.id}` },
		{ label: "Shove ◆", pick: "target", line: `/shove ${c.id}` },
		...(c.sheet.spells?.list ?? []).map((sp): TokenAction => ({
			label: `Cast ${sp.name}`,
			pick: sp.heal === undefined ? "targets" : "none",
			line: `/cast ${c.id} ${sp.name.toLowerCase()}`,
		})),
		...listIf(acting, () => [
			{ label: "Delay", pick: "none" as const, line: "/delay" },
			{ label: "End turn", pick: "none" as const, line: "/done" },
		]),
	];
};

export const encounterXp = (slice: PfState): number => {
	const level = partyLevel(slice);

	return slice.creatures
		.filter((c) => c.kind === "npc" && !isDead(c))
		.reduce((n, c) => n + creatureXp(c.sheet.level, level), 0);
};

export const pfPrep = (slice: PfState, catalog: PrepCatalog): PrepView => {
	const alive = slice.creatures.filter((c) => !isDead(c));
	const party = slice.creatures.filter(isPc);
	const size = Math.max(1, party.length);
	const xp = encounterXp(slice);
	const threat = threatOf(xp, size);
	const inPlay = new Set(party.map((c) => c.id));
	const joining = catalog.heroes.filter((h) => !inPlay.has(h.id));

	const added = (block: string) =>
		slice.creatures.filter((c) => c.block === block).length;

	const monsterItems = catalog.monsters.flatMap(
		(m): ReadonlyArray<PrepItem> => {
			const n = added(m.id);
			const figure = { id: m.id, side: "director" as const };

			return [
				{
					kind: "count",
					label: m.name,
					line: `/add ${m.id}`,
					max: ADD_MAX,
					figure,
					...when(n > 0, () => ({ note: `×${n}` })),
				},
				{
					kind: "count",
					label: `${m.name} (elite)`,
					line: `/add ${m.id} elite`,
					max: ADD_MAX,
					figure,
				},
				{
					kind: "count",
					label: `${m.name} (weak)`,
					line: `/add ${m.id} weak`,
					max: ADD_MAX,
					figure,
				},
			];
		}
	);

	return {
		steps: [
			...prepSteps(
				slice.map !== undefined,
				alive.map((c) => ({ side: mapSide(c), placed: c.at !== undefined }))
			),
			{ label: `${threat} ${xp} XP`, done: xp > 0 },
		],
		maps: prepMaps(catalog, slice.map),
		place:
			slice.map === undefined
				? []
				: partyFirst(
						alive
							.filter((c) => c.at === undefined)
							.map((c) => ({
								id: c.id,
								name: c.name,
								figure: { id: c.block ?? c.id, side: mapSide(c) },
							}))
					),
		sections: [
			{
				title: "party",
				items: joining.map((h): PrepItem => ({
					kind: "send",
					label: h.name,
					line: `/pc ${h.id}`,
					figure: { id: h.id, side: "heroes" },
				})),
				...when(catalog.heroes.length === 0, () => ({
					note: "no sheets in heroes/",
				})),
				...when(joining.length > 1, () => ({
					all: joining.map((h) => `/pc ${h.id}`),
				})),
			},
			{
				title: "foes",
				items: monsterItems,
				...when(catalog.monsters.length === 0, () => ({
					note: "no stat blocks in monsters/",
				})),
			},
			{
				title: "encounter",
				items: [],
				note: `${threat}: ${xp} XP for ${size} PCs at level ${partyLevel(slice)} (${THREATS.map((t) => `${t} ${budgetFor(t, size)}`).join(", ")})`,
			},
		],
		start:
			slice.combat === undefined
				? { line: "/start" }
				: { note: `round ${slice.combat.round}` },
	};
};
