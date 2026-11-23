import { Schema } from "effect";

import { ifDefined, listIfDefined } from "../../present.ts";
import { cleanText, hasTerminalControls, lengthOf, quote } from "../../text.ts";
import {
	checkGrid,
	distance,
	formatSquare,
	malformed,
	NOT_GENERATED,
	standable,
	terrainAt,
} from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import { cheapestPath, moverWalk } from "../board/movement.ts";
import { GM } from "../core/module.ts";
import type { FeedNote } from "../core/module.ts";
import { ID } from "../drawSteel/schema.ts";
import { plural } from "../drawSteel/state.ts";
import { decodePayload } from "../engine.ts";
import type { Decision, Dice, Envelope, NewEvent, Refused } from "../engine.ts";
import type { SetCommand } from "./commands.ts";
import { event, isEventType, Payloads, SetCharacterSchema } from "./events.ts";
import type { EventType, Payload } from "./events.ts";
import {
	ATTACK_STAMINA,
	controls,
	fighterOf,
	findFighter,
	idFor,
	intervalOf,
	isDown,
	living,
	mapSide,
	maxHealth,
	maxStamina,
	nextOf,
	occupants,
	RECOVERY_PER_SECOND,
	resolveFighter,
	RULES_STAMP,
	shownStamina,
	soonest,
	speedOf,
} from "./state.ts";
import type {
	Fight,
	Fighter,
	SetCharacter,
	SetSide,
	SetState,
} from "./state.ts";
import { reachOf } from "./weapons.ts";
import type { Delivery } from "./weapons.ts";

export const NAME_MAX = 24;

const STORED_NAME_MAX = 64;

const NO_MAP = "No map is loaded; the GM loads one with /map.";

const NO_FIGHT = "No fight is on; the GM starts one with /start.";

const refuse = (refusal: string): Refused => ({ refusal });

const decided = (...events: Array<NewEvent>): Decision => ({ events });

const other = (side: SetSide): SetSide => (side === "party" ? "foes" : "party");

const sideName = (side: SetSide) =>
	side === "party" ? "the party" : "the foes";

const started = (slice: SetState): Fight => {
	const next: Record<string, number> = {};

	for (const f of living(slice)) {
		next[f.id] = intervalOf(f.character);
	}

	return { clock: 0, turns: 0, next };
};

const recovered = (
	slice: SetState,
	fight: Fight,
	at: number
): Record<string, number> => {
	const seconds = (at - fight.clock) / 1000;

	return Object.fromEntries(
		living(slice).map((f) => [
			f.id,
			Math.min(
				maxStamina(f.character),
				f.stamina + RECOVERY_PER_SECOND * seconds
			),
		])
	);
};

const nextTurn = (slice: SetState, fight: Fight): NewEvent | undefined => {
	const who = soonest(slice, fight);

	if (who === undefined) {
		return undefined;
	}

	const at = nextOf(fight, who.id) ?? fight.clock;

	return event("sw.turn-began", {
		id: who.id,
		at,
		stamina: recovered(slice, fight, at),
	});
};

const ended = (fight: Fight, f: Fighter): Fight => {
	const { turn: _turn, ...rest } = fight;

	return {
		...rest,
		next: {
			...fight.next,
			[f.id]: (nextOf(fight, f.id) ?? fight.clock) + intervalOf(f.character),
		},
	};
};

export const hit = (
	attacker: SetCharacter,
	defender: SetCharacter,
	health: number,
	dice: Dice
): Omit<Payload<"sw.attacked">, "id" | "target" | "apart"> => {
	const a = attacker.attributes;
	const d = defender.attributes;
	const reach = reachOf(attacker.mainhand);

	const draw = () => {
		const face = dice(1000);

		if (!Number.isInteger(face) || face < 1 || face > 1000) {
			throw new Error(`the dice gave ${face} for a d1000`);
		}

		return face;
	};

	const dodgeChance = d.dodgeRate * (1 - a.clarity);
	const dodgeRoll = draw();
	const dodged = dodgeRoll <= Math.round(dodgeChance * 1000);
	const critRoll = dodged ? undefined : draw();

	const critical =
		critRoll !== undefined &&
		critRoll <= Math.round(a.criticalHitChance * 1000);

	const raw = reach.magic ? a.magicalDamage : a.physicalDamage;

	const reduction = reach.magic
		? d.magicalDamageReduction
		: d.physicalDamageReduction;

	const landed = dodged
		? 0
		: landedDamage(raw, reduction, d.globalResistance, critical);

	return {
		delivery: reach.delivery,
		magic: reach.magic,
		raw,
		dodgeChance,
		dodgeRoll,
		dodged,
		...ifDefined(critRoll, (value) => ({ critRoll: value })),
		critical,
		landed,
		damage: Math.min(health, landed),
	};
};

