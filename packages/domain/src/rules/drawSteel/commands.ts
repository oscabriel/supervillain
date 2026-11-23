import { ifDefined, when } from "../../present.ts";
import { cleanText, lengthOf, orList, quote } from "../../text.ts";
import {
	completeMapArgs,
	MAP_USAGE,
	parseMapArgs,
	parseSquare,
} from "../board/grid.ts";
import type { MapGeneration, MapGrid, Square } from "../board/grid.ts";
import type { CommandSpec, CommandSpecs } from "../core/module.ts";
import { isRefused } from "../engine.ts";
import type { Refused } from "../engine.ts";
import type { HostFact, HostNeed } from "../hostFacts.ts";
import { isTrait } from "./sheets.ts";
import type { HeroSheet, StatBlock } from "./sheets.ts";
import {
	abilitiesOf,
	CONDITIONS,
	DURATIONS,
	everyone,
	heroOf,
	matching,
	pick,
	resolve,
} from "./state.ts";
import type { ConditionName, Duration, DrawSteelState, Side } from "./state.ts";

export interface ForcedCommand<K extends "push" | "pull" | "slide"> {
	readonly type: K;
	readonly who: string;
	readonly distance: number;
	readonly from?: string;
	readonly to?: Square;
}

export interface BareCommand<T extends string> {
	readonly type: T;
}

export interface AmountCommand<T extends "heal" | "temp"> {
	readonly type: T;
	readonly who: string;
	readonly amount: number;
}

export interface StepCommand<T extends "res" | "surge"> {
	readonly type: T;
	readonly who: string;
	readonly by: number;
}

export type DsCommand =
	| {
			readonly type: "hero";
			readonly hero: string;
			readonly sheet?: HeroSheet;
	  }
	| {
			readonly type: "add";
			readonly monster: string;
			readonly count: number;
			readonly as?: string;
			readonly sheet?: StatBlock;
	  }
	| {
			readonly type: "play";
			readonly hero?: string;
			readonly player?: string;
			readonly playerActor?: string;
			readonly seated?: ReadonlyArray<string>;
	  }
	| { readonly type: "unplay"; readonly hero?: string }
	| BareCommand<"start">
	| { readonly type: "first"; readonly side: Side }
	| { readonly type: "turn"; readonly who?: string }
	| BareCommand<"done">
	| BareCommand<"round">
	| BareCommand<"end">
	| BareCommand<"rest">
	| {
			readonly type: "pr";
			readonly who: string;
			readonly ability?: string;
			readonly bonus?: number;
			readonly edges: number;
			readonly banes: number;
			readonly targets?: ReadonlyArray<string>;
	  }
	| {
			readonly type: "dmg";
			readonly who: string;
			readonly amount: number;
			readonly damageType?: string;
	  }
	| AmountCommand<"heal">
	| AmountCommand<"temp">
	| { readonly type: "recover"; readonly who: string; readonly ally: boolean }
	| {
			readonly type: "cond";
			readonly who: string;
			readonly condition: ConditionName;
			readonly duration?: Duration;
			readonly remove?: boolean;
			readonly by?: string;
	  }
	| {
			readonly type: "save";
			readonly who: string;
			readonly condition?: ConditionName;
	  }
	| StepCommand<"res">
	| { readonly type: "malice"; readonly by: number; readonly reason?: string }
	| StepCommand<"surge">
	| { readonly type: "token"; readonly change: number | "reset" }
	| { readonly type: "victory"; readonly who?: string; readonly by: number }
	| {
			readonly type: "fs";
			readonly who: string;
			readonly target: string;
			readonly damageType?: string;
			readonly minions?: number;
	  }
	| {
			readonly type: "map";
			readonly id?: string;
			readonly grid?: MapGrid;
			readonly generate?: MapGeneration;
	  }
	| { readonly type: "place"; readonly who: string; readonly at: Square }
	| {
			readonly type: "move";
			readonly who: string;
			readonly to: Square;
			readonly main?: boolean;
	  }
	| { readonly type: "dist"; readonly from: string; readonly to: string }
	| ForcedCommand<"push">
	| ForcedCommand<"pull">
	| ForcedCommand<"slide">;

