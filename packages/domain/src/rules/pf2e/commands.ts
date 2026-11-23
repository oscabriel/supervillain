import { ifDefined, when } from "../../present.ts";
import { quote } from "../../text.ts";
import {
	completeMapArgs,
	MAP_USAGE,
	parseMapArgs,
	parseSquare,
} from "../board/grid.ts";
import type { MapGeneration, MapGrid, Square } from "../board/grid.ts";
import type { CommandSpec, CommandSpecs } from "../core/module.ts";
import type { Refused } from "../engine.ts";
import type { HostFact, HostNeed } from "../hostFacts.ts";
import type { Maneuver } from "./events.ts";
import type { Adjustment } from "./math.ts";
import { SAVES, SKILLS } from "./sheets.ts";
import type { PfSave, PfSheet } from "./sheets.ts";
import { completeCreatures, CONDITIONS, COUNTERS, isDead } from "./state.ts";
import type { PfExpiry, PfState } from "./state.ts";

export type Cover = "lesser" | "standard" | "greater";

export const COVERS: ReadonlyArray<Cover> = ["lesser", "standard", "greater"];

export interface BarePf<T extends string> {
	readonly type: T;
}

export interface WhoCommand<T extends string> {
	readonly type: T;
	readonly who: string;
}

export interface SquareCommand<T extends string> {
	readonly type: T;
	readonly who: string;
	readonly to: Square;
}

export interface ManeuverCommand<T extends string> {
	readonly type: T;
	readonly who: string;
	readonly target: string;
	readonly modifier?: number;
}

export type PfCommand =
	| { readonly type: "pf-pc"; readonly id: string; readonly sheet?: PfSheet }
	| {
			readonly type: "pf-add";
			readonly monster: string;
			readonly count: number;
			readonly adjustment?: Adjustment;
			readonly as?: string;
			readonly sheet?: PfSheet;
	  }
	| {
			readonly type: "pf-play";
			readonly who: string;
			readonly seated?: ReadonlyArray<string>;
	  }
	| { readonly type: "pf-unplay"; readonly who?: string }
	| {
			readonly type: "pf-init";
			readonly who?: string;
			readonly skill?: string;
	  }
	| BarePf<"pf-start">
	| WhoCommand<"pf-turn">
	| BarePf<"pf-done">
	| BarePf<"pf-delay">
	| WhoCommand<"pf-join">
	| BarePf<"pf-end">
	| {
			readonly type: "pf-strike";
			readonly who: string;
			readonly weapon: string;
			readonly target: string;
			readonly modifier?: number;
			readonly cover?: Cover;
			readonly reaction?: boolean;
	  }
	| SquareCommand<"pf-stride">
	| SquareCommand<"pf-step">
	| SquareCommand<"pf-crawl">
	| SquareCommand<"pf-move">
	| SquareCommand<"pf-place">
	| WhoCommand<"pf-stand">
	| WhoCommand<"pf-drop">
	| WhoCommand<"pf-shield">
	| {
			readonly type: "pf-block";
			readonly who: string;
			readonly damage?: number;
	  }
	| ManeuverCommand<"pf-grapple">
	| ManeuverCommand<"pf-trip">
	| ManeuverCommand<"pf-shove">
	| ManeuverCommand<"pf-disarm">
	| ManeuverCommand<"pf-demoralize">
	| {
			readonly type: "pf-check";
			readonly who: string;
			readonly skill: string;
			readonly dc?: number;
			readonly modifier?: number;
	  }
	| {
			readonly type: "pf-save";
			readonly who: string;
			readonly save: PfSave;
			readonly dc: number;
			readonly basic?: string;
			readonly damageType?: string;
	  }
	| { readonly type: "pf-flat"; readonly who: string; readonly dc: number }
	| {
			readonly type: "pf-cast";
			readonly who: string;
			readonly spell: string;
			readonly rank?: number;
			readonly targets: ReadonlyArray<string>;
	  }
	| {
			readonly type: "pf-dmg";
			readonly who: string;
			readonly amount: string;
			readonly damageType?: string;
			readonly critical?: boolean;
	  }
	| { readonly type: "pf-heal"; readonly who: string; readonly amount: string }
	| { readonly type: "pf-temp"; readonly who: string; readonly amount: number }
	| {
			readonly type: "pf-cond";
			readonly who: string;
			readonly name: string;
			readonly value?: number;
			readonly expires?: PfExpiry;
			readonly by?: string;
			readonly remove?: boolean;
			readonly damageType?: string;
			readonly dice?: string;
	  }
	| {
			readonly type: "pf-hp";
			readonly who: string;
			readonly by?: number;
			readonly reset?: boolean;
	  }
	| WhoCommand<"pf-reroll">
	| WhoCommand<"pf-recover">
	| BarePf<"pf-rest">
	| {
			readonly type: "pf-map";
			readonly id?: string;
			readonly grid?: MapGrid;
			readonly generate?: MapGeneration;
	  }
	| {
			readonly type: "pf-dist";
			readonly who: string;
			readonly target: string;
	  };