export const landedDamage = (
	raw: number,
	reduction: number,
	globalResistance: number,
	critical: boolean
): number =>
	Math.max(
		1,
		Math.floor(
			raw * (1 - reduction) * (1 - globalResistance) * (critical ? 2 : 1)
		)
	);

const cantStand = (
	slice: SetState,
	square: Square,
	f: Fighter
): string | undefined => {
	const named = formatSquare(square);
	const terrain = terrainAt(slice.map?.terrain ?? [], square);

	if (terrain === "wall") {
		return `${named} is a wall.`;
	}

	if (terrain === "outside") {
		return `${named} is outside the map.`;
	}

	const there = occupants(slice, f.id)(square);

	if (there !== undefined) {
		return `${named} is taken by ${findFighter(slice, there.id)?.name}.`;
	}

	return undefined;
};

const loadMap = (
	slice: SetState,
	command: Extract<SetCommand, { type: "set-map" }>
): Decision => {
	if (command.generate !== undefined) {
		return refuse(NOT_GENERATED);
	}

	if (command.id === undefined) {
		return slice.map === undefined
			? refuse("No map is loaded.")
			: decided(event("sw.map-cleared", {}));
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
		event("sw.map-loaded", {
			id: command.id,
			name: grid.name,
			terrain: [...grid.terrain],
			...ifDefined(grid.dressing, (value) => ({ dressing: [...value] })),
		})
	);
};

const join = (
	slice: SetState,
	command: Extract<SetCommand, { type: "set-recruit" | "set-foe" }>
): Decision => {
	if (command.character === undefined) {
		return refuse("No roll came from set.world for that; try again.");
	}

	if (!Schema.is(SetCharacterSchema)(command.character)) {
		return refuse("set.world's roll doesn't fit the table.");
	}

	const name = cleanText(command.name);

	if (name === "") {
		return refuse(
			`Usage: /${command.type === "set-recruit" ? "recruit" : "foe"} <name> [seed]`
		);
	}

	if (lengthOf(name) > NAME_MAX) {
		return refuse(`Keep a fighter's name to ${NAME_MAX} characters.`);
	}

	if (slice.fighters.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
		return refuse(`${name} is at the table already.`);
	}

	return decided(
		event("sw.fighter-joined", {
			id: idFor(slice, name),
			name,
			side: command.type === "set-recruit" ? "party" : "foes",
			character: command.character,
		})
	);
};

const play = (
	slice: SetState,
	actor: string,
	{ who, seated }: Extract<SetCommand, { type: "set-play" }>
): Decision => {
	if (actor === GM) {
		return refuse("The GM plays every fighter already.");
	}

	const f = resolveFighter(slice, who);

	if ("refusal" in f) {
		return f;
	}

	if (f.side !== "party") {
		return refuse(`${f.name} fights for the foes.`);
	}

	if (f.player === actor) {
		return refuse(`You play ${f.name} already.`);
	}

	const holder = f.player;

	const left =
		holder !== undefined &&
		holder.startsWith("guest:") &&
		seated !== undefined &&
		!seated.includes(holder);

	if (holder !== undefined && !left) {
		return refuse(`Someone else plays ${f.name}.`);
	}

	const own = fighterOf(slice, actor);

	if (own !== undefined) {
		return refuse(`You play ${own.name}; /unplay first.`);
	}

	return decided(event("sw.fighter-claimed", { id: f.id, player: actor }));
};

const unplay = (
	slice: SetState,
	actor: string,
	who: string | undefined
): Decision => {
	if (who === undefined) {
		const own = fighterOf(slice, actor);

		return own === undefined
			? refuse(
					actor === GM ? "Usage: /unplay <who>" : "You don't play a fighter."
				)
			: decided(event("sw.fighter-released", { id: own.id }));
	}

	const f = resolveFighter(slice, who);

	if ("refusal" in f) {
		return f;
	}

	if (f.player === undefined) {
		return refuse(`Nobody plays ${f.name}.`);
	}

	if (actor !== GM && f.player !== actor) {
		return refuse(`You don't play ${f.name}.`);
	}

	return decided(event("sw.fighter-released", { id: f.id }));
};