const AMOUNT_MAX = 999;

export const ADD_MAX = 40;

export const SQUAD_SIZE = 8;

const BONUS_MAX = 30;

const STEP_MAX = 99;

const words = (args: string) =>
	args
		.trim()
		.split(/\s+/u)
		.filter((w) => w !== "");

const amount = (s: string | undefined): number | undefined =>
	s !== undefined &&
	/^\d+$/u.test(s) &&
	Number(s) >= 1 &&
	Number(s) <= AMOUNT_MAX
		? Number(s)
		: undefined;

const signedStep = (s: string | undefined): number | undefined =>
	s !== undefined &&
	/^[+-]\d+$/u.test(s) &&
	Number(s) !== 0 &&
	Math.abs(Number(s)) <= STEP_MAX
		? Number(s)
		: undefined;

const usage = (spec: { usage: string }): Refused => ({
	refusal: `Usage: ${spec.usage}`,
});

const conditionNamed = (typed: string): ConditionName | Refused =>
	pick(
		CONDITIONS,
		(c) => [c],
		(c) => c,
		typed,
		`'${quote(typed)}' isn't a condition: ${orList([...CONDITIONS])}.`
	);

interface Modifier {
	readonly edges: number;
	readonly banes: number;
}

const MODIFIERS = new Map<string, Modifier>([
	["edge", { edges: 1, banes: 0 }],
	["edge2", { edges: 2, banes: 0 }],
	["bane", { edges: 0, banes: 1 }],
	["bane2", { edges: 0, banes: 2 }],
]);

export const completeWho = (
	slice: DrawSteelState,
	partial: string,
	actor: string
): Array<string> => {
	const own = heroOf(slice, actor)?.id;
	const all = everyone(slice);

	const ordered = [
		...all.filter((w) => w.id === own),
		...all.filter((w) => w.id !== own),
	];

	return matching(
		ordered,
		(w) => w.id,
		(w) => [w.id, w.name],
		partial
	);
};

const targetThen =
	(
		rest?: (
			slice: DrawSteelState,
			who: string,
			typed: string,
			actor: string
		) => Array<string>
	) =>
	(slice: DrawSteelState, partial: string, actor: string): Array<string> => {
		const space = partial.search(/\s/u);

		if (space === -1) {
			return completeWho(slice, partial, actor);
		}

		const who = partial.slice(0, space);
		const typed = partial.slice(space + 1).trimStart();

		return (rest?.(slice, who, typed, actor) ?? []).map((r) => `${who} ${r}`);
	};

const startingWith = (options: ReadonlyArray<string>, typed: string) =>
	options.filter((o) => o.toLowerCase().startsWith(typed.toLowerCase()));

const heroIds = (slice: DrawSteelState, partial: string) =>
	startingWith(
		slice.heroes.map((h) => h.id),
		partial.trim()
	);

type Spec<T extends DsCommand["type"]> = CommandSpec<
	Extract<DsCommand, { readonly type: T }>,
	DrawSteelState
>;

const stepFor = <T extends "res" | "surge">(
	type: T,
	summary: string
): CommandSpec<StepCommand<T>, DrawSteelState> => {
	const spec: CommandSpec<StepCommand<T>, DrawSteelState> = {
		usage: `/${type} <hero> <+N|-N>`,
		summary,
		gmOnly: false,
		parse: (args) => {
			const [who, step, extra] = words(args);
			const by = signedStep(step);

			if (who === undefined || by === undefined || extra !== undefined) {
				return usage(spec);
			}

			return { type, who, by };
		},
		complete: targetThen(),
	};

	return spec;
};