export type PfCommandType = PfCommand["type"];

export type PfOf<T extends PfCommandType> = Extract<
	PfCommand,
	{ readonly type: T }
>;

type Spec<T extends PfCommandType> = CommandSpec<PfOf<T>, PfState>;

export const ADD_MAX = 20;

const SIGNED = /^[+-]\d+$/u;

const WHOLE = /^\d+$/u;

const words = (args: string): Array<string> =>
	args
		.trim()
		.split(/\s+/u)
		.filter((w) => w !== "");

const usage = (text: string): Refused => ({ refusal: `Usage: ${text}` });

const notASquare = (typed: string): Refused => ({
	refusal: `'${quote(typed)}' isn't a square like c5.`,
});

type Completer = (
	slice: PfState,
	partial: string,
	actor: string
) => Array<string>;

const whoThen =
	(then?: (slice: PfState, typed: string, actor: string) => Array<string>) =>
	(slice: PfState, partial: string, actor: string): Array<string> => {
		const space = partial.search(/\s/u);

		if (space === -1) {
			return completeCreatures(slice, partial, actor);
		}

		const who = partial.slice(0, space);
		const typed = partial.slice(space + 1).trimStart();

		return (then?.(slice, typed, actor) ?? []).map((r) => `${who} ${r}`);
	};

const living: Completer = (slice, typed, actor) =>
	completeCreatures(slice, typed, actor, (c) => !isDead(c));

const startingWith = (
	options: ReadonlyArray<string>,
	partial: string
): Array<string> =>
	options.filter((o) => o.startsWith(partial.trim().toLowerCase()));

const bare = <T extends PfCommandType>(
	type: T,
	name: string,
	summary: string,
	gmOnly: boolean
): CommandSpec<BarePf<T>, PfState> => ({
	name,
	usage: `/${name}`,
	summary,
	gmOnly,
	parse: (args) =>
		args.trim() === "" ? { type } : { refusal: `Usage: /${name}` },
});

const whoOnly = <T extends PfCommandType>(
	type: T,
	name: string,
	summary: string,
	gmOnly = false
): CommandSpec<WhoCommand<T>, PfState> => ({
	name,
	usage: `/${name} <who>`,
	summary,
	gmOnly,
	parse: (args) => {
		const [who, extra] = words(args);

		return who === undefined || extra !== undefined
			? usage(`/${name} <who>`)
			: { type, who };
	},
	complete: whoThen(),
});

const toSquare = <T extends PfCommandType>(
	type: T,
	name: string,
	summary: string
): CommandSpec<SquareCommand<T>, PfState> => ({
	name,
	usage: `/${name} <who> <square>`,
	summary,
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra] = words(args);

		if (who === undefined || typed === undefined || extra !== undefined) {
			return usage(`/${name} <who> <square>`);
		}

		const to = parseSquare(typed);

		return to === undefined ? notASquare(typed) : { type, who, to };
	},
	complete: whoThen(),
});

const maneuver = <T extends PfCommandType>(
	type: T,
	name: Maneuver,
	summary: string
): CommandSpec<ManeuverCommand<T>, PfState> => ({
	name,
	usage: `/${name} <who> <target> [+N|-N]`,
	summary,
	gmOnly: false,
	parse: (args) => {
		const [who, target, mod, extra] = words(args);

		if (
			who === undefined ||
			target === undefined ||
			extra !== undefined ||
			(mod !== undefined && !SIGNED.test(mod))
		) {
			return usage(`/${name} <who> <target> [+N|-N]`);
		}

		return mod === undefined
			? { type, who, target }
			: { type, who, target, modifier: Number(mod) };
	},
	complete: whoThen(living),
});