const place = (
	slice: SetState,
	actor: string,
	command: Extract<SetCommand, { type: "set-place" }>
): Decision => {
	if (slice.map === undefined) {
		return refuse(NO_MAP);
	}

	const f = resolveFighter(slice, command.who);

	if ("refusal" in f) {
		return f;
	}

	if (!controls(actor, f)) {
		return refuse("You can only place your own fighter.");
	}

	if (actor !== GM && slice.fight !== undefined && f.at !== undefined) {
		return refuse(`${f.name} is on the map already; /move instead.`);
	}

	const why = cantStand(slice, command.at, f);

	if (why !== undefined) {
		return refuse(why);
	}

	return decided(event("sw.placed", { id: f.id, at: command.at }));
};

const start = (slice: SetState): Decision => {
	if (slice.fight !== undefined) {
		return refuse("A fight is on already; /end ends it.");
	}

	if (
		living(slice, "party").length === 0 ||
		living(slice, "foes").length === 0
	) {
		return refuse(
			"A fight needs someone standing on each side: /recruit and /foe."
		);
	}

	const first = nextTurn(slice, started(slice));

	return decided(
		event("sw.fight-started", { rules: RULES_STAMP }),
		...listIfDefined(first, (value) => [value])
	);
};

const move = (
	slice: SetState,
	actor: string,
	command: Extract<SetCommand, { type: "set-move" }>
): Decision => {
	const { map } = slice;

	if (map === undefined) {
		return refuse(NO_MAP);
	}

	const f = resolveFighter(slice, command.who);

	if ("refusal" in f) {
		return f;
	}

	if (!controls(actor, f)) {
		return refuse(`You don't play ${f.name}.`);
	}

	if (f.at === undefined) {
		return refuse(`${f.name} isn't on the map; /place them first.`);
	}

	if (isDown(f)) {
		return refuse(`${f.name} is down.`);
	}

	const { fight } = slice;
	const acting = fight?.turn?.id === f.id;

	if (fight !== undefined && actor !== GM && !acting) {
		return refuse(`It isn't ${f.name}'s turn.`);
	}

	const named = formatSquare(command.to);

	if (f.at.x === command.to.x && f.at.y === command.to.y) {
		return refuse(`${f.name} is on ${named} already.`);
	}

	const why = cantStand(slice, command.to, f);

	if (why !== undefined) {
		return refuse(why);
	}

	const mover = { side: mapSide(f), prone: false };

	const path = cheapestPath(
		map.terrain,
		f.at,
		command.to,
		moverWalk(map.terrain, mover, occupants(slice, f.id))
	);

	if (path === undefined) {
		return refuse(`${f.name} can't get to ${named}.`);
	}

	if (acting && actor !== GM) {
		const left = Math.max(0, speedOf(f.character) - fight.turn.moved);

		if (path.cost > left) {
			return refuse(
				`${named} is ${plural(path.cost, "square")} away; ${f.name} has ${left} left.`
			);
		}
	}

	return decided(
		event("sw.moved", { id: f.id, at: command.to, cost: path.cost })
	);
};