const amountFor = <T extends "heal" | "temp">(
	type: T,
	summary: string
): CommandSpec<AmountCommand<T>, DrawSteelState> => {
	const spec: CommandSpec<AmountCommand<T>, DrawSteelState> = {
		usage: `/${type} <who> <n>`,
		summary,
		gmOnly: false,
		parse: (args) => {
			const [who, n, extra] = words(args);
			const value = amount(n);

			if (who === undefined || value === undefined || extra !== undefined) {
				return usage(spec);
			}

			return { type, who, amount: value };
		},
		complete: targetThen(),
	};

	return spec;
};

const bare = <T extends "start" | "done" | "round" | "end" | "rest">(
	type: T,
	summary: string,
	gmOnly: boolean
): CommandSpec<BareCommand<T>, DrawSteelState> => ({
	usage: `/${type}`,
	summary,
	gmOnly,
	parse: () => ({ type }),
});

const hero: Spec<"hero"> = {
	usage: "/hero <hero id>",
	summary: "Bring a hero into the party from its sheet, or reload the sheet.",
	gmOnly: true,
	parse: (args) => {
		const [id, extra] = words(args);

		return id === undefined || extra !== undefined
			? usage(hero)
			: { type: "hero", hero: id.toLowerCase() };
	},
	complete: heroIds,
};

const ADD_ARGS =
	/^(?<monster>\S+)(?:\s+[x×](?<times>\d+))?(?:\s+as\s+(?<named>.+))?$/iu;

const MINIONS = /^[x×](?<count>\d+)$/iu;

const MOVE_TAIL = /^(?<head>\S+\s+)(?<last>\S*)$/u;

const FORCE_SOURCE = /^(?<head>\d+\s+(?:.*\s)?from\s+)(?<last>\S*)$/iu;

const FORCE_TAIL = /^(?<head>\d+\s+(?:.*\s)?)(?<last>\S*)$/u;

const add: Spec<"add"> = {
	usage: "/add <monster id> [xN] [as <name>]",
	summary: "Add creatures from a stat block; minions form squads of up to 8.",
	gmOnly: true,
	parse: (args) => {
		const groups = ADD_ARGS.exec(args.trim())?.groups;

		if (groups === undefined) {
			return usage(add);
		}

		const { monster = "", times, named } = groups;
		const count = times === undefined ? 1 : Number(times);

		if (count < 1 || count > ADD_MAX) {
			return { refusal: `Add 1 to ${ADD_MAX} at a time.` };
		}

		const as = named?.trim() ?? "";

		return {
			type: "add",
			monster: monster.toLowerCase(),
			count,
			...when(as !== "", () => ({ as })),
		};
	},
	complete: (slice, partial) =>
		startingWith(Object.keys(slice.blocks), partial.trim()),
};

const play: Spec<"play"> = {
	usage: "/play <hero> [player]",
	summary: "Play a hero. The GM names a player to give them one.",
	gmOnly: false,
	parse: (args) => {
		const [id, ...rest] = words(args);

		if (id === undefined) {
			return { type: "play" };
		}

		const player = rest.join(" ");

		return player === ""
			? { type: "play", hero: id }
			: { type: "play", hero: id, player };
	},
	complete: (slice, partial) =>
		startingWith(
			slice.heroes.filter((h) => h.player === undefined).map((h) => h.id),
			partial.trim()
		),
};

const unplay: Spec<"unplay"> = {
	usage: "/unplay [hero]",
	summary: "Stop playing your hero. The GM names any hero to free it.",
	gmOnly: false,
	parse: (args) => {
		const [id, extra] = words(args);

		if (extra !== undefined) {
			return usage(unplay);
		}

		return id === undefined ? { type: "unplay" } : { type: "unplay", hero: id };
	},
	complete: (slice, partial) =>
		startingWith(
			slice.heroes.filter((h) => h.player !== undefined).map((h) => h.id),
			partial.trim()
		),
};