const pc: Spec<"pf-pc"> = {
	name: "pc",
	usage: "/pc <hero id>",
	summary:
		"Bring a PC into the party from heroes/<id>.yaml, or load its sheet again.",
	gmOnly: true,
	parse: (args) => {
		const [id, extra] = words(args);

		return id === undefined || extra !== undefined
			? usage("/pc <hero id>")
			: { type: "pf-pc", id: id.toLowerCase() };
	},
};

const ADJUSTMENTS: ReadonlyArray<Adjustment> = ["elite", "weak"];

const add: Spec<"pf-add"> = {
	name: "add",
	usage: "/add <monster> [xN] [elite|weak] [as <name>]",
	summary:
		"Add creatures from monsters/<id>.yaml, elite or weak if you like, numbered when more than one.",
	gmOnly: true,
	parse: (args) => {
		const parts = words(args);
		const asAt = parts.indexOf("as");
		const head = asAt === -1 ? parts : parts.slice(0, asAt);
		const named = asAt === -1 ? undefined : parts.slice(asAt + 1).join(" ");
		const [monster, ...rest] = head;
		const counted = rest.find((w) => /^x\d+$/iu.test(w));
		const adjustment = ADJUSTMENTS.find((a) => rest.includes(a));

		const unknown = rest.filter(
			(w) => w !== counted && !ADJUSTMENTS.some((a) => a === w)
		);

		if (monster === undefined || unknown.length > 0 || named === "") {
			return usage(add.usage);
		}

		const count = counted === undefined ? 1 : Number(counted.slice(1));

		if (count < 1 || count > ADD_MAX) {
			return { refusal: `Add 1 to ${ADD_MAX} creatures at a time.` };
		}

		return {
			type: "pf-add",
			monster: monster.toLowerCase(),
			count,
			...ifDefined(adjustment, (value) => ({ adjustment: value })),
			...ifDefined(named, (value) => ({ as: value })),
		};
	},
};

const play: Spec<"pf-play"> = {
	name: "play",
	usage: "/play <who>",
	summary: "Play a PC nobody else plays.",
	gmOnly: false,
	parse: (args) => {
		const [who, extra] = words(args);

		return who === undefined || extra !== undefined
			? usage("/play <who>")
			: { type: "pf-play", who };
	},
	complete: (slice, partial, actor) =>
		completeCreatures(
			slice,
			partial,
			actor,
			(c) => c.kind === "pc" && c.player === undefined
		),
};

const unplay: Spec<"pf-unplay"> = {
	name: "unplay",
	usage: "/unplay [who]",
	summary: "Stop playing your PC. The GM names any PC to free it.",
	gmOnly: false,
	parse: (args) => {
		const [who, extra] = words(args);

		if (extra !== undefined) {
			return usage("/unplay [who]");
		}

		return who === undefined
			? { type: "pf-unplay" }
			: { type: "pf-unplay", who };
	},
	complete: (slice, partial, actor) =>
		completeCreatures(slice, partial, actor, (c) => c.player !== undefined),
};

const init: Spec<"pf-init"> = {
	name: "init",
	usage: "/init [who] [skill]",
	summary:
		"Roll initiative: Perception, or a skill such as stealth. Without a name the GM rolls for everyone still without one.",
	gmOnly: false,
	parse: (args) => {
		const [who, skill, extra] = words(args);

		if (extra !== undefined) {
			return usage("/init [who] [skill]");
		}

		if (who === undefined) {
			return { type: "pf-init" };
		}

		return skill === undefined
			? { type: "pf-init", who }
			: { type: "pf-init", who, skill: skill.toLowerCase() };
	},
	complete: whoThen((_slice, typed) =>
		startingWith(["perception", ...SKILLS], typed)
	),
};

