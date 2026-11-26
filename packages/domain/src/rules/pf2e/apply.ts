import { signed } from "../../dice.ts";
import { ifDefined, listIfDefined, when } from "../../present.ts";
import { hasTerminalControls } from "../../text.ts";
import { formatSquare, malformed, standable } from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import type { FeedNote } from "../core/module.ts";
import { plural } from "../drawSteel/state.ts";
import { bad, payloadDecoder } from "../engine.ts";
import type { Envelope } from "../engine.ts";
import { actionsText, maxActions } from "./combat.ts";
import { Payloads, isEventType } from "./events.ts";
import type { Damage, EventType, Payload } from "./events.ts";
import { adjusted, DEGREE_TEXT } from "./math.ts";
import type { Degree } from "./math.ts";
import { pfSheetProblems } from "./schema.ts";
import {
	COUNTERS,
	deadAt,
	findCreature,
	hasCondition,
	HERO_POINTS_MAX,
	isDead,
	valueOf,
	withCreature,
} from "./state.ts";
import type {
	PfCombat,
	PfCondition,
	PfConditionName,
	PfCounter,
	PfCreature,
	PfExpires,
	PfLastCheck,
	PfLastHit,
	PfState,
	PfTurn,
} from "./state.ts";

export interface Applied {
	readonly slice: PfState;
	readonly feed?: FeedNote;
}

export const formats = {
	pf: { speaker: false, separator: "" },
	"pf-turn": { speaker: false, separator: "" },
	"pf-act": { speaker: true, separator: " " },
	"pf-claim": { speaker: true, separator: " ", plainLabel: true },
} as const;

const decode = payloadDecoder(Payloads);

const creature = (slice: PfState, envelope: Envelope, id: string): PfCreature =>
	findCreature(slice, id) ??
	bad(envelope, `names '${id}', who isn't at the table`);

const combatOf = (slice: PfState, envelope: Envelope): PfCombat =>
	slice.combat ?? bad(envelope, "comes with no encounter running");

const note = (text: string): FeedNote => ({ kind: "pf", text });

const turnNote = (text: string): FeedNote => ({ kind: "pf-turn", text });

const hpText = (c: PfCreature): string =>
	`${c.hp}/${c.sheet.hp} HP${c.temp > 0 ? ` +${c.temp} temp` : ""}`;

const rollText = (natural: number, bonus: number, total: number): string =>
	`${natural}${signed(bonus) === "" ? "" : signed(bonus)} = ${total}`;

const withCombat = (
	slice: PfState,
	change: (combat: PfCombat) => PfCombat
): PfState =>
	slice.combat === undefined
		? slice
		: { ...slice, combat: change(slice.combat) };

const withTurn = (
	slice: PfState,
	id: string,
	change: (turn: PfTurn) => PfTurn
): PfState =>
	withCombat(slice, (combat) =>
		combat.turn?.id === id ? { ...combat, turn: change(combat.turn) } : combat
	);

const spend = (slice: PfState, id: string, actions: number): PfState =>
	withTurn(slice, id, (turn) => ({
		...turn,
		actions: Math.max(0, turn.actions - actions),
	}));

const reacted = (slice: PfState, id: string): PfState =>
	withCombat(slice, (combat) =>
		combat.reacted.includes(id)
			? combat
			: { ...combat, reacted: [...combat.reacted, id] }
	);

const without = (
	conditions: ReadonlyArray<PfCondition>,
	name: PfConditionName
): ReadonlyArray<PfCondition> => conditions.filter((c) => c.name !== name);

const condition = (c: PfCreature, set: PfCondition): PfCreature => ({
	...c,
	conditions: [...without(c.conditions, set.name), set],
});

const lift = (c: PfCreature, name: PfConditionName): PfCreature => ({
	...c,
	conditions: without(c.conditions, name),
});

const atLeast = (
	c: PfCreature,
	name: PfConditionName,
	value: number
): PfCreature =>
	valueOf(c, name) >= value ? c : condition(c, { name, value });

const moveBefore = (
	order: ReadonlyArray<string>,
	id: string,
	before: string
): ReadonlyArray<string> => {
	const rest = order.filter((o) => o !== id);
	const at = rest.indexOf(before);

	if (at !== -1) {
		return [...rest.slice(0, at), id, ...rest.slice(at)];
	}

	return order.includes(id) ? order : [...rest, id];
};

const unhit = ({ lastHit: _hit, ...c }: PfCreature): PfCreature => c;

const knockedOut = (c: PfCreature, applied: number): boolean =>
	c.kind === "pc" && applied > c.temp && c.hp + c.temp - applied <= 0;

const wear = (
	c: PfCreature,
	applied: number,
	critical: boolean
): PfCreature => {
	const fromTemp = Math.min(c.temp, applied);
	const rest = applied - fromTemp;
	const hp = Math.max(0, c.hp - rest);
	const base: PfCreature = { ...c, temp: c.temp - fromTemp, hp };

	if (!knockedOut(c, applied)) {
		return base;
	}

	const step = critical ? 2 : 1;
	const dying = c.dying === 0 ? step + c.wounded : c.dying + step;

	return condition(
		{ ...base, dying: Math.min(dying, deadAt(c)), dead: dying >= deadAt(c) },
		{ name: "unconscious" }
	);
};

const hitOf = (
	c: PfCreature,
	applied: number,
	critical: boolean,
	combat: PfCombat | undefined,
	moved: boolean
): PfLastHit => {
	const base: PfLastHit = {
		dealt: applied,
		beforeHp: c.hp,
		beforeTemp: c.temp,
		beforeDying: c.dying,
		beforeWounded: c.wounded,
		wasUnconscious: hasCondition(c, "unconscious"),
		crit: critical,
		blocked: false,
	};

	return moved && combat !== undefined
		? { ...base, beforeOrder: combat.order, beforeDelayed: combat.delayed }
		: base;
};