const first: Spec<"first"> = {
	usage: "/first heroes|director",
	summary: "Say which side goes first, every round.",
	gmOnly: true,
	parse: (args) => {
		const typed = args.trim().toLowerCase();

		if (typed === "") {
			return usage(first);
		}

		if ("heroes".startsWith(typed) || "players".startsWith(typed)) {
			return { type: "first", side: "heroes" };
		}

		if ("director".startsWith(typed)) {
			return { type: "first", side: "director" };
		}

		return usage(first);
	},
	complete: (_slice, partial) =>
		startingWith(["heroes", "director"], partial.trim()),
};

const turn: Spec<"turn"> = {
	usage: "/turn [who]",
	summary: "Start a turn (your hero's, by default); the turn before ends.",
	gmOnly: false,
	parse: (args) => {
		const [who, extra] = words(args);

		if (extra !== undefined) {
			return usage(turn);
		}

		return who === undefined ? { type: "turn" } : { type: "turn", who };
	},
	complete: (slice, partial, actor) =>
		completeWho(slice, partial, actor).filter(
			(id) => !slice.combat.acted.includes(id)
		),
};

const modifiersOff = (
	rest: Array<string>,
	into: { edges: number; banes: number }
): void => {
	let modifier = MODIFIERS.get((rest.at(-1) ?? "").toLowerCase());

	while (modifier !== undefined) {
		rest.pop();
		into.edges += modifier.edges;
		into.banes += modifier.banes;
		modifier = MODIFIERS.get((rest.at(-1) ?? "").toLowerCase());
	}
};

export interface TypedRoll {
	readonly roll: string;
	readonly edges: number;
	readonly banes: number;
	readonly targets: ReadonlyArray<string>;
}

const keywordsOff = (rest: Array<string>): TypedRoll | Refused => {
	const modifiers = { edges: 0, banes: 0 };
	modifiersOff(rest, modifiers);
	const on = rest.findLastIndex((w) => w.toLowerCase() === "on");
	const targets = on === -1 ? [] : rest.splice(on).slice(1);

	if (on !== -1 && targets.length === 0) {
		return usage(pr);
	}

	modifiersOff(rest, modifiers);

	return { roll: rest.join(" "), ...modifiers, targets };
};

export const splitRoll = (
	typed: string,
	names: ReadonlyArray<string>
): TypedRoll | Refused => {
	const rest = words(typed);

	for (const name of names.toSorted((a, b) => b.length - a.length)) {
		const own = words(name);

		if (!own.every((w, i) => w.toLowerCase() === rest[i]?.toLowerCase())) {
			continue;
		}

		const after = keywordsOff(rest.slice(own.length));

		if (!("refusal" in after) && after.roll === "") {
			return { ...after, roll: name };
		}
	}

	const split = keywordsOff(rest);

	return "refusal" in split || split.roll !== "" ? split : usage(pr);
};

const pr: Spec<"pr"> = {
	usage: "/pr <who> <ability|+N> [edge|bane|edge2|bane2] [on <target>…]",
	summary:
		"Power roll with the tier's result and its damage to each target, or use an ability.",
	gmOnly: false,
	parse: (args) => {
		const [who, ...rest] = words(args);

		if (who === undefined || rest.length === 0) {
			return usage(pr);
		}

		const typed = rest.join(" ");
		const split = keywordsOff(rest);

		if ("refusal" in split || !/^[+-]\d+$/u.test(split.roll)) {
			return { type: "pr", who, ability: typed, edges: 0, banes: 0 };
		}

		const { roll, edges, banes, targets } = split;
		const bonus = Number(roll);

		if (Math.abs(bonus) > BONUS_MAX) {
			return { refusal: `Keep the bonus within ${BONUS_MAX} either way.` };
		}

		return {
			type: "pr",
			who,
			bonus,
			edges,
			banes,
			...when(targets.length > 0, () => ({ targets })),
		};
	},
	complete: targetThen((slice, who, typed) => {
		const found = resolve(slice, who);

		if ("refusal" in found) {
			return [];
		}

		return matching(
			abilitiesOf(slice, found).filter((a) => !isTrait(a)),
			(a) => a.name,
			(a) => [a.name],
			typed
		);
	}),
};