const strike: Spec<"pf-strike"> = {
	name: "strike",
	usage:
		"/strike <who> <weapon> <target> [+N|-N] [cover lesser|standard|greater] [reaction]",
	summary:
		"Strike ◆ with a weapon: the multiple attack penalty, flanking, cover and range count themselves. With reaction it spends ↺ and takes no MAP.",
	gmOnly: false,
	parse: (args) => {
		const [who, weapon, target, ...rest] = words(args);

		if (who === undefined || weapon === undefined || target === undefined) {
			return usage(strike.usage);
		}

		let modifier: number | undefined;
		let cover: Cover | undefined;
		let reaction = false;

		for (let i = 0; i < rest.length; i += 1) {
			const w = (rest[i] ?? "").toLowerCase();

			if (SIGNED.test(w)) {
				modifier = (modifier ?? 0) + Number(w);
			} else if (w === "reaction") {
				reaction = true;
			} else if (w === "cover") {
				const next = (rest[i + 1] ?? "").toLowerCase();

				cover = COVERS.find((c) => c === next);

				if (cover === undefined) {
					return usage(strike.usage);
				}

				i += 1;
			} else {
				return usage(strike.usage);
			}
		}

		return {
			type: "pf-strike",
			who,
			weapon,
			target,
			...ifDefined(modifier, (value) => ({ modifier: value })),
			...ifDefined(cover, (value) => ({ cover: value })),
			...when(reaction, () => ({ reaction: true as const })),
		};
	},
	complete: whoThen((slice, typed, actor) => {
		const space = typed.search(/\s/u);

		if (space === -1) {
			return [];
		}

		const weapon = typed.slice(0, space);

		return living(slice, typed.slice(space + 1).trimStart(), actor).map(
			(t) => `${weapon} ${t}`
		);
	}),
};

const block: Spec<"pf-block"> = {
	name: "block",
	usage: "/block <who> [damage]",
	summary:
		"Shield Block ↺ the hit just taken, or some of it: the shield's Hardness comes off it, and the shield and its bearer share the rest.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra] = words(args);

		if (who === undefined || extra !== undefined) {
			return usage("/block <who> [damage]");
		}

		if (typed === undefined) {
			return { type: "pf-block", who };
		}

		return WHOLE.test(typed)
			? { type: "pf-block", who, damage: Number(typed) }
			: usage("/block <who> [damage]");
	},
	complete: whoThen(),
};

const check: Spec<"pf-check"> = {
	name: "check",
	usage: "/check <who> <skill|perception> [vs <dc>] [+N|-N]",
	summary: "Roll a skill or Perception check, against a DC if you give one.",
	gmOnly: false,
	parse: (args) => {
		const [who, skill, ...rest] = words(args);

		if (who === undefined || skill === undefined) {
			return usage(check.usage);
		}

		let dc: number | undefined;
		let modifier: number | undefined;

		for (let i = 0; i < rest.length; i += 1) {
			const w = rest[i] ?? "";

			if (w === "vs" && WHOLE.test(rest[i + 1] ?? "")) {
				dc = Number(rest[i + 1]);
				i += 1;
			} else if (SIGNED.test(w)) {
				modifier = (modifier ?? 0) + Number(w);
			} else {
				return usage(check.usage);
			}
		}

		return {
			type: "pf-check",
			who,
			skill: skill.toLowerCase(),
			...ifDefined(dc, (value) => ({ dc: value })),
			...ifDefined(modifier, (value) => ({ modifier: value })),
		};
	},
	complete: whoThen((_slice, typed) =>
		startingWith(["perception", ...SKILLS], typed)
	),
};

const save: Spec<"pf-save"> = {
	name: "save",
	usage: "/save <who> fort|ref|will <dc> [basic <damage> [type]]",
	summary:
		"Roll a saving throw against a DC; a basic save takes none, half, all or double the damage.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, dcText, basicWord, damage, damageType, extra] =
			words(args);

		const which = SAVES.find((s) => s === typed?.toLowerCase());

		if (
			who === undefined ||
			which === undefined ||
			dcText === undefined ||
			!WHOLE.test(dcText) ||
			extra !== undefined ||
			(basicWord !== undefined &&
				(basicWord !== "basic" || damage === undefined))
		) {
			return usage(save.usage);
		}

		return {
			type: "pf-save",
			who,
			save: which,
			dc: Number(dcText),
			...ifDefined(damage, (value) => ({ basic: value })),
			...ifDefined(damageType, (value) => ({
				damageType: value.toLowerCase(),
			})),
		};
	},
	complete: whoThen((_slice, typed) => startingWith(SAVES, typed)),
};

const flat: Spec<"pf-flat"> = {
	name: "flat",
	usage: "/flat <who> <dc>",
	summary: "Roll a flat check: a bare d20 against the DC.",
	gmOnly: false,
	parse: (args) => {
		const [who, dc, extra] = words(args);

		return who === undefined ||
			dc === undefined ||
			extra !== undefined ||
			!WHOLE.test(dc)
			? usage("/flat <who> <dc>")
			: { type: "pf-flat", who, dc: Number(dc) };
	},
	complete: whoThen(),
};