const fallenText = (
	c: PfCreature,
	worn: PfCreature,
	applied: number,
	moved: boolean
): string => {
	if (!knockedOut(c, applied)) {
		return `${c.name} ${hpText(worn)}${isDead(worn) ? ", dead" : ""}`;
	}

	const shift = moved ? ", initiative moves before this turn" : "";

	return worn.dead
		? `${c.name} 0 HP, dead`
		: `${c.name} 0 HP, dying ${worn.dying}${shift}`;
};

const untilText = (
	slice: PfState,
	envelope: Envelope,
	expires: PfExpires | undefined
): string => {
	if (expires === undefined) {
		return "";
	}

	const edge = expires.at === "eot" ? "end" : "start";

	return ` until the ${edge} of ${creature(slice, envelope, expires.of).name}'s turn`;
};

interface Hurt {
	readonly slice: PfState;
	readonly text: string;
}

const hurt = (
	slice: PfState,
	envelope: Envelope,
	id: string,
	applied: number,
	critical: boolean
): Hurt => {
	const c = creature(slice, envelope, id);
	const worn = wear(c, applied, critical);
	const actingId = slice.combat?.turn?.id;

	const moved =
		knockedOut(c, applied) &&
		c.hp > 0 &&
		actingId !== undefined &&
		actingId !== id;

	const next =
		applied > 0
			? {
					...worn,
					lastHit: hitOf(c, applied, critical, slice.combat, moved),
				}
			: unhit(worn);

	const shifted =
		moved && actingId !== undefined
			? withCombat(slice, (combat) => ({
					...combat,
					order: moveBefore(combat.order, id, actingId),
					delayed: combat.delayed.filter((d) => d !== id),
				}))
			: slice;

	return {
		slice: withCreature(shifted, id, () => next),
		text: fallenText(c, worn, applied, moved),
	};
};

const damageNote = (d: Damage): string => {
	const rolled = d.rolls.length === 0 ? "" : ` [${d.rolls.join(", ")}]`;
	const changed = d.applied === d.total ? "" : ` (${d.applied} taken)`;

	return `${d.expression}${rolled} = ${d.total}${d.damageType === undefined ? "" : ` ${d.damageType}`}${changed}`;
};

const hurtBy = (
	slice: PfState,
	envelope: Envelope,
	id: string,
	d: Damage
): Hurt => {
	const done = hurt(slice, envelope, id, d.applied, d.critical);

	return { slice: done.slice, text: `${damageNote(d)} → ${done.text}` };
};

const restore = (hit: PfCreature, amount: number): PfCreature => {
	const c = unhit(hit);
	const hp = Math.min(c.sheet.hp, c.hp + amount);

	if (c.hp > 0 || hp === 0) {
		return { ...c, hp };
	}

	return lift(
		{
			...c,
			hp,
			dying: 0,
			wounded: c.dying > 0 ? c.wounded + 1 : c.wounded,
		},
		"unconscious"
	);
};

const checked = (
	slice: PfState,
	id: string,
	last: PfLastCheck | undefined
): PfState =>
	withCreature(slice, id, (c) => {
		const { lastCheck: _old, ...rest } = c;

		return last === undefined ? rest : { ...rest, lastCheck: last };
	});

const degreeText = (d: Degree | undefined): string =>
	d === undefined ? "" : `: ${DEGREE_TEXT[d]}`;

const safeSheet = (envelope: Envelope, sheet: PfCreature["sheet"]) => {
	const problems = pfSheetProblems(sheet);

	if (problems.length > 0) {
		bad(
			envelope,
			`holds a sheet the table can't use: ${problems.map((p) => `${p.field} ${p.problem}`).join("; ")}`
		);
	}
};

const fresh = (
	id: string,
	name: string,
	side: PfCreature["side"],
	sheet: PfCreature["sheet"]
): PfCreature => ({
	id,
	name,
	side,
	kind: side === "party" ? "pc" : "npc",
	sheet,
	hp: sheet.hp,
	temp: 0,
	dying: 0,
	wounded: 0,
	doomed: 0,
	dead: false,
	heroPoints: side === "party" ? 1 : 0,
	conditions: [],
	persistent: [],
	...ifDefined(sheet.shield, (s) => ({ shield: { hp: s.hp, raised: false } })),
	slotsUsed: [],
});

const standOn = (slice: PfState, envelope: Envelope, at: Square): void => {
	const terrain =
		slice.map?.terrain ?? bad(envelope, "comes with no map loaded");

	if (!standable(terrain, at)) {
		bad(envelope, "puts someone where nobody can stand");
	}
};

const offTheMap = (slice: PfState): ReadonlyArray<PfCreature> =>
	slice.creatures.map(({ at: _at, ...c }) => c);

const isCounter = (name: string): name is PfCounter =>
	COUNTERS.some((n) => n === name);

const setCounter = (
	hit: PfCreature,
	name: PfCounter,
	value: number
): PfCreature => {
	const c = unhit(hit);

	if (name === "wounded") {
		return { ...c, wounded: value };
	}

	if (name === "doomed") {
		return {
			...c,
			doomed: value,
			dead: c.dead || (c.dying > 0 && c.dying >= Math.max(1, 4 - value)),
		};
	}

	const dead = value >= deadAt(c);
	const set = { ...c, dying: Math.min(value, deadAt(c)), dead: c.dead || dead };

	return value > 0 ? condition(set, { name: "unconscious" }) : set;
};

const goesBefore = (
	c: PfCreature,
	total: number,
	other: PfCreature
): boolean => {
	const theirs = other.initiative ?? 0;

	return (
		total > theirs ||
		(total === theirs && c.side === "foes" && other.side === "party")
	);
};

const inserted = (
	slice: PfState,
	order: ReadonlyArray<string>,
	c: PfCreature,
	total: number
): ReadonlyArray<string> => {
	const at = order.findIndex((id) => {
		const other = findCreature(slice, id);

		return other !== undefined && goesBefore(c, total, other);
	});

	return at === -1
		? [...order, c.id]
		: [...order.slice(0, at), c.id, ...order.slice(at)];
};

const MANEUVER_TEXT = {
	grapple: "Grapples",
	trip: "Trips",
	shove: "Shoves",
	disarm: "Disarms",
	demoralize: "Demoralizes",
} as const;