const attack = (
	slice: SetState,
	actor: string,
	command: Extract<SetCommand, { type: "set-attack" }>,
	dice: Dice
): Decision => {
	const a = resolveFighter(slice, command.who);

	if ("refusal" in a) {
		return a;
	}

	const t = resolveFighter(slice, command.target);

	if ("refusal" in t) {
		return t;
	}

	if (!controls(actor, a)) {
		return refuse(`You don't play ${a.name}.`);
	}

	const { fight } = slice;

	if (fight === undefined) {
		return refuse(NO_FIGHT);
	}

	if (fight.turn?.id !== a.id) {
		return refuse(`It isn't ${a.name}'s turn.`);
	}

	if (fight.turn.attacked) {
		return refuse(`${a.name} has attacked this turn; /done ends it.`);
	}

	if (isDown(t)) {
		return refuse(`${t.name} is down.`);
	}

	if (t.side === a.side) {
		return refuse(`${t.name} fights on ${a.name}'s side.`);
	}

	if (a.stamina < ATTACK_STAMINA) {
		return refuse(
			`${a.name} has ${shownStamina(a)} stamina, short of the ${ATTACK_STAMINA} an attack costs: /done rests.`
		);
	}

	const reach = reachOf(a.character.mainhand);

	const apart =
		a.at !== undefined && t.at !== undefined ? distance(a.at, t.at) : undefined;

	if (apart !== undefined && apart > reach.squares) {
		return refuse(
			`${t.name} is ${plural(apart, "square")} away; ${a.name}'s ${a.character.mainhand} (${reach.delivery}) reaches ${reach.squares}.`
		);
	}

	const outcome = hit(a.character, t.character, t.health, dice);

	const attacked = event("sw.attacked", {
		id: a.id,
		target: t.id,
		...outcome,
		...ifDefined(apart, (value) => ({ apart: value })),
	});

	const won = winner(slice, outcome.damage < t.health ? undefined : t.id);

	return won === undefined
		? decided(attacked)
		: decided(attacked, event("sw.fight-ended", { winner: won }));
};

const winner = (slice: SetState, felled?: string): SetSide | undefined => {
	const stands = (side: SetSide) =>
		living(slice, side).some((f) => f.id !== felled);

	if (!stands("foes")) {
		return "party";
	}

	return stands("party") ? undefined : "foes";
};

const done = (slice: SetState, actor: string): Decision => {
	const { fight } = slice;

	if (fight?.turn === undefined) {
		return refuse(NO_FIGHT);
	}

	const f = findFighter(slice, fight.turn.id);

	if (f === undefined) {
		return refuse(NO_FIGHT);
	}

	if (!controls(actor, f)) {
		return refuse(`It's ${f.name}'s turn, not yours to end.`);
	}

	const won = winner(slice);

	const next: NewEvent | undefined =
		won === undefined
			? nextTurn(slice, ended(fight, f))
			: event("sw.fight-ended", { winner: won });

	return decided(
		event("sw.turn-ended", { id: f.id, rested: !fight.turn.attacked }),
		...listIfDefined(next, (value) => [value])
	);
};

type Handler = (
	slice: SetState,
	actor: string,
	command: SetCommand,
	dice: Dice
) => Decision;

const isType = <T extends SetCommand["type"]>(
	command: SetCommand,
	type: T
): command is Extract<SetCommand, { readonly type: T }> =>
	command.type === type;

const by =
	<T extends SetCommand["type"]>(
		type: T,
		run: (
			slice: SetState,
			actor: string,
			command: Extract<SetCommand, { readonly type: T }>,
			dice: Dice
		) => Decision
	): Handler =>
	(slice, actor, command, dice) =>
		isType(command, type)
			? run(slice, actor, command, dice)
			: refuse(`There is no "${command.type}" command.`);

const HANDLERS = {
	"set-map": by("set-map", (slice, _actor, command) => loadMap(slice, command)),
	"set-recruit": by("set-recruit", (slice, _actor, command) =>
		join(slice, command)
	),
	"set-foe": by("set-foe", (slice, _actor, command) => join(slice, command)),
	"set-play": by("set-play", (slice, actor, command) =>
		play(slice, actor, command)
	),
	"set-unplay": by("set-unplay", (slice, actor, command) =>
		unplay(slice, actor, command.who)
	),
	"set-place": by("set-place", (slice, actor, command) =>
		place(slice, actor, command)
	),
	"set-start": by("set-start", (slice) => start(slice)),
	"set-move": by("set-move", (slice, actor, command) =>
		move(slice, actor, command)
	),
	"set-attack": by("set-attack", (slice, actor, command, dice) =>
		attack(slice, actor, command, dice)
	),
	"set-done": by("set-done", (slice, actor) => done(slice, actor)),
	"set-end": by("set-end", (slice) =>
		slice.fight === undefined
			? refuse(NO_FIGHT)
			: decided(event("sw.fight-ended", {}))
	),
} as const satisfies Record<SetCommand["type"], Handler>;

export const decide = (
	slice: SetState,
	actor: string,
	command: SetCommand,
	dice: Dice
): Decision => HANDLERS[command.type](slice, actor, command, dice);

interface Applied {
	readonly slice: SetState;
	readonly feed?: FeedNote;
}