const cast: Spec<"pf-cast"> = {
	name: "cast",
	usage: "/cast <who> <spell> [rank] [on <targets>]",
	summary:
		"Cast a spell from the sheet: a spell attack or each target's save is rolled, and damage or healing follows.",
	gmOnly: false,
	parse: (args) => {
		const [who, ...rest] = words(args);
		const on = rest.indexOf("on");
		const head = on === -1 ? rest : rest.slice(0, on);
		const targets = on === -1 ? [] : rest.slice(on + 1);
		const last = head.at(-1);
		const ranked = last !== undefined && WHOLE.test(last) && head.length > 1;
		const spell = (ranked ? head.slice(0, -1) : head).join(" ");

		if (
			who === undefined ||
			spell === "" ||
			(on !== -1 && targets.length === 0)
		) {
			return usage(cast.usage);
		}

		return {
			type: "pf-cast",
			who,
			spell,
			...when(ranked, () => ({ rank: Number(last) })),
			targets,
		};
	},
	complete: whoThen(),
};

const dmg: Spec<"pf-dmg"> = {
	name: "dmg",
	usage: "/dmg <who> <amount|dice> [type] [crit]",
	summary:
		"Deal damage: temporary HP goes first, then immunities, weaknesses and resistances to the type count.",
	gmOnly: false,
	parse: (args) => {
		const [who, amount, ...rest] = words(args);
		const critical = rest.includes("crit");
		const named = rest.filter((w) => w !== "crit");
		const [damageType, extra] = named;

		if (who === undefined || amount === undefined || extra !== undefined) {
			return usage(dmg.usage);
		}

		return {
			type: "pf-dmg",
			who,
			amount,
			...ifDefined(damageType, (value) => ({
				damageType: value.toLowerCase(),
			})),
			...when(critical, () => ({ critical: true as const })),
		};
	},
	complete: whoThen(),
};

const heal: Spec<"pf-heal"> = {
	name: "heal",
	usage: "/heal <who> <amount|dice>",
	summary: "Restore HP; from 0 it ends dying, and wounded goes up by one.",
	gmOnly: false,
	parse: (args) => {
		const [who, amount, extra] = words(args);

		return who === undefined || amount === undefined || extra !== undefined
			? usage("/heal <who> <amount|dice>")
			: { type: "pf-heal", who, amount };
	},
	complete: whoThen(),
};

const temp: Spec<"pf-temp"> = {
	name: "temp",
	usage: "/temp <who> <amount>",
	summary: "Give temporary HP; they don't stack, so the higher stays.",
	gmOnly: false,
	parse: (args) => {
		const [who, amount, extra] = words(args);

		return who === undefined ||
			amount === undefined ||
			extra !== undefined ||
			!WHOLE.test(amount)
			? usage("/temp <who> <amount>")
			: { type: "pf-temp", who, amount: Number(amount) };
	},
	complete: whoThen(),
};

const CONDITION_WORDS: ReadonlyArray<string> = [
	...CONDITIONS,
	...COUNTERS,
	"persistent",
];

const persistentArgs = (
	who: string,
	remove: boolean,
	rest: ReadonlyArray<string>
): PfOf<"pf-cond"> | Refused => {
	const [typed, dice, extra] = rest;

	if (typed === undefined || extra !== undefined) {
		return usage("/cond <who> persistent <type> <dice>");
	}

	const damageType = typed.toLowerCase();

	if (remove) {
		return dice === undefined
			? { type: "pf-cond", who, name: "persistent", remove, damageType }
			: usage("/cond <who> -persistent <type>");
	}

	return dice === undefined
		? usage("/cond <who> persistent <type> <dice>")
		: { type: "pf-cond", who, name: "persistent", damageType, dice };
};