interface Effects {
	readonly slice: PfState;
	readonly effects: ReadonlyArray<string>;
}

const targetEffects = (
	slice: PfState,
	envelope: Envelope,
	p: Payload<"pf.maneuvered">,
	a: PfCreature,
	t: PfCreature
): Effects => {
	const won = p.degree === "success" || p.degree === "crit-success";
	const critical = p.degree === "crit-success";
	const actorActing = slice.combat?.turn?.id === a.id;

	const until: PfExpires = {
		at: "eot",
		of: a.id,
		...when(actorActing, () => ({ skip: true })),
	};

	if (p.maneuver === "grapple" && won) {
		const name = critical ? "restrained" : "grabbed";

		return {
			slice: withCreature(slice, t.id, (x) =>
				condition(x, { name, expires: until, by: a.id })
			),
			effects: [`${t.name} is ${name}`],
		};
	}

	if (p.maneuver === "trip" && won) {
		const prone = withCreature(slice, t.id, (x) =>
			condition(x, { name: "prone" })
		);

		const hit =
			p.damage === undefined
				? undefined
				: hurtBy(prone, envelope, t.id, p.damage);

		return {
			slice: hit?.slice ?? prone,
			effects: [
				`${t.name} falls prone`,
				...listIfDefined(hit, (h) => [h.text]),
			],
		};
	}

	if (p.maneuver === "shove" && p.to !== undefined) {
		const { to } = p;

		return {
			slice: withCreature(slice, t.id, (x) => ({ ...x, at: to })),
			effects: [`${t.name} is pushed to ${formatSquare(to)}`],
		};
	}

	if (p.maneuver === "disarm" && won) {
		return {
			slice,
			effects: [
				critical
					? `${t.name} drops what it held`
					: `${t.name} takes -2 to attacks with that item until its next turn`,
			],
		};
	}

	if (p.maneuver === "demoralize" && won) {
		const value = critical ? 2 : 1;

		return {
			slice: withCreature(slice, t.id, (x) => atLeast(x, "frightened", value)),
			effects: [
				`${t.name} is frightened ${Math.max(value, valueOf(t, "frightened"))}`,
			],
		};
	}

	return { slice, effects: [] };
};

const maneuverEffects = (
	slice: PfState,
	envelope: Envelope,
	p: Payload<"pf.maneuvered">,
	a: PfCreature,
	t: PfCreature
): Effects => {
	const done = targetEffects(slice, envelope, p, a, t);

	if (p.degree !== "crit-failure" || p.maneuver === "demoralize") {
		return done;
	}

	if (p.maneuver === "disarm") {
		return {
			slice: withCreature(done.slice, a.id, (x) =>
				condition(x, { name: "off-guard", expires: { at: "sot", of: a.id } })
			),
			effects: [...done.effects, `${a.name} is off-guard until its next turn`],
		};
	}

	return {
		slice: withCreature(done.slice, a.id, (x) =>
			condition(x, { name: "prone" })
		),
		effects: [...done.effects, `${a.name} falls prone`],
	};
};

const stunnedAfter = (
	x: PfCreature,
	stunned: number | undefined
): PfCreature => {
	if (stunned === undefined) {
		return x;
	}

	return stunned > 0
		? condition(x, { name: "stunned", value: stunned })
		: lift(x, "stunned");
};

const recoveryWord = (c: PfCreature): string => {
	if (c.dead) {
		return "dead";
	}

	return c.dying > 0 ? `dying ${c.dying}` : `stable, wounded ${c.wounded}`;
};

const shieldWord = (hp: number, broken: boolean): string => {
	if (hp === 0) {
		return ", destroyed";
	}

	return broken ? ", broken" : "";
};

type Applier = (slice: PfState, envelope: Envelope) => Applied;