const dmg: Spec<"dmg"> = {
	usage: "/dmg <who> <n> [type]",
	summary: "Deal damage: temporary Stamina first, after weakness and immunity.",
	gmOnly: false,
	parse: (args) => {
		const [who, n, type, extra] = words(args);
		const value = amount(n);

		if (who === undefined || value === undefined || extra !== undefined) {
			return usage(dmg);
		}

		if (type !== undefined && !/^[a-z]{1,20}$/iu.test(type)) {
			return usage(dmg);
		}

		return type === undefined
			? { type: "dmg", who, amount: value }
			: { type: "dmg", who, amount: value, damageType: type.toLowerCase() };
	},
	complete: targetThen(),
};

const recover: Spec<"recover"> = {
	usage: "/recover <hero> [ally]",
	summary:
		"Spend a Recovery to regain a third of max Stamina; 'ally' while dying.",
	gmOnly: false,
	parse: (args) => {
		const [who, ally, extra] = words(args);

		if (who === undefined || extra !== undefined) {
			return usage(recover);
		}

		if (ally !== undefined && ally.toLowerCase() !== "ally") {
			return usage(recover);
		}

		return { type: "recover", who, ally: ally !== undefined };
	},
	complete: targetThen((_slice, _who, typed) => startingWith(["ally"], typed)),
};

const durationNamed = (typed: string): Duration | undefined =>
	DURATIONS.find((d) => d === typed.toLowerCase());

const COND_WORDS: ReadonlyArray<ReadonlyArray<string>> = [
	[],
	[...DURATIONS, "by"],
	["by"],
];

const COND_TAIL = /^(?<head>(?:\S+\s+)*)(?<last>\S*)$/u;

const cond: Spec<"cond"> = {
	usage: "/cond <who> [-]<condition> [eot|save|end] [by <who>]",
	summary:
		"Set a condition (to end of encounter unless EoT or save ends), with who grabbed, frightened or taunted them, or remove it with -.",
	gmOnly: false,
	parse: (args) => {
		const [who, name, ...rest] = words(args);

		if (who === undefined || name === undefined) {
			return usage(cond);
		}

		const remove = name.startsWith("-");
		const condition = conditionNamed(remove ? name.slice(1) : name);

		if (isRefused(condition)) {
			return condition;
		}

		if (remove) {
			return rest.length === 0
				? { type: "cond", who, condition, remove }
				: usage(cond);
		}

		const [lead, ...more] = rest;
		const duration = lead === undefined ? undefined : durationNamed(lead);
		const tail = duration === undefined ? rest : more;
		const [word, source, extra] = tail;

		if (word === undefined) {
			return duration === undefined
				? { type: "cond", who, condition }
				: { type: "cond", who, condition, duration };
		}

		if (
			word.toLowerCase() !== "by" ||
			source === undefined ||
			extra !== undefined
		) {
			return usage(cond);
		}

		return {
			type: "cond",
			who,
			condition,
			...ifDefined(duration, (value) => ({ duration: value })),
			by: source,
		};
	},
	complete: targetThen((slice, _who, typed, actor) => {
		const space = typed.search(/\s/u);

		if (space === -1) {
			const minus = typed.startsWith("-") ? "-" : "";

			return startingWith(CONDITIONS, typed.slice(minus.length)).map(
				(c) => `${minus}${c}`
			);
		}

		const { head = "", last = "" } = COND_TAIL.exec(typed)?.groups ?? {};
		const said = words(head);

		if (said.at(-1)?.toLowerCase() === "by") {
			return completeWho(slice, last, actor).map((id) => `${head}${id}`);
		}

		return startingWith(COND_WORDS[said.length] ?? [], last).map(
			(d) => `${head}${d}`
		);
	}),
};