const cond: Spec<"pf-cond"> = {
	name: "cond",
	usage:
		"/cond <who> <condition> [N] [eot|sot] [by <who>] · /cond <who> -<condition> · /cond <who> persistent <type> <dice>",
	summary:
		"Set or lift a condition, dying, wounded or doomed, or persistent damage; eot and sot end it at the end or start of its source's turn.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, ...rest] = words(args);

		if (who === undefined || typed === undefined) {
			return usage("/cond <who> <condition> [N] [eot|sot] [by <who>]");
		}

		const remove = typed.startsWith("-");
		const name = typed.replace(/^-/u, "").toLowerCase();

		if (name === "persistent") {
			return persistentArgs(who, remove, rest);
		}

		if (remove) {
			return rest.length === 0
				? { type: "pf-cond", who, name, remove }
				: usage(`/cond <who> -${name}`);
		}

		let value: number | undefined;
		let expires: PfExpiry | undefined;
		let by: string | undefined;

		for (let i = 0; i < rest.length; i += 1) {
			const w = (rest[i] ?? "").toLowerCase();

			if (WHOLE.test(w)) {
				value = Number(w);
			} else if (w === "eot" || w === "sot") {
				expires = w;
			} else if (w === "by" && rest[i + 1] !== undefined) {
				by = rest[i + 1];
				i += 1;
			} else {
				return usage("/cond <who> <condition> [N] [eot|sot] [by <who>]");
			}
		}

		return {
			type: "pf-cond",
			who,
			name,
			...ifDefined(value, (v) => ({ value: v })),
			...ifDefined(expires, (at) => ({ expires: at })),
			...ifDefined(by, (source) => ({ by: source })),
		};
	},
	complete: whoThen((_slice, typed) => {
		const minus = typed.startsWith("-") ? "-" : "";

		return startingWith(CONDITION_WORDS, typed.replace(/^-/u, "")).map(
			(w) => `${minus}${w}`
		);
	}),
};

const hp: Spec<"pf-hp"> = {
	name: "hp",
	usage: "/hp <who> +N|-N|reset",
	summary: "Give or spend Hero Points (at most 3), or reset them to 1.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra] = words(args);

		if (who === undefined || typed === undefined || extra !== undefined) {
			return usage("/hp <who> +N|-N|reset");
		}

		if (typed.toLowerCase() === "reset") {
			return { type: "pf-hp", who, reset: true };
		}

		return SIGNED.test(typed)
			? { type: "pf-hp", who, by: Number(typed) }
			: usage("/hp <who> +N|-N|reset");
	},
	complete: whoThen((_slice, typed) => startingWith(["reset"], typed)),
};

const map: Spec<"pf-map"> = {
	name: "map",
	usage: MAP_USAGE,
	summary:
		"Load the encounter's map from the campaign's maps folder, generate one there, or put it away.",
	gmOnly: true,
	parse: (args) => {
		const parsed = parseMapArgs(args);

		if ("refusal" in parsed) {
			return parsed;
		}

		if (parsed.generate !== undefined) {
			return { type: "pf-map", generate: parsed.generate };
		}

		return parsed.id === undefined
			? { type: "pf-map" }
			: { type: "pf-map", id: parsed.id };
	},
	complete: (_slice, partial) => completeMapArgs(partial),
};

const dist: Spec<"pf-dist"> = {
	name: "dist",
	usage: "/dist <who> <target>",
	summary: "Measure the distance between two creatures in feet.",
	gmOnly: false,
	parse: (args) => {
		const [who, target, extra] = words(args);

		return who === undefined || target === undefined || extra !== undefined
			? usage("/dist <who> <target>")
			: { type: "pf-dist", who, target };
	},
	complete: whoThen(living),
};

