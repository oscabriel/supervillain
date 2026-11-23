import type { TokenAction } from "../../actions.ts";
import { partyFirst, prepMaps, prepSteps } from "../../prep.ts";
import type { PrepCatalog, PrepView } from "../../prep.ts";
import { ifDefined, listIf, when } from "../../present.ts";
import { moverWalk, reachable } from "../board/movement.ts";
import type { MapToken, MapView } from "../board/view.ts";
import type { Combatant, CombatView } from "../drawSteel/view.ts";
import type { Refused } from "../engine.ts";
import {
	controls,
	fighterOf,
	findFighter,
	isDown,
	mapSide,
	marksOf,
	maxHealth,
	maxStamina,
	nextOf,
	occupants,
	resolveFighter,
	shownStamina,
	speedOf,
} from "./state.ts";
import type { Fighter, SetState } from "./state.ts";
import { reachOf } from "./weapons.ts";

const percent = (n: number) => `${Math.round(n * 100)}%`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

interface Health {
	readonly health?: "dead" | "winded";
}

const healthOf = (f: Fighter, max: number): Health => {
	if (isDown(f)) {
		return { health: "dead" };
	}

	return f.health <= max / 2 ? { health: "winded" } : {};
};

export const setBand = (
	slice: SetState,
	actor: string,
	labelOf?: (actor: string) => string
): CombatView | undefined => {
	const { fight } = slice;

	if (fight === undefined && !slice.fighters.some((f) => f.side === "party")) {
		return undefined;
	}

	const marks = slice.map === undefined ? undefined : marksOf(slice.fighters);

	const shown =
		fight === undefined
			? slice.fighters.filter((f) => f.side === "party")
			: slice.fighters.toSorted(
					(a, b) =>
						Number(isDown(a)) - Number(isDown(b)) ||
						(nextOf(fight, a.id) ?? Infinity) -
							(nextOf(fight, b.id) ?? Infinity)
				);

	const combatant = (f: Fighter): Combatant => {
		const max = maxHealth(f.character);

		const player =
			f.player !== undefined && f.player !== actor
				? labelOf?.(f.player)
				: undefined;

		const mark = f.at === undefined ? undefined : marks?.get(f.id);

		return {
			id: f.id,
			name: player === undefined ? f.name : `${f.name} (${player})`,
			side: mapSide(f),
			stamina: Math.max(0, f.health),
			max,
			temp: 0,
			...healthOf(f, max),
			conditions: [],
			resource: `stamina ${shownStamina(f)}/${maxStamina(f.character)} · ${f.character.className}, ${f.character.mainhand}`,
			acted: false,
			acting: fight?.turn?.id === f.id,
			mine: f.player === actor,
			...when(
				f.side === "party" && f.player === undefined && !isDown(f),
				() => ({ free: true })
			),
			...ifDefined(mark, (value) => ({ mark: value })),
		};
	};

	const turn =
		fight?.turn === undefined ? undefined : findFighter(slice, fight.turn.id);

	return {
		round: fight?.turns ?? 0,
		active: fight !== undefined,
		malice: 0,
		heroTokens: 0,
		title:
			fight === undefined
				? " party "
				: ` set.world · ${seconds(fight.clock)} · turn ${fight.turns}${turn === undefined ? "" : `: ${turn.name}`} `,
		combatants: shown.map(combatant),
	};
};

const standingOn = (f: Fighter | undefined): Fighter | undefined =>
	f !== undefined && f.at !== undefined && !isDown(f) ? f : undefined;

const reachFor = (slice: SetState, actor: string): Fighter | undefined => {
	const acting =
		slice.fight?.turn === undefined
			? undefined
			: findFighter(slice, slice.fight.turn.id);

	return standingOn(acting) ?? standingOn(fighterOf(slice, actor));
};

export const setMap = (slice: SetState, actor: string): MapView | undefined => {
	const { map } = slice;

	if (map === undefined) {
		return undefined;
	}

	const marks = marksOf(slice.fighters);

	const tokens = slice.fighters.flatMap((f): Array<MapToken> =>
		f.at === undefined
			? []
			: [
					{
						id: f.id,
						mark: marks.get(f.id) ?? "??",
						name: f.name,
						x: f.at.x,
						y: f.at.y,
						side: mapSide(f),
						mine: f.player === actor,
						acting: slice.fight?.turn?.id === f.id,
						dead: isDown(f),
					},
				]
	);

	const subject = reachFor(slice, actor);
	const speed = subject === undefined ? 0 : speedOf(subject.character);
	const turn = slice.fight?.turn;

	const left =
		turn !== undefined && turn.id === subject?.id
			? Math.max(0, speed - turn.moved)
			: speed;

	const reach =
		subject?.at === undefined
			? []
			: reachable(
					map.terrain,
					subject.at,
					left,
					moverWalk(
						map.terrain,
						{ side: mapSide(subject), prone: false },
						occupants(slice, subject.id)
					),
					occupants(slice, subject.id)
				);

	return {
		name: map.name,
		width: map.terrain[0]?.length ?? 0,
		height: map.terrain.length,
		terrain: map.terrain,
		...ifDefined(map.dressing, (value) => ({ dressing: value })),
		tokens: [...tokens.filter((t) => t.dead), ...tokens.filter((t) => !t.dead)],
		reach,
		...ifDefined(subject, (value) => ({
			reachLabel: `${value.name} can reach: ${left === speed ? `speed ${speed}` : `${left} of speed ${speed} left`}`,
		})),
	};
};