const save: Spec<"save"> = {
	usage: "/save <who> [condition]",
	summary: "Roll a save (d10, 6+) against save-ends conditions.",
	gmOnly: false,
	parse: (args) => {
		const [who, name, extra] = words(args);

		if (who === undefined || extra !== undefined) {
			return usage(save);
		}

		if (name === undefined) {
			return { type: "save", who };
		}

		const condition = conditionNamed(name);

		return isRefused(condition) ? condition : { type: "save", who, condition };
	},
	complete: targetThen((slice, who, typed) => {
		const found = resolve(slice, who);

		if ("refusal" in found) {
			return [];
		}

		const conditions =
			found.kind === "hero" ? found.hero.conditions : found.creature.conditions;

		return startingWith(
			conditions.filter((c) => c.duration === "save").map((c) => c.name),
			typed
		);
	}),
};

const REASON_MAX = 40;

const malice: Spec<"malice"> = {
	usage: "/malice <+N|-N> [reason]",
	summary: "Gain or spend Malice, saying what for if you like.",
	gmOnly: true,
	parse: (args) => {
		const [step, ...rest] = words(args);
		const by = signedStep(step);

		if (by === undefined) {
			return usage(malice);
		}

		const reason = cleanText(rest.join(" "));

		if (lengthOf(reason) > REASON_MAX) {
			return { refusal: `Keep the reason to ${REASON_MAX} characters.` };
		}

		return reason === ""
			? { type: "malice", by }
			: { type: "malice", by, reason };
	},
};

const token: Spec<"token"> = {
	usage: "/token <+N|-N|reset>",
	summary: "Spend hero tokens. The GM adds them, or resets to one per hero.",
	gmOnly: false,
	parse: (args) => {
		const [step, extra] = words(args);

		if (extra !== undefined) {
			return usage(token);
		}

		if (step?.toLowerCase() === "reset") {
			return { type: "token", change: "reset" };
		}

		const by = signedStep(step);

		return by === undefined ? usage(token) : { type: "token", change: by };
	},
	complete: (_slice, partial) => startingWith(["-1", "reset"], partial.trim()),
};

const victory: Spec<"victory"> = {
	usage: "/victory [hero] <+N|-N>",
	summary:
		"Award Victories to one hero or all of them; they feed the next /start.",
	gmOnly: true,
	parse: (args) => {
		const parts = words(args);
		const by = signedStep(parts.at(-1));

		if (by === undefined || parts.length > 2) {
			return usage(victory);
		}

		const who = parts.length === 2 ? parts[0] : undefined;

		return who === undefined || who.toLowerCase() === "all"
			? { type: "victory", by }
			: { type: "victory", who, by };
	},
	complete: (slice, partial) =>
		startingWith(["all", ...slice.heroes.map((h) => h.id)], partial.trim()),
};

const fs: Spec<"fs"> = {
	usage: "/fs <creature> <target> [type] [xN]",
	summary:
		"A free strike: fixed damage, of a type if named; xN minions of a squad strike together.",
	gmOnly: true,
	parse: (args) => {
		const [who, target, ...rest] = words(args);

		if (who === undefined || target === undefined || rest.length > 2) {
			return usage(fs);
		}

		let damageType: string | undefined;
		let minions: number | undefined;

		for (const word of rest) {
			const count = MINIONS.exec(word)?.groups?.count;

			if (count !== undefined && minions === undefined && Number(count) >= 1) {
				minions = Math.min(Number(count), SQUAD_SIZE);
			} else if (/^[a-z]{1,20}$/iu.test(word) && damageType === undefined) {
				damageType = word.toLowerCase();
			} else {
				return usage(fs);
			}
		}

		return {
			type: "fs",
			who,
			target,
			...ifDefined(damageType, (value) => ({ damageType: value })),
			...ifDefined(minions, (value) => ({ minions: value })),
		};
	},
	complete: targetThen((slice, _who, typed, actor) =>
		completeWho(slice, typed, actor)
	),
};

const FORCED_MAX = 20;

const notASquare = (typed: string): Refused => ({
	refusal: `'${quote(typed)}' isn't a square like c5.`,
});