export const commands: CommandSpecs<PfCommand, PfState> = {
	"pf-pc": pc,
	"pf-add": add,
	"pf-play": play,
	"pf-unplay": unplay,
	"pf-init": init,
	"pf-start": bare(
		"pf-start",
		"start",
		"Start the encounter: anyone without initiative rolls Perception, and the first turn begins.",
		true
	),
	"pf-turn": whoOnly(
		"pf-turn",
		"turn",
		"Start a creature's turn now, out of order.",
		true
	),
	"pf-done": bare(
		"pf-done",
		"done",
		"End the turn: persistent damage, frightened and end-of-turn conditions, then the next in initiative.",
		false
	),
	"pf-delay": bare(
		"pf-delay",
		"delay",
		"Delay: leave the initiative order until you /join it again.",
		false
	),
	"pf-join": whoOnly(
		"pf-join",
		"join",
		"Return a delaying creature to initiative, after the creature acting now."
	),
	"pf-end": bare("pf-end", "end", "End the encounter.", true),
	"pf-strike": strike,
	"pf-stride": toSquare(
		"pf-stride",
		"stride",
		"Stride ◆ up to your Speed; diagonals cost 5 then 10 ft across the turn."
	),
	"pf-step": toSquare(
		"pf-step",
		"step",
		"Step ◆ 5 ft, never into difficult terrain."
	),
	"pf-crawl": toSquare("pf-crawl", "crawl", "Crawl ◆ 5 ft while prone."),
	"pf-move": toSquare(
		"pf-move",
		"move",
		"Move by the shortest path, without an action: out of an encounter, or the GM's own."
	),
	"pf-place": toSquare(
		"pf-place",
		"place",
		"Put a creature on the map at a square like c5."
	),
	"pf-stand": whoOnly("pf-stand", "stand", "Stand ◆ up from prone."),
	"pf-drop": whoOnly("pf-drop", "drop", "Drop Prone ◆."),
	"pf-shield": whoOnly(
		"pf-shield",
		"shield",
		"Raise a Shield ◆: its bonus to AC until your next turn starts."
	),
	"pf-block": block,
	"pf-grapple": maneuver(
		"pf-grapple",
		"grapple",
		"Grapple ◆: Athletics against Fortitude DC; grabbed, or restrained on a critical."
	),
	"pf-trip": maneuver(
		"pf-trip",
		"trip",
		"Trip ◆: Athletics against Reflex DC; prone, and 1d6 on a critical."
	),
	"pf-shove": maneuver(
		"pf-shove",
		"shove",
		"Shove ◆: Athletics against Fortitude DC; 5 ft away, or 10 on a critical."
	),
	"pf-disarm": maneuver(
		"pf-disarm",
		"disarm",
		"Disarm ◆: Athletics against Reflex DC."
	),
	"pf-demoralize": maneuver(
		"pf-demoralize",
		"demoralize",
		"Demoralize ◆: Intimidation against Will DC; frightened 1, or 2 on a critical."
	),
	"pf-check": check,
	"pf-save": save,
	"pf-flat": flat,
	"pf-cast": cast,
	"pf-dmg": dmg,
	"pf-heal": heal,
	"pf-temp": temp,
	"pf-cond": cond,
	"pf-hp": hp,
	"pf-reroll": whoOnly(
		"pf-reroll",
		"reroll",
		"Spend a Hero Point to reroll your latest check, keeping the new roll."
	),
	"pf-recover": whoOnly(
		"pf-recover",
		"recover",
		"Heroic Recovery: spend all your Hero Points to stop dying, at 0 HP, without gaining wounded."
	),
	"pf-rest": bare(
		"pf-rest",
		"rest",
		"A night's rest: HP back by Constitution × level, doomed and drained down by one, spell slots back.",
		true
	),
	"pf-map": map,
	"pf-dist": dist,
};

const mapNeed = (command: PfOf<"pf-map">): HostNeed | undefined => {
	if (command.grid !== undefined) {
		return undefined;
	}

	if (command.generate !== undefined) {
		return { kind: "generate", generation: command.generate };
	}

	return command.id === undefined ? undefined : { kind: "map", id: command.id };
};

const isType = <T extends PfCommandType>(
	command: PfCommand,
	type: T
): command is PfOf<T> => command.type === type;

export const pfHostNeed = (command: PfCommand): HostNeed | undefined => {
	if (isType(command, "pf-map")) {
		return mapNeed(command);
	}

	if (isType(command, "pf-pc")) {
		return command.sheet === undefined
			? { kind: "pf-hero", id: command.id }
			: undefined;
	}

	if (isType(command, "pf-add")) {
		return command.sheet === undefined
			? { kind: "pf-monster", id: command.monster }
			: undefined;
	}

	return isType(command, "pf-play") && command.seated === undefined
		? { kind: "seated" }
		: undefined;
};

const filledMap = (command: PfOf<"pf-map">, fact: HostFact): PfCommand => {
	if (fact.kind === "generated") {
		return { type: "pf-map", id: fact.id };
	}

	return fact.kind === "map"
		? { type: "pf-map", id: fact.id, grid: fact.grid }
		: command;
};

export const pfFillHostFact = (
	command: PfCommand,
	fact: HostFact
): PfCommand => {
	if (isType(command, "pf-map")) {
		return filledMap(command, fact);
	}

	if (isType(command, "pf-pc") && fact.kind === "pf-hero") {
		return { ...command, sheet: fact.sheet };
	}

	if (isType(command, "pf-add") && fact.kind === "pf-monster") {
		return { ...command, sheet: fact.sheet };
	}

	return isType(command, "pf-play") && fact.kind === "seated"
		? { ...command, seated: fact.seated }
		: command;
};