export const formats = {
	sw: { speaker: false, separator: "" },
	"sw-turn": { speaker: false, separator: "" },
	"sw-act": { speaker: true, separator: " " },
	"sw-claim": { speaker: true, separator: " ", plainLabel: true },
} as const;

const decode = <T extends EventType>(type: T, envelope: Envelope): Payload<T> =>
	decodePayload<Payload<T>>(Payloads[type], envelope);

const bad: (envelope: Envelope, why: string) => never = (envelope, why) => {
	throw new Error(`${envelope.type} at seq ${envelope.seq} ${why}`);
};

const fighter = (slice: SetState, envelope: Envelope, id: string): Fighter =>
	findFighter(slice, id) ??
	bad(envelope, `names '${id}', who isn't at the table`);

const withFighter = (
	slice: SetState,
	id: string,
	f: (x: Fighter) => Fighter
): SetState => ({
	...slice,
	fighters: slice.fighters.map((x) => (x.id === id ? f(x) : x)),
});

const fightOf = (slice: SetState, envelope: Envelope): Fight =>
	slice.fight ?? bad(envelope, "comes with no fight on");

const mapOf = (slice: SetState, envelope: Envelope) =>
	slice.map ?? bad(envelope, "comes with no map loaded");

const safe = (text: string) => !hasTerminalControls(text);

const safeCharacter = (c: SetCharacter) =>
	[
		c.contentVersion,
		c.className,
		c.flavor,
		c.mainhand,
		...c.gear.flatMap((g) => [g.slot, g.name]),
	].every(safe);

const offTheMap = (slice: SetState): SetState["fighters"] =>
	slice.fighters.map(({ at: _at, ...f }) => f);

const standOn = (
	slice: SetState,
	envelope: Envelope,
	id: string,
	at: Square
) => {
	if (!standable(mapOf(slice, envelope).terrain, at)) {
		bad(envelope, `puts '${id}' where nobody can stand`);
	}

	if (occupants(slice, id)(at) !== undefined) {
		bad(envelope, `puts '${id}' on someone`);
	}
};

const VERBS: Readonly<Record<Delivery, string>> = {
	melee: "strikes at",
	projectile: "shoots at",
	wave: "casts at",
	aura: "casts at",
};

type Applier = (slice: SetState, envelope: Envelope) => Applied;