export const setSheet = (slice: SetState, typed: string): string | Refused => {
	const f = resolveFighter(slice, typed);

	if ("refusal" in f) {
		return f;
	}

	const c = f.character;
	const a = c.attributes;
	const reach = reachOf(c.mainhand);

	return [
		`${f.name}: ${c.className}, ${f.side === "party" ? "of the party" : "a foe"} (set.world seed ${c.seed}, power ${c.powerRating})`,
		c.flavor,
		`Health ${f.health}/${maxHealth(c)}${isDown(f) ? " · down" : ""} · stamina ${shownStamina(f)}/${maxStamina(c)} · speed ${speedOf(c)} · initiative ${a.initiative.toFixed(2)}, a turn every ${Math.round(1000 / a.initiative)} ms`,
		`Weapon: ${c.mainhand} (${reach.delivery}, reaches ${reach.squares}) · ${reach.magic ? `magic ${a.magicalDamage}` : `physical ${a.physicalDamage}`} damage`,
		`Dodge ${percent(a.dodgeRate)} · critical ${percent(a.criticalHitChance)} · clarity ${percent(a.clarity)} · armour ${percent(a.physicalDamageReduction)} physical, ${percent(a.magicalDamageReduction)} magic · resists ${percent(a.globalResistance)}`,
		`Stats: ${Object.entries(c.finalStats)
			.map(([k, v]) => `${k} ${v}`)
			.join(", ")}`,
		`Gear: ${c.gear.map((g) => g.name).join("; ")}`,
	].join("\n");
};

export const withFighters =
	(slice: SetState, labelOf: (actor: string) => string) =>
	(actor: string): string => {
		const own = fighterOf(slice, actor);

		return own === undefined
			? labelOf(actor)
			: `${labelOf(actor)} (${own.name})`;
	};

const boardActions = (
	slice: SetState,
	f: Fighter
): ReadonlyArray<TokenAction> => {
	if (slice.map === undefined) {
		return [];
	}

	return f.at === undefined
		? [{ label: "Place", pick: "square", line: `/place ${f.id}` }]
		: [{ label: "Move", pick: "square", line: `/move ${f.id}` }];
};

export const setActions = (
	slice: SetState,
	actor: string,
	id: string
): ReadonlyArray<TokenAction> | undefined => {
	const f = findFighter(slice, id);

	if (f === undefined || !controls(actor, f)) {
		return undefined;
	}

	return [
		...boardActions(slice, f),
		{ label: "Attack", pick: "target", line: `/attack ${f.id}` },
		...listIf(slice.fight?.turn?.id === f.id, () => [
			{ label: "Done", pick: "none" as const, line: "/done" },
		]),
	];
};

export const setWorldPrep = (
	slice: SetState,
	catalog: PrepCatalog
): PrepView => {
	const standing = slice.fighters.filter((f) => !isDown(f));
	const party = slice.fighters.filter((f) => f.side === "party").length;
	const foes = slice.fighters.length - party;

	return {
		steps: prepSteps(
			slice.map !== undefined,
			standing.map((f) => ({ side: mapSide(f), placed: f.at !== undefined }))
		),
		maps: prepMaps(catalog, slice.map),
		place:
			slice.map === undefined
				? []
				: partyFirst(
						standing
							.filter((f) => f.at === undefined)
							.map((f) => ({
								id: f.id,
								name: f.name,
								figure: { id: f.id, side: mapSide(f) },
							}))
					),
		sections: [
			{
				title: "fighters",
				items: [
					{ kind: "fill", label: "Recruit", line: "/recruit " },
					{ kind: "fill", label: "Foe", line: "/foe " },
				],
				note: `${party} in the party, ${foes} ${foes === 1 ? "foe" : "foes"}`,
			},
		],
		start:
			slice.fight === undefined
				? { line: "/start" }
				: { note: "the fight is on" },
	};
};