const map: Spec<"map"> = {
	usage: MAP_USAGE,
	summary:
		"Load a map from the campaign's maps folder, generate one there, or put it away.",
	gmOnly: true,
	parse: (args) => {
		const parsed = parseMapArgs(args);

		if ("refusal" in parsed) {
			return parsed;
		}

		if (parsed.generate !== undefined) {
			return { type: "map", generate: parsed.generate };
		}

		return parsed.id === undefined
			? { type: "map" }
			: { type: "map", id: parsed.id };
	},
	complete: (_slice, partial) => completeMapArgs(partial),
};

const place: Spec<"place"> = {
	usage: "/place <who> <square>",
	summary: "Put a token on the map at a square like c5.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra] = words(args);

		if (who === undefined || typed === undefined || extra !== undefined) {
			return usage(place);
		}

		const square = parseSquare(typed);

		return square === undefined
			? notASquare(typed)
			: { type: "place", who, at: square };
	},
	complete: targetThen(),
};

const move: Spec<"move"> = {
	usage: "/move <who> <square> [main]",
	summary:
		"Move by the shortest path, up to speed a turn; main to move again with the main action.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra, more] = words(args);

		if (who === undefined || typed === undefined || more !== undefined) {
			return usage(move);
		}

		if (extra !== undefined && extra.toLowerCase() !== "main") {
			return usage(move);
		}

		const square = parseSquare(typed);

		if (square === undefined) {
			return notASquare(typed);
		}

		return extra === undefined
			? { type: "move", who, to: square }
			: { type: "move", who, to: square, main: true };
	},
	complete: targetThen((_slice, _who, typed) => {
		const { head, last } = MOVE_TAIL.exec(typed)?.groups ?? {};

		return head === undefined || last === undefined
			? []
			: startingWith(["main"], last).map((m) => `${head}${m}`);
	}),
};

const dist: Spec<"dist"> = {
	usage: "/dist <who|square> <who|square>",
	summary: "Count the squares between tokens or squares.",
	gmOnly: false,
	parse: (args) => {
		const [from, to, extra] = words(args);

		if (from === undefined || to === undefined || extra !== undefined) {
			return usage(dist);
		}

		return { type: "dist", from, to };
	},
	complete: targetThen((slice, _who, typed, actor) =>
		completeWho(slice, typed, actor)
	),
};

const forced = <K extends "push" | "pull" | "slide">(
	type: K,
	summary: string
): CommandSpec<ForcedCommand<K>, DrawSteelState> => {
	const spec: CommandSpec<ForcedCommand<K>, DrawSteelState> = {
		usage:
			type === "slide"
				? `/slide <who> <n> to <square> [from <who>]`
				: `/${type} <who> <n> [from <who>] [to <square>]`,
		summary,
		gmOnly: false,
		parse: (args) => {
			const [who, n, ...rest] = words(args);

			if (who === undefined || n === undefined || !/^\d+$/u.test(n)) {
				return usage(spec);
			}

			const distance = Number(n);

			if (distance < 1 || distance > FORCED_MAX) {
				return { refusal: `Force move 1 to ${FORCED_MAX} squares at a time.` };
			}

			let from: string | undefined;
			let to: Square | undefined;

			for (let i = 0; i < rest.length; i += 2) {
				const word = (rest[i] ?? "").toLowerCase();
				const value = rest[i + 1];

				if (value === undefined) {
					return usage(spec);
				}

				if (word === "from" && from === undefined) {
					from = value;
				} else if (word === "to" && to === undefined) {
					to = parseSquare(value);

					if (to === undefined) {
						return notASquare(value);
					}
				} else {
					return usage(spec);
				}
			}

			if (type === "slide" && to === undefined) {
				return { refusal: `Say where: /slide ${who} ${n} to <square>.` };
			}

			return {
				type,
				who,
				distance,
				...ifDefined(from, (value) => ({ from: value })),
				...ifDefined(to, (value) => ({ to: value })),
			};
		},
		complete: targetThen((slice, _who, typed, actor) => {
			const source = FORCE_SOURCE.exec(typed)?.groups;

			if (source?.head !== undefined && source.last !== undefined) {
				const { head, last } = source;

				return completeWho(slice, last, actor).map((id) => `${head}${id}`);
			}

			const { head, last } = FORCE_TAIL.exec(typed)?.groups ?? {};

			return head === undefined || last === undefined
				? []
				: startingWith(["from", "to"], last).map((w) => `${head}${w}`);
		}),
	};

	return spec;
};