const appliers = {
	"sw.fighter-joined": (slice, envelope) => {
		const { id, name, side, character } = decode("sw.fighter-joined", envelope);

		if (findFighter(slice, id) !== undefined) {
			bad(envelope, `brings '${id}' a second time`);
		}

		if (
			name.trim() === "" ||
			lengthOf(name) > STORED_NAME_MAX ||
			!safe(name) ||
			!safeCharacter(character)
		) {
			bad(envelope, "holds a name or text the table can't show");
		}

		const joined: Fighter = {
			id,
			name,
			side,
			character,
			health: maxHealth(character),
			stamina: maxStamina(character),
		};

		const fight =
			slice.fight === undefined
				? undefined
				: {
						...slice.fight,
						next: {
							...slice.fight.next,
							[id]: slice.fight.clock + intervalOf(character),
						},
					};

		const reach = reachOf(character.mainhand);

		return {
			slice: {
				...slice,
				fighters: [...slice.fighters, joined],
				...ifDefined(fight, (value) => ({ fight: value })),
			},
			feed: {
				kind: "sw",
				text: `${name} the ${character.className} ${side === "party" ? "joins the party" : "comes as a foe"}: ${joined.health} health, ${joined.stamina} stamina, a ${character.mainhand} (${reach.delivery}, reach ${reach.squares}), speed ${speedOf(character)}, set.world seed ${character.seed}.`,
			},
		};
	},
	"sw.fighter-claimed": (slice, envelope) => {
		const { id, player } = decode("sw.fighter-claimed", envelope);
		const f = fighter(slice, envelope, id);

		if (f.side !== "party") {
			bad(envelope, `gives a player '${id}', a foe`);
		}

		if (slice.fighters.some((x) => x.player === player && x.id !== id)) {
			bad(envelope, "gives a player a second fighter");
		}

		return {
			slice: withFighter(slice, id, (x) => ({ ...x, player })),
			feed: { kind: "sw-claim", text: `takes ${f.name}.`, speaker: player },
		};
	},
	"sw.fighter-released": (slice, envelope) => {
		const { id } = decode("sw.fighter-released", envelope);
		const f = fighter(slice, envelope, id);

		if (f.player === undefined) {
			bad(envelope, `frees '${id}', whom nobody plays`);
		}

		return {
			slice: withFighter(slice, id, ({ player: _player, ...x }) => x),
			feed:
				f.player === envelope.actor
					? { kind: "sw-act", text: `stops playing ${f.name}.` }
					: { kind: "sw", text: `Nobody plays ${f.name} now.` },
		};
	},
	"sw.map-loaded": (slice, envelope) => {
		const { id, name, terrain, dressing } = decode("sw.map-loaded", envelope);

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
				fighters: offTheMap(slice),
				map: {
					id,
					name,
					terrain,
					...ifDefined(dressing, (value) => ({ dressing: value })),
				},
			},
			feed: {
				kind: "sw",
				text: `The map is ${name}, ${terrain[0]?.length ?? 0} by ${terrain.length}.`,
			},
		};
	},
	"sw.map-cleared": (slice, envelope) => {
		decode("sw.map-cleared", envelope);
		mapOf(slice, envelope);
		const { map: _map, ...rest } = slice;

		return {
			slice: { ...rest, fighters: offTheMap(slice) },
			feed: { kind: "sw", text: "The map is put away." },
		};
	},
	"sw.placed": (slice, envelope) => {
		const { id, at } = decode("sw.placed", envelope);
		const f = fighter(slice, envelope, id);
		standOn(slice, envelope, id, at);

		return {
			slice: withFighter(slice, id, (x) => ({ ...x, at })),
			feed: { kind: "sw", text: `${f.name} is placed at ${formatSquare(at)}.` },
		};
	},
	"sw.moved": (slice, envelope) => {
		const { id, at, cost } = decode("sw.moved", envelope);
		const f = fighter(slice, envelope, id);

		if (f.at === undefined) {
			bad(envelope, `moves '${id}', who isn't on the map`);
		}

		if (cost < distance(f.at, at)) {
			bad(envelope, "costs less than the squares it crosses");
		}

		standOn(slice, envelope, id, at);
		const { fight } = slice;

		if (fight !== undefined && fight.turn?.id !== id && envelope.actor !== GM) {
			bad(envelope, `moves '${id}' when it isn't its turn`);
		}

		const turn =
			fight?.turn?.id === id
				? { ...fight.turn, moved: fight.turn.moved + cost }
				: undefined;

		const moved =
			fight !== undefined && turn !== undefined
				? { fight: { ...fight, turn } }
				: {};

		return {
			slice: {
				...withFighter(slice, id, (x) => ({ ...x, at })),
				...moved,
			},
			feed: {
				kind: "sw",
				text: `${f.name} moves to ${formatSquare(at)} (${plural(cost, "square")}).`,
			},
		};
	},
	"sw.fight-started": (slice, envelope) => {
		const { rules } = decode("sw.fight-started", envelope);

		if (rules !== RULES_STAMP) {
			bad(
				envelope,
				`follows rules '${rules}', not this table's '${RULES_STAMP}'`
			);
		}

		if (slice.fight !== undefined) {
			bad(envelope, "starts a fight while one is on");
		}

		return {
			slice: { ...slice, fight: started(slice) },
			feed: {
				kind: "sw-turn",
				text: "The fight begins. Turns follow initiative, on set.world's clock.",
			},
		};
	},
	"sw.turn-began": (slice, envelope) => {
		const { id, at, stamina } = decode("sw.turn-began", envelope);
		const fight = fightOf(slice, envelope);

		if (fight.turn !== undefined) {
			bad(envelope, "begins a turn while another is under way");
		}

		const f = fighter(slice, envelope, id);

		if (soonest(slice, fight)?.id !== id || fight.next[id] !== at) {
			bad(envelope, `isn't the turn initiative gives next`);
		}

		const expected = recovered(slice, fight, at);
		const keys = Object.keys(stamina);

		if (
			keys.length !== Object.keys(expected).length ||
			keys.some((k) => stamina[k] !== expected[k])
		) {
			bad(envelope, "doesn't recover stamina by the clock");
		}

		const fighters = slice.fighters.map((x) => {
			const regained = Object.hasOwn(stamina, x.id) ? stamina[x.id] : undefined;

			return regained === undefined ? x : { ...x, stamina: regained };
		});

		const now = Math.floor((Object.hasOwn(stamina, id) ? stamina[id] : 0) ?? 0);

		const tired =
			now < ATTACK_STAMINA ? " Too tired to attack: /done rests." : "";

		return {
			slice: {
				...slice,
				fighters,
				fight: {
					...fight,
					clock: at,
					turns: fight.turns + 1,
					turn: { id, moved: 0, attacked: false },
				},
			},
			feed: {
				kind: "sw-turn",
				text: `${(at / 1000).toFixed(2)} s · ${f.name}'s turn: stamina ${now}, speed ${speedOf(f.character)}.${tired}`,
			},
		};
	},
	"sw.attacked": (slice, envelope) => {
		const p = decode("sw.attacked", envelope);
		const fight = fightOf(slice, envelope);

		if (fight.turn?.id !== p.id || fight.turn.attacked) {
			bad(envelope, "isn't the acting fighter's one attack");
		}

		const a = fighter(slice, envelope, p.id);
		const t = fighter(slice, envelope, p.target);

		if (isDown(t) || t.side === a.side) {
			bad(envelope, "attacks someone who isn't a standing foe");
		}

		if (a.stamina < ATTACK_STAMINA) {
			bad(envelope, "attacks without the stamina for it");
		}

		if (
			a.at !== undefined &&
			t.at !== undefined &&
			distance(a.at, t.at) > reachOf(a.character.mainhand).squares
		) {
			bad(envelope, "attacks someone out of reach");
		}

		if (
			(p.dodged ? p.landed !== 0 : p.landed < 1) ||
			p.damage !== Math.min(t.health, p.landed) ||
			(p.critical && (p.dodged || p.critRoll === undefined))
		) {
			bad(envelope, "doesn't add up");
		}

		const health = t.health - p.damage;

		const after = withFighter(
			withFighter(slice, a.id, (x) => ({
				...x,
				stamina: x.stamina - ATTACK_STAMINA,
			})),
			t.id,
			(x) => ({ ...x, health })
		);

		const outcome = p.dodged
			? `${t.name} dodges (a ${Math.round(p.dodgeChance * 100)}% chance).`
			: `${p.critical ? "a critical hit, " : ""}${p.damage} damage → ${health}/${maxHealth(t.character)}${health <= 0 ? ", down" : ""}.`;

		return {
			slice: {
				...after,
				fight: { ...fight, turn: { ...fight.turn, attacked: true } },
			},
			feed: {
				kind: "sw",
				text: `${a.name} ${VERBS[p.delivery]} ${t.name}: ${outcome}`,
			},
		};
	},
	"sw.turn-ended": (slice, envelope) => {
		const { id, rested } = decode("sw.turn-ended", envelope);
		const fight = fightOf(slice, envelope);

		if (fight.turn?.id !== id) {
			bad(envelope, `ends a turn that isn't '${id}''s`);
		}

		if (rested === fight.turn.attacked) {
			bad(envelope, "says it rested when it attacked, or not");
		}

		const f = fighter(slice, envelope, id);

		return {
			slice: { ...slice, fight: ended(fight, f) },
			feed: {
				kind: "sw-turn",
				text: rested ? `${f.name} rests.` : `${f.name}'s turn ends.`,
			},
		};
	},
	"sw.fight-ended": (slice, envelope) => {
		const { winner: won } = decode("sw.fight-ended", envelope);
		fightOf(slice, envelope);

		if (won !== undefined && living(slice, other(won)).length > 0) {
			bad(envelope, `says ${won} won while their foes stand`);
		}

		const { fight: _fight, ...rest } = slice;

		return {
			slice: {
				...rest,
				fighters: slice.fighters.map((f) => ({
					...f,
					stamina: maxStamina(f.character),
				})),
			},
			feed: {
				kind: "sw-turn",
				text:
					won === undefined
						? "The fight is over."
						: `The fight is over: ${sideName(won)} ${won === "party" ? "wins" : "win"}.`,
			},
		};
	},
} as const satisfies Record<EventType, Applier>;

export const apply = (slice: SetState, envelope: Envelope): Applied => {
	if (!isEventType(envelope.type)) {
		throw new Error(`sw can't apply "${envelope.type}"`);
	}

	return appliers[envelope.type](slice, envelope);
};