const appliers = {
	"pf.pc-joined": (slice, envelope) => {
		const { sheet } = decode("pf.pc-joined", envelope);
		safeSheet(envelope, sheet);
		const there = findCreature(slice, sheet.id);

		if (there !== undefined) {
			if (there.kind !== "pc") {
				bad(envelope, `reloads '${sheet.id}', who isn't a PC`);
			}

			return {
				slice: withCreature(slice, sheet.id, (c) => {
					const { shield: _held, ...rest } = unhit(c);

					return {
						...rest,
						sheet,
						name: sheet.name,
						hp: Math.min(c.hp, sheet.hp),
						...ifDefined(sheet.shield, (stats) => ({
							shield: {
								hp: Math.min(c.shield?.hp ?? stats.hp, stats.hp),
								raised: c.shield?.raised ?? false,
							},
						})),
					};
				}),
				feed: note(`${sheet.name}'s sheet is loaded again.`),
			};
		}

		const pc = fresh(sheet.id, sheet.name, "party", sheet);

		return {
			slice: { ...slice, creatures: [...slice.creatures, pc] },
			feed: note(
				`${sheet.name} joins the party: level ${sheet.level}${sheet.ancestry === undefined ? "" : ` ${sheet.ancestry}`}${sheet.class === undefined ? "" : ` ${sheet.class}`}, ${sheet.hp} HP, AC ${sheet.ac}, Speed ${sheet.speed} ft.`
			),
		};
	},
	"pf.creatures-added": (slice, envelope) => {
		const { block, adjustment, creatures } = decode(
			"pf.creatures-added",
			envelope
		);

		safeSheet(envelope, block);

		if (creatures.length === 0) {
			bad(envelope, "adds nobody");
		}

		const sheet =
			adjustment === undefined ? block : adjusted(block, adjustment);

		const added = creatures.map((x): PfCreature => {
			if (findCreature(slice, x.id) !== undefined) {
				bad(envelope, `brings '${x.id}' a second time`);
			}

			if (x.name.trim() === "" || hasTerminalControls(x.name)) {
				bad(envelope, "holds a name the table can't show");
			}

			return {
				...fresh(x.id, x.name, "foes", sheet),
				block: block.id,
				...ifDefined(adjustment, (value) => ({ adjustment: value })),
			};
		});

		const label = `${adjustment === undefined ? "" : `${adjustment} `}${block.name}`;

		return {
			slice: { ...slice, creatures: [...slice.creatures, ...added] },
			feed: note(
				`${added.length === 1 ? `A ${label} comes` : `${added.length} × ${label} come`}: level ${sheet.level}, ${sheet.hp} HP, AC ${sheet.ac}.`
			),
		};
	},
	"pf.pc-claimed": (slice, envelope) => {
		const { id, player } = decode("pf.pc-claimed", envelope);
		const c = creature(slice, envelope, id);

		if (c.kind !== "pc") {
			bad(envelope, `gives a player '${id}', who isn't a PC`);
		}

		if (slice.creatures.some((x) => x.player === player && x.id !== id)) {
			bad(envelope, "gives a player a second PC");
		}

		return {
			slice: withCreature(slice, id, (x) => ({ ...x, player })),
			feed: { kind: "pf-claim", text: `plays ${c.name}.`, speaker: player },
		};
	},
	"pf.pc-released": (slice, envelope) => {
		const { id } = decode("pf.pc-released", envelope);
		const c = creature(slice, envelope, id);

		if (c.player === undefined) {
			bad(envelope, `frees '${id}', whom nobody plays`);
		}

		return {
			slice: withCreature(slice, id, ({ player: _player, ...x }) => x),
			feed:
				c.player === envelope.actor
					? { kind: "pf-act", text: `stops playing ${c.name}.` }
					: note(`Nobody plays ${c.name} now.`),
		};
	},
	"pf.initiative-rolled": (slice, envelope) => {
		const { id, skill, natural, bonus, total } = decode(
			"pf.initiative-rolled",
			envelope
		);

		const c = creature(slice, envelope, id);

		if (natural + bonus !== total || natural < 1 || natural > 20) {
			bad(envelope, "doesn't add up");
		}

		const rolled = withCreature(slice, id, (x) => ({
			...x,
			initiative: total,
		}));

		const placed = withCombat(rolled, (combat) =>
			combat.order.includes(id) || combat.delayed.includes(id)
				? combat
				: { ...combat, order: inserted(rolled, combat.order, c, total) }
		);

		return {
			slice: placed,
			feed: note(
				`${c.name} rolls initiative (${skill}): ${rollText(natural, bonus, total)}.`
			),
		};
	},
	"pf.combat-started": (slice, envelope) => {
		const { order } = decode("pf.combat-started", envelope);

		if (slice.combat !== undefined) {
			bad(envelope, "starts an encounter while one runs");
		}

		const names = order.map((id) => creature(slice, envelope, id).name);

		return {
			slice: {
				...slice,
				combat: { round: 1, order, delayed: [], reacted: [] },
			},
			feed: turnNote(`The encounter begins. Initiative: ${names.join(", ")}.`),
		};
	},
	"pf.turn-started": (slice, envelope) => {
		const p = decode("pf.turn-started", envelope);
		const combat = combatOf(slice, envelope);

		if (combat.turn !== undefined) {
			bad(envelope, "starts a turn while another is under way");
		}

		const c = creature(slice, envelope, p.id);

		if (p.actions < 0 || p.actions > maxActions(c)) {
			bad(envelope, "gives more actions than a turn holds");
		}

		const expired = slice.creatures.map((x) => ({
			...unhit(x),
			conditions: x.conditions.filter(
				(k) => !(k.expires?.at === "sot" && k.expires.of === p.id)
			),
		}));

		const lowered = withCreature(
			{ ...slice, creatures: expired },
			p.id,
			(x) => {
				const shield = ifDefined(x.shield, (held) => ({
					shield: { ...held, raised: false },
				}));

				const stunned = stunnedAfter(x, p.stunned);

				return { ...stunned, ...shield };
			}
		);

		const { recovery } = p;

		const recovered =
			recovery === undefined
				? lowered
				: withCreature(lowered, p.id, (x) => {
						const delta = {
							"crit-success": -2,
							success: -1,
							failure: 1,
							"crit-failure": 2,
						}[recovery.degree];

						const dying = Math.max(0, x.dying + delta);
						const dead = dying >= deadAt(x);

						if (dying === 0) {
							return { ...x, dying: 0, wounded: x.wounded + 1 };
						}

						return {
							...x,
							dying: Math.min(dying, deadAt(x)),
							dead: x.dead || dead,
						};
					});

		const after = creature(recovered, envelope, p.id);
		const max = maxActions(c);

		const turned: PfState = {
			...recovered,
			combat: {
				...combat,
				round: p.round,
				reacted: combat.reacted.filter((r) => r !== p.id),
				turn: {
					id: p.id,
					actions: p.actions,
					granted: p.actions,
					max,
					attacks: 0,
					struck: [],
					diagonalParity: 0,
				},
			},
		};

		const recoveryText =
			recovery === undefined
				? ""
				: ` Recovery check DC ${recovery.dc}: ${recovery.natural}, ${DEGREE_TEXT[recovery.degree]} → ${recoveryWord(after)}.`;

		return {
			slice: turned,
			feed: turnNote(
				`Round ${p.round} · ${c.name}'s turn: ${actionsText(p.actions, max)} ↺.${recoveryText}`
			),
		};
	},
	"pf.turn-ended": (slice, envelope) => {
		const { id, persistent } = decode("pf.turn-ended", envelope);
		const combat = combatOf(slice, envelope);

		if (combat.turn?.id !== id) {
			bad(envelope, `ends a turn that isn't '${id}''s`);
		}

		const c = creature(slice, envelope, id);
		let next: PfState = slice;
		const texts: Array<string> = [];

		for (const tick of persistent) {
			const done = hurt(next, envelope, id, tick.applied, false);

			next = done.slice;

			texts.push(
				`persistent ${tick.damageType} ${tick.dice}${tick.rolls.length === 0 ? "" : ` [${tick.rolls.join(", ")}]`} = ${tick.applied} → ${done.text}; flat check ${tick.natural}${tick.ended ? ", it ends" : ", it goes on"}`
			);

			if (tick.ended) {
				next = withCreature(next, id, (x) => ({
					...x,
					persistent: x.persistent.filter(
						(q) => q.damageType !== tick.damageType
					),
				}));
			}
		}

		next = withCreature(next, id, (x) => {
			const frightened = valueOf(x, "frightened");

			return frightened <= 1
				? lift(x, "frightened")
				: condition(x, { name: "frightened", value: frightened - 1 });
		});

		next = {
			...next,
			creatures: next.creatures.map((x) => ({
				...x,
				conditions: x.conditions.flatMap((k): ReadonlyArray<PfCondition> => {
					if (k.expires?.at !== "eot" || k.expires.of !== id) {
						return [k];
					}

					return k.expires.skip === true
						? [{ ...k, expires: { at: "eot", of: id } }]
						: [];
				}),
			})),
		};

		const ended = withCombat(next, ({ turn: _turn, ...rest }) => rest);

		return {
			slice: ended,
			feed: turnNote(
				`${c.name}'s turn ends.${texts.length === 0 ? "" : ` ${texts.join(". ")}.`}`
			),
		};
	},
	"pf.delayed": (slice, envelope) => {
		const { id } = decode("pf.delayed", envelope);
		const combat = combatOf(slice, envelope);
		const c = creature(slice, envelope, id);

		if (!combat.order.includes(id) || combat.delayed.includes(id)) {
			bad(envelope, `delays '${id}', who isn't in the initiative order`);
		}

		if (combat.turn !== undefined && combat.turn.id !== id) {
			bad(envelope, `delays '${id}' during someone else's turn`);
		}

		const { turn: _turn, ...rest } = combat;

		return {
			slice: {
				...slice,
				combat: {
					...rest,
					order: combat.order.filter((o) => o !== id),
					delayed: [...combat.delayed, id],
				},
			},
			feed: turnNote(`${c.name} delays.`),
		};
	},
	"pf.rejoined": (slice, envelope) => {
		const { id, after } = decode("pf.rejoined", envelope);
		const combat = combatOf(slice, envelope);
		const c = creature(slice, envelope, id);
		const at = combat.order.indexOf(after);

		if (
			!combat.delayed.includes(id) ||
			combat.order.includes(id) ||
			at === -1
		) {
			bad(envelope, `can't put '${id}' back after '${after}'`);
		}

		return {
			slice: {
				...slice,
				combat: {
					...combat,
					delayed: combat.delayed.filter((d) => d !== id),
					order: [
						...combat.order.slice(0, at + 1),
						id,
						...combat.order.slice(at + 1),
					],
				},
			},
			feed: turnNote(
				`${c.name} returns to initiative, after ${creature(slice, envelope, after).name}.`
			),
		};
	},
	"pf.combat-ended": (slice, envelope) => {
		decode("pf.combat-ended", envelope);
		combatOf(slice, envelope);
		const { combat: _combat, ...rest } = slice;

		return {
			slice: {
				...rest,
				creatures: slice.creatures.map(({ initiative: _i, ...c }) => ({
					...unhit(c),
					...ifDefined(c.shield, (s) => ({ shield: { ...s, raised: false } })),
				})),
			},
			feed: turnNote("The encounter ends."),
		};
	},
	"pf.struck": (slice, envelope) => {
		const p = decode("pf.struck", envelope);
		const a = creature(slice, envelope, p.id);
		const t = creature(slice, envelope, p.target);

		if (p.natural + p.bonus !== p.total || p.natural < 1 || p.natural > 20) {
			bad(envelope, "doesn't add up");
		}

		const striking = (struck: ReadonlyArray<string>) =>
			struck.includes(t.id) ? struck : [...struck, t.id];

		const spent = p.reaction
			? reacted(slice, a.id)
			: withTurn(spend(slice, a.id, 1), a.id, (turn) => ({
					...turn,
					attacks: turn.attacks + 1,
					struck: striking(turn.struck),
				}));

		const hit =
			p.damage === undefined
				? undefined
				: hurtBy(spent, envelope, t.id, p.damage);

		const after = checked(hit?.slice ?? spent, a.id, {
			kind: "strike",
			label: p.weapon,
			bonus: p.bonus,
			dc: p.ac,
			natural: p.natural,
			degree: p.degree,
			fortune: false,
			target: t.id,
			weapon: p.weapon,
		});

		const notes = p.notes.length === 0 ? "" : ` (${p.notes.join("; ")})`;

		return {
			slice: after,
			feed: note(
				`${a.name} Strikes${p.reaction ? " ↺" : ""} ${t.name} with ${p.weapon}: ${rollText(p.natural, p.bonus, p.total)} vs AC ${p.ac}${notes}${degreeText(p.degree)}.${hit === undefined ? "" : ` ${hit.text}.`}`
			),
		};
	},
	"pf.moved": (slice, envelope) => {
		const { id, to, feet, kind, parity } = decode("pf.moved", envelope);
		const c = creature(slice, envelope, id);

		if (c.at === undefined) {
			bad(envelope, `moves '${id}', who isn't on the map`);
		}

		standOn(slice, envelope, to);
		const placed = withCreature(slice, id, (x) => ({ ...x, at: to }));

		const after =
			kind === "move"
				? placed
				: withTurn(spend(placed, id, 1), id, (turn) => ({
						...turn,
						diagonalParity: parity,
					}));

		const verb = {
			stride: "Strides",
			step: "Steps",
			crawl: "Crawls",
			move: "moves",
		}[kind];

		return {
			slice: after,
			feed: note(`${c.name} ${verb} to ${formatSquare(to)} (${feet} ft).`),
		};
	},
	"pf.placed": (slice, envelope) => {
		const { id, at } = decode("pf.placed", envelope);
		const c = creature(slice, envelope, id);
		standOn(slice, envelope, at);

		return {
			slice: withCreature(slice, id, (x) => ({ ...x, at })),
			feed: note(`${c.name} is placed at ${formatSquare(at)}.`),
		};
	},
	"pf.map-loaded": (slice, envelope) => {
		const { id, name, terrain, dressing } = decode("pf.map-loaded", envelope);

		const why = malformed({
			name,
			terrain,
			...ifDefined(dressing, (value) => ({ dressing: value })),
		});

		if (why !== undefined) {
			bad(envelope, `has a bad grid: ${why}`);
		}

		return {
			slice: {
				...slice,
				creatures: offTheMap(slice),
				map: {
					id,
					name,
					terrain,
					...ifDefined(dressing, (value) => ({ dressing: value })),
				},
			},
			feed: note(
				`The map is ${name}, ${terrain[0]?.length ?? 0} by ${terrain.length} squares of 5 ft.`
			),
		};
	},
	"pf.map-cleared": (slice, envelope) => {
		decode("pf.map-cleared", envelope);

		if (slice.map === undefined) {
			bad(envelope, "comes with no map loaded");
		}

		const { map: _map, ...rest } = slice;

		return {
			slice: { ...rest, creatures: offTheMap(slice) },
			feed: note("The map is put away."),
		};
	},
	"pf.measured": (slice, envelope) => {
		const { id, target, feet } = decode("pf.measured", envelope);
		const a = creature(slice, envelope, id);
		const b = creature(slice, envelope, target);

		return {
			slice,
			feed: note(`${a.name} and ${b.name} are ${feet} ft apart.`),
		};
	},
	"pf.stood": (slice, envelope) => {
		const { id } = decode("pf.stood", envelope);
		const c = creature(slice, envelope, id);

		return {
			slice: withCreature(spend(slice, id, 1), id, (x) => lift(x, "prone")),
			feed: note(`${c.name} Stands.`),
		};
	},
	"pf.dropped-prone": (slice, envelope) => {
		const { id } = decode("pf.dropped-prone", envelope);
		const c = creature(slice, envelope, id);

		return {
			slice: withCreature(spend(slice, id, 1), id, (x) =>
				condition(x, { name: "prone" })
			),
			feed: note(`${c.name} Drops Prone.`),
		};
	},
	"pf.shield-raised": (slice, envelope) => {
		const { id } = decode("pf.shield-raised", envelope);
		const c = creature(slice, envelope, id);

		if (c.shield === undefined || c.sheet.shield === undefined) {
			bad(envelope, `raises a shield '${id}' doesn't have`);
		}

		return {
			slice: withCreature(spend(slice, id, 1), id, (x) => ({
				...x,
				...ifDefined(x.shield, (s) => ({ shield: { ...s, raised: true } })),
			})),
			feed: note(
				`${c.name} Raises a Shield: +${c.sheet.shield.bonus} AC until their next turn.`
			),
		};
	},
	"pf.shield-blocked": (slice, envelope) => {
		const { id, damage, prevented, shieldTaken } = decode(
			"pf.shield-blocked",
			envelope
		);

		const c = creature(slice, envelope, id);
		const stats = c.sheet.shield;
		const { shield, lastHit } = c;

		if (
			stats === undefined ||
			shield === undefined ||
			lastHit === undefined ||
			lastHit.blocked ||
			damage < 1 ||
			damage > lastHit.dealt ||
			prevented !== Math.min(stats.hardness, damage) ||
			prevented + shieldTaken !== damage
		) {
			bad(envelope, "doesn't add up");
		}

		const hp = Math.max(0, shield.hp - shieldTaken);
		const broken = hp <= stats.broken;
		const taken = lastHit.dealt - prevented;

		const held = lastHit.wasUnconscious ? c : lift(c, "unconscious");

		const before: PfCreature = {
			...held,
			hp: lastHit.beforeHp,
			temp: lastHit.beforeTemp,
			dying: lastHit.beforeDying,
			wounded: lastHit.beforeWounded,
			dead: c.dead && lastHit.beforeDying >= deadAt(c),
		};

		const blocked = withCreature(reacted(slice, id), id, () => ({
			...wear(before, taken, lastHit.crit),
			shield: { hp, raised: !broken && shield.raised },
			lastHit: { ...lastHit, blocked: true },
		}));

		const after = creature(blocked, envelope, id);

		const restored =
			after.hp > 0 &&
			lastHit.beforeOrder !== undefined &&
			lastHit.beforeDelayed !== undefined
				? withCombat(blocked, (combat) => ({
						...combat,
						order: lastHit.beforeOrder ?? combat.order,
						delayed: lastHit.beforeDelayed ?? combat.delayed,
					}))
				: blocked;

		const share =
			taken === shieldTaken
				? `and so does ${c.name}`
				: `and ${c.name} takes ${taken}`;

		return {
			slice: restored,
			feed: note(
				`${c.name} Shield Blocks ↺: Hardness ${stats.hardness} stops ${prevented} of ${damage}; the shield takes ${shieldTaken} (${hp}/${stats.hp}${shieldWord(hp, broken)}) ${share} → ${hpText(after)}${after.dying > 0 ? `, dying ${after.dying}` : ""}.`
			),
		};
	},
	"pf.maneuvered": (slice, envelope) => {
		const p = decode("pf.maneuvered", envelope);
		const a = creature(slice, envelope, p.id);
		const t = creature(slice, envelope, p.target);

		if (p.natural + p.bonus !== p.total || p.natural < 1 || p.natural > 20) {
			bad(envelope, "doesn't add up");
		}

		const acted = spend(slice, a.id, 1);

		const counted =
			p.maneuver === "demoralize"
				? acted
				: withTurn(acted, a.id, (turn) => ({
						...turn,
						attacks: turn.attacks + 1,
					}));

		const done = maneuverEffects(counted, envelope, p, a, t);

		return {
			slice: checked(done.slice, a.id, undefined),
			feed: note(
				`${a.name} ${MANEUVER_TEXT[p.maneuver]} ${t.name}: ${p.skill} ${rollText(p.natural, p.bonus, p.total)} vs DC ${p.dc}${p.map === 0 ? "" : ` (MAP ${p.map})`}${degreeText(p.degree)}.${done.effects.length === 0 ? "" : ` ${done.effects.join("; ")}.`}`
			),
		};
	},
	"pf.checked": (slice, envelope) => {
		const p = decode("pf.checked", envelope);
		const c = creature(slice, envelope, p.id);

		if (p.natural + p.bonus !== p.total || p.natural < 1 || p.natural > 20) {
			bad(envelope, "doesn't add up");
		}

		return {
			slice: checked(slice, c.id, {
				kind: "check",
				label: p.skill,
				bonus: p.bonus,
				...ifDefined(p.dc, (dc) => ({ dc })),
				natural: p.natural,
				...ifDefined(p.degree, (d) => ({ degree: d })),
				fortune: false,
			}),
			feed: note(
				`${c.name} rolls ${p.skill}: ${rollText(p.natural, p.bonus, p.total)}${p.dc === undefined ? "" : ` vs DC ${p.dc}`}${degreeText(p.degree)}.`
			),
		};
	},
	"pf.saved": (slice, envelope) => {
		const p = decode("pf.saved", envelope);
		const c = creature(slice, envelope, p.id);

		if (p.natural + p.bonus !== p.total || p.natural < 1 || p.natural > 20) {
			bad(envelope, "doesn't add up");
		}

		const hit =
			p.damage === undefined
				? undefined
				: hurtBy(slice, envelope, c.id, p.damage);

		const last: PfLastCheck | undefined =
			p.damage === undefined
				? {
						kind: "save",
						label: p.save,
						bonus: p.bonus,
						dc: p.dc,
						natural: p.natural,
						degree: p.degree,
						fortune: false,
					}
				: undefined;

		return {
			slice: checked(hit?.slice ?? slice, c.id, last),
			feed: note(
				`${c.name} saves (${p.save}): ${rollText(p.natural, p.bonus, p.total)} vs DC ${p.dc}${degreeText(p.degree)}.${hit === undefined ? "" : ` ${hit.text}.`}`
			),
		};
	},
	"pf.flat-checked": (slice, envelope) => {
		const p = decode("pf.flat-checked", envelope);
		const c = creature(slice, envelope, p.id);

		if (p.success !== p.natural >= p.dc) {
			bad(envelope, "doesn't add up");
		}

		return {
			slice: checked(slice, c.id, {
				kind: "flat",
				label: "flat check",
				bonus: 0,
				dc: p.dc,
				natural: p.natural,
				degree: p.success ? "success" : "failure",
				fortune: false,
			}),
			feed: note(
				`${c.name} rolls a flat check: ${p.natural} vs DC ${p.dc}: ${p.success ? "success" : "failure"}.`
			),
		};
	},
	"pf.cast": (slice, envelope) => {
		const p = decode("pf.cast", envelope);
		const c = creature(slice, envelope, p.id);
		const acted = spend(slice, c.id, p.actions);

		const counted = p.attack
			? withTurn(acted, c.id, (turn) => ({
					...turn,
					attacks: turn.attacks + 1,
				}))
			: acted;

		const slotted = p.slot
			? withCreature(counted, c.id, (x) => ({
					...x,
					slotsUsed: [
						...x.slotsUsed.filter((s) => s.rank !== p.rank),
						{
							rank: p.rank,
							used: (x.slotsUsed.find((s) => s.rank === p.rank)?.used ?? 0) + 1,
						},
					],
				}))
			: counted;

		let next = slotted;
		const texts: Array<string> = [];

		for (const r of p.results) {
			const t = creature(next, envelope, r.target);

			const against = p.attack ? "AC" : "DC";
			const versus = r.dc === undefined ? "" : ` vs ${against} ${r.dc}`;

			const rolledText =
				r.natural === undefined ||
				r.bonus === undefined ||
				r.total === undefined
					? ""
					: `${rollText(r.natural, r.bonus, r.total)}${versus}${degreeText(r.degree)}`;

			if (r.healed !== undefined) {
				next = withCreature(next, t.id, (x) => restore(x, r.healed ?? 0));
				texts.push(
					`${t.name} regains ${r.healed} HP → ${hpText(creature(next, envelope, t.id))}`
				);
			} else if (r.damage === undefined) {
				texts.push(`${t.name}${rolledText === "" ? "" : ` ${rolledText}`}`);
			} else {
				const done = hurtBy(next, envelope, t.id, r.damage);

				next = done.slice;
				texts.push(
					`${t.name}${rolledText === "" ? "" : ` ${rolledText}`}, ${done.text}`
				);
			}
		}

		return {
			slice: checked(next, c.id, undefined),
			feed: note(
				`${c.name} casts ${p.spell}${p.rank > 0 ? ` (rank ${p.rank})` : ""}, ${actionsText(p.actions, p.actions)}${texts.length === 0 ? "." : `: ${texts.join("; ")}.`}`
			),
		};
	},
	"pf.damaged": (slice, envelope) => {
		const { id, damage } = decode("pf.damaged", envelope);
		creature(slice, envelope, id);
		const done = hurtBy(slice, envelope, id, damage);

		return { slice: done.slice, feed: note(`Damage: ${done.text}.`) };
	},
	"pf.healed": (slice, envelope) => {
		const { id, amount, rolls, expression } = decode("pf.healed", envelope);
		const c = creature(slice, envelope, id);

		if (isDead(c)) {
			bad(envelope, `heals '${id}', who is dead`);
		}

		const after = withCreature(slice, id, (x) => restore(x, amount));

		const rolled =
			expression === undefined
				? ""
				: ` (${expression} [${(rolls ?? []).join(", ")}])`;

		return {
			slice: after,
			feed: note(
				`${c.name} regains ${amount} HP${rolled} → ${hpText(creature(after, envelope, id))}.`
			),
		};
	},
	"pf.temp-set": (slice, envelope) => {
		const { id, temp } = decode("pf.temp-set", envelope);
		const c = creature(slice, envelope, id);
		const kept = Math.max(c.temp, temp);

		return {
			slice: withCreature(slice, id, (x) => ({ ...unhit(x), temp: kept })),
			feed: note(
				kept === temp
					? `${c.name} has ${temp} temporary HP.`
					: `${c.name} keeps ${kept} temporary HP; temporary HP doesn't stack.`
			),
		};
	},
	"pf.condition-set": (slice, envelope) => {
		const p = decode("pf.condition-set", envelope);
		const c = creature(slice, envelope, p.id);
		const { name } = p;

		if (isCounter(name)) {
			return {
				slice: withCreature(slice, c.id, (x) =>
					setCounter(x, name, p.value ?? 1)
				),
				feed: note(`${c.name} is ${name} ${p.value ?? 1}.`),
			};
		}

		const set: PfCondition = {
			name,
			...ifDefined(p.value, (value) => ({ value })),
			...ifDefined(p.expires, (expires) => ({ expires })),
			...ifDefined(p.by, (b) => ({ by: b })),
		};

		const until = untilText(slice, envelope, p.expires);

		return {
			slice: withCreature(slice, c.id, (x) =>
				condition(name === "unconscious" ? unhit(x) : x, set)
			),
			feed: note(
				`${c.name} is ${name}${p.value === undefined ? "" : ` ${p.value}`}${until}.`
			),
		};
	},
	"pf.condition-removed": (slice, envelope) => {
		const { id, name } = decode("pf.condition-removed", envelope);
		const c = creature(slice, envelope, id);

		const woken = (x: PfCreature) => (name === "unconscious" ? unhit(x) : x);

		const after = isCounter(name)
			? withCreature(slice, id, (x) => ({ ...unhit(x), [name]: 0 }))
			: withCreature(slice, id, (x) => lift(woken(x), name));

		return {
			slice: after,
			feed: note(`${c.name} is no longer ${name}.`),
		};
	},
	"pf.persistent-set": (slice, envelope) => {
		const { id, damageType, dice } = decode("pf.persistent-set", envelope);
		const c = creature(slice, envelope, id);

		return {
			slice: withCreature(slice, id, (x) => ({
				...x,
				persistent: [
					...x.persistent.filter((q) => q.damageType !== damageType),
					{ damageType, dice },
				],
			})),
			feed: note(`${c.name} takes persistent ${damageType} damage, ${dice}.`),
		};
	},
	"pf.persistent-removed": (slice, envelope) => {
		const { id, damageType } = decode("pf.persistent-removed", envelope);
		const c = creature(slice, envelope, id);

		return {
			slice: withCreature(slice, id, (x) => ({
				...x,
				persistent: x.persistent.filter((q) => q.damageType !== damageType),
			})),
			feed: note(`${c.name}'s persistent ${damageType} damage ends.`),
		};
	},
	"pf.hero-points-set": (slice, envelope) => {
		const { id, points } = decode("pf.hero-points-set", envelope);
		const c = creature(slice, envelope, id);

		if (c.kind !== "pc" || points < 0 || points > HERO_POINTS_MAX) {
			bad(envelope, "gives Hero Points the table can't hold");
		}

		return {
			slice: withCreature(slice, id, (x) => ({ ...x, heroPoints: points })),
			feed: note(`${c.name} has ${plural(points, "Hero Point")}.`),
		};
	},
	"pf.rerolled": (slice, envelope) => {
		const p = decode("pf.rerolled", envelope);
		const c = creature(slice, envelope, p.id);
		const last = c.lastCheck;

		if (last === undefined || last.fortune || c.heroPoints < 1) {
			bad(envelope, "rerolls a check that can't be rerolled");
		}

		if (p.natural + last.bonus !== p.total) {
			bad(envelope, "doesn't add up");
		}

		const spent = withCreature(slice, c.id, (x) => ({
			...x,
			heroPoints: x.heroPoints - 1,
		}));

		const hit =
			p.damage === undefined || last.target === undefined
				? undefined
				: hurtBy(spent, envelope, last.target, p.damage);

		const after = checked(hit?.slice ?? spent, c.id, {
			...last,
			natural: p.natural,
			...ifDefined(p.degree, (d) => ({ degree: d })),
			fortune: true,
		});

		const against = last.kind === "strike" ? "AC" : "DC";
		const versus = last.dc === undefined ? "" : ` vs ${against} ${last.dc}`;

		return {
			slice: after,
			feed: note(
				`${c.name} spends a Hero Point to reroll ${last.label}: ${rollText(p.natural, last.bonus, p.total)}${versus}${degreeText(p.degree)}, and keeps it.${hit === undefined ? "" : ` ${hit.text}.`}`
			),
		};
	},
	"pf.heroic-recovery": (slice, envelope) => {
		const { id, spent } = decode("pf.heroic-recovery", envelope);
		const c = creature(slice, envelope, id);

		if (c.kind !== "pc" || spent !== c.heroPoints || spent < 1 || c.dying < 1) {
			bad(envelope, "isn't a Heroic Recovery the table can make");
		}

		return {
			slice: withCreature(slice, id, (x) => ({
				...unhit(x),
				heroPoints: 0,
				dying: 0,
			})),
			feed: note(
				`${c.name} spends ${plural(spent, "Hero Point")} on a Heroic Recovery: no longer dying, stable at 0 HP, and no more wounded.`
			),
		};
	},
	"pf.rested": (slice, envelope) => {
		const { healed } = decode("pf.rested", envelope);

		if (slice.combat !== undefined) {
			bad(envelope, "rests in the middle of an encounter");
		}

		let next = slice;

		for (const h of healed) {
			creature(next, envelope, h.id);

			next = withCreature(next, h.id, (x) => {
				const rested = restore(x, h.hp);
				const drained = valueOf(rested, "drained");

				const lessDrained =
					drained <= 1
						? lift(rested, "drained")
						: condition(rested, { name: "drained", value: drained - 1 });

				return lift(
					{
						...lessDrained,
						doomed: Math.max(0, lessDrained.doomed - 1),
						wounded:
							lessDrained.hp >= lessDrained.sheet.hp ? 0 : lessDrained.wounded,
						slotsUsed: [],
					},
					"fatigued"
				);
			});
		}

		return {
			slice: next,
			feed: note(
				`The party rests for the night: ${healed.map((h) => `${creature(slice, envelope, h.id).name} +${h.hp} HP`).join(", ")}. Doomed and drained go down by one; spell slots are back.`
			),
		};
	},
} as const satisfies Record<EventType, Applier>;

export const apply = (slice: PfState, envelope: Envelope): Applied => {
	if (!isEventType(envelope.type)) {
		throw new Error(`pf can't apply "${envelope.type}"`);
	}

	return appliers[envelope.type](slice, envelope);
};