export const commands: CommandSpecs<DsCommand, DrawSteelState> = {
	hero,
	play,
	unplay,
	add,
	start: bare(
		"start",
		"Start a combat: who picks first, then resources and Malice.",
		true
	),
	first,
	turn,
	done: bare(
		"done",
		"End the current turn: EoT conditions end, save-ends roll a save.",
		false
	),
	round: bare("round", "Start the next round now.", true),
	end: bare(
		"end",
		"End the combat: resources, surges and Malice are lost, conditions end.",
		true
	),
	rest: bare(
		"rest",
		"A respite: Stamina and Recoveries back to full, Victories to XP.",
		true
	),
	pr,
	dmg,
	heal: amountFor("heal", "Regain Stamina, up to max."),
	temp: amountFor(
		"temp",
		"Gain temporary Stamina; it doesn't stack, the larger stays."
	),
	recover,
	cond,
	save,
	res: stepFor("res", "Gain or spend heroic resource."),
	surge: stepFor("surge", "Gain or spend surges."),
	malice,
	token,
	victory,
	fs,
	map,
	place,
	move,
	dist,
	push: forced("push", "Push straight away from the source, less stability."),
	pull: forced("pull", "Pull straight toward the source, less stability."),
	slide: forced("slide", "Slide any way to a square, less stability."),
};

const mapNeed = (
	command: Extract<DsCommand, { readonly type: "map" }>
): HostNeed | undefined => {
	if (command.grid !== undefined) {
		return undefined;
	}

	if (command.generate !== undefined) {
		return { kind: "generate", generation: command.generate };
	}

	return command.id === undefined ? undefined : { kind: "map", id: command.id };
};

const playNeed = (
	command: Extract<DsCommand, { readonly type: "play" }>
): HostNeed | undefined => {
	if (command.seated === undefined) {
		return { kind: "seated" };
	}

	return command.player !== undefined && command.playerActor === undefined
		? { kind: "player", label: command.player }
		: undefined;
};

export const dsHostNeed = (command: DsCommand): HostNeed | undefined => {
	if (command.type === "map") {
		return mapNeed(command);
	}

	if (command.type === "hero" && command.sheet === undefined) {
		return { kind: "hero", id: command.hero };
	}

	if (command.type === "add" && command.sheet === undefined) {
		return { kind: "monster", id: command.monster };
	}

	return command.type === "play" ? playNeed(command) : undefined;
};

const filledMap = (
	command: Extract<DsCommand, { readonly type: "map" }>,
	fact: HostFact
): DsCommand => {
	if (fact.kind === "generated") {
		return { type: "map", id: fact.id };
	}

	return fact.kind === "map"
		? { type: "map", id: fact.id, grid: fact.grid }
		: command;
};

export const dsFillHostFact = (
	command: DsCommand,
	fact: HostFact
): DsCommand => {
	if (command.type === "map") {
		return filledMap(command, fact);
	}

	if (command.type === "hero" && fact.kind === "hero") {
		return { ...command, sheet: fact.sheet };
	}

	if (command.type === "add" && fact.kind === "monster") {
		return { ...command, sheet: fact.sheet };
	}

	if (command.type === "play" && fact.kind === "seated") {
		return { ...command, seated: fact.seated };
	}

	return command.type === "play" && fact.kind === "player"
		? { ...command, playerActor: fact.actor }
		: command;
};
