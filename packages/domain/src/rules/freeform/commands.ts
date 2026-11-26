import { parseNotation } from "../../dice.ts";
import { ifDefined } from "../../present.ts";
import { quote } from "../../text.ts";
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
import { STAT_KEY, TAG } from "./schema.ts";
import type { FfSheet } from "./schema.ts";
import { ADD_MAX, completeFigures, findFigure } from "./state.ts";
import type { FfState } from "./state.ts";

export type FfStatOp = "add" | "set";

export type FfCommand =
	| { readonly type: "ff-pc"; readonly id: string; readonly sheet?: FfSheet }
	| {
			readonly type: "ff-add";
			readonly monster: string;
			readonly count: number;
			readonly sheet?: FfSheet;
	  }
	| {
			readonly type: "ff-play";
			readonly who: string;
			readonly seated?: ReadonlyArray<string>;
	  }
	| { readonly type: "ff-unplay"; readonly who?: string }
	| {
			readonly type: "ff-stat";
			readonly who: string;
			readonly key: string;
			readonly op: FfStatOp;
			readonly amount: number;
	  }
	| {
			readonly type: "ff-tag";
			readonly who: string;
			readonly tag: string;
			readonly on: boolean;
	  }
	| {
			readonly type: "ff-check";
			readonly who?: string;
			readonly stat: string;
			readonly dice?: string;
	  }
	| {
			readonly type: "ff-map";
			readonly id?: string;
			readonly grid?: MapGrid;
			readonly generate?: MapGeneration;
	  }
	| { readonly type: "ff-place"; readonly who: string; readonly at: Square }
	| { readonly type: "ff-move"; readonly who: string; readonly to: Square }
	| { readonly type: "ff-remove"; readonly who: string }
	| { readonly type: "ff-start"; readonly who: ReadonlyArray<string> }
	| { readonly type: "ff-next" }
	| { readonly type: "ff-end" };

type Spec<T extends FfCommand["type"]> = CommandSpec<
	Extract<FfCommand, { readonly type: T }>,
	FfState
>;

const words = (args: string): Array<string> =>
	args
		.trim()
		.split(/\s+/u)
		.filter((w) => w !== "");

const usage = (text: string): Refused => ({ refusal: `Usage: ${text}` });

const notASquare = (typed: string): Refused => ({
	refusal: `'${quote(typed)}' isn't a square like c5.`,
});

const AMOUNT = /^(?<op>[+=-])(?<n>\d{1,4})$/u;

const COUNT = /^\d{1,2}$/u;

const figureThen =
	(then?: (slice: FfState, who: string, typed: string) => Array<string>) =>
	(slice: FfState, partial: string, actor: string): Array<string> => {
		const space = partial.search(/\s/u);

		if (space === -1) {
			return completeFigures(slice, partial, actor);
		}

		const who = partial.slice(0, space);
		const typed = partial.slice(space + 1).trimStart();

		return (then?.(slice, who, typed) ?? []).map((r) => `${who} ${r}`);
	};

const statsOf = (slice: FfState, who: string): ReadonlyArray<string> => {
	const f = findFigure(slice, who.toLowerCase());

	return f === undefined ? [] : Object.keys(f.values);
};

const pc: Spec<"ff-pc"> = {
	name: "pc",
	usage: "/pc <id>",
	summary:
		"Bring a character into the party from party/<id>.md, or load its sheet again.",
	gmOnly: true,
	parse: (args) => {
		const [id, extra] = words(args);

		return id === undefined || extra !== undefined
			? usage(pc.usage)
			: { type: "ff-pc", id: id.toLowerCase() };
	},
};

const TIMES = /^x(?<n>\d{1,2})$/iu;

const countOf = (
	parts: ReadonlyArray<string>
): { readonly monster?: string; readonly count: number } | undefined => {
	const [first, second, extra] = parts;

	if (extra !== undefined) {
		return undefined;
	}

	if (second === undefined) {
		return { ...ifDefined(first, (monster) => ({ monster })), count: 1 };
	}

	const times = TIMES.exec(second)?.groups?.n;

	if (times !== undefined) {
		return {
			...ifDefined(first, (monster) => ({ monster })),
			count: Number(times),
		};
	}

	return COUNT.test(first ?? "")
		? { monster: second, count: Number(first) }
		: undefined;
};

const add: Spec<"ff-add"> = {
	name: "add",
	usage: "/add [n] <id>",
	summary: `Add 1 to ${ADD_MAX} figures from monsters/<id>.md, numbered when more than one (/add 3 goblin or /add goblin x3).`,
	gmOnly: true,
	parse: (args) => {
		const counted = countOf(words(args));

		if (counted?.monster === undefined) {
			return usage(add.usage);
		}

		if (counted.count < 1 || counted.count > ADD_MAX) {
			return { refusal: `Add 1 to ${ADD_MAX} figures at a time.` };
		}

		return {
			type: "ff-add",
			monster: counted.monster.toLowerCase(),
			count: counted.count,
		};
	},
};

const play: Spec<"ff-play"> = {
	name: "play",
	usage: "/play <who>",
	summary: "Play a party member nobody else plays.",
	gmOnly: false,
	parse: (args) => {
		const [who, extra] = words(args);

		return who === undefined || extra !== undefined
			? usage(play.usage)
			: { type: "ff-play", who };
	},
	complete: (slice, partial, actor) =>
		completeFigures(
			slice,
			partial,
			actor,
			(f) => f.side === "party" && f.player === undefined
		),
};

const unplay: Spec<"ff-unplay"> = {
	name: "unplay",
	usage: "/unplay [who]",
	summary: "Stop playing your character. The GM names any to free it.",
	gmOnly: false,
	parse: (args) => {
		const [who, extra] = words(args);

		if (extra !== undefined) {
			return usage(unplay.usage);
		}

		return who === undefined
			? { type: "ff-unplay" }
			: { type: "ff-unplay", who };
	},
	complete: (slice, partial, actor) =>
		completeFigures(slice, partial, actor, (f) => f.player !== undefined),
};

const stat: Spec<"ff-stat"> = {
	name: "stat",
	usage: "/stat <who> <key> +n|-n|=n",
	summary:
		"Change a stat or resource: +n and -n adjust it, =n sets it; resources stay within 0 and their maximum.",
	gmOnly: false,
	parse: (args) => {
		const [who, key, change, extra] = words(args);
		const amount = AMOUNT.exec(change ?? "")?.groups;

		if (
			who === undefined ||
			key === undefined ||
			amount === undefined ||
			extra !== undefined
		) {
			return usage(stat.usage);
		}

		if (!STAT_KEY.test(key.toLowerCase())) {
			return { refusal: `'${quote(key)}' isn't a stat's key, like might.` };
		}

		const n = Number(amount.n);

		return {
			type: "ff-stat",
			who,
			key: key.toLowerCase(),
			op: amount.op === "=" ? "set" : "add",
			amount: amount.op === "-" ? -n : n,
		};
	},
	complete: figureThen((slice, who, typed) =>
		statsOf(slice, who).filter((k) => k.startsWith(typed.toLowerCase()))
	),
};

const tag: Spec<"ff-tag"> = {
	name: "tag",
	usage: "/tag <who> +tag|-tag",
	summary: "Put a tag on a figure, like +hidden, or take one off with -hidden.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra] = words(args);
		const sign = typed?.[0];
		const name = typed?.slice(1).toLowerCase() ?? "";

		if (
			who === undefined ||
			(sign !== "+" && sign !== "-") ||
			extra !== undefined
		) {
			return usage(tag.usage);
		}

		return TAG.test(name)
			? { type: "ff-tag", who, tag: name, on: sign === "+" }
			: {
					refusal: `'${quote(name)}' isn't a tag: lower-case letters, digits and hyphens, at most 24.`,
				};
	},
	complete: figureThen((slice, who, typed) => {
		const f = findFigure(slice, who.toLowerCase());

		return (f?.tags ?? [])
			.map((t) => `-${t}`)
			.filter((t) => t.startsWith(typed));
	}),
};

const check: Spec<"ff-check"> = {
	name: "check",
	usage: "/check [who] <stat> [dice]",
	summary:
		"Roll a check: the dice (the sheet's, else d20) plus the stat. Players roll for their own character.",
	gmOnly: false,
	parse: (args) => {
		const parts = words(args);
		const last = parts.at(-1);

		const dice =
			parts.length > 1 && last !== undefined && !isRefused(parseNotation(last))
				? last
				: undefined;

		const rest = dice === undefined ? parts : parts.slice(0, -1);
		const [first, second, extra] = rest;

		if (first === undefined || extra !== undefined) {
			return usage(check.usage);
		}

		const statKey = (second ?? first).toLowerCase();

		if (!STAT_KEY.test(statKey)) {
			return { refusal: `'${quote(statKey)}' isn't a stat's key, like might.` };
		}

		return {
			type: "ff-check",
			...ifDefined(second === undefined ? undefined : first, (who) => ({
				who,
			})),
			stat: statKey,
			...ifDefined(dice, (value) => ({ dice: value })),
		};
	},
};

const map: Spec<"ff-map"> = {
	name: "map",
	usage: MAP_USAGE,
	summary:
		"Load a map from the campaign's maps folder, generate one there, or put it away.",
	gmOnly: true,
	parse: (args) => {
		const parsed = parseMapArgs(args);

		if (isRefused(parsed)) {
			return parsed;
		}

		if (parsed.generate !== undefined) {
			return { type: "ff-map", generate: parsed.generate };
		}

		return parsed.id === undefined
			? { type: "ff-map" }
			: { type: "ff-map", id: parsed.id };
	},
	complete: (_slice, partial) => completeMapArgs(partial),
};

const squareOf = (
	text: string,
	args: string
): { readonly who: string; readonly at: Square } | Refused => {
	const [who, typed, extra] = words(args);

	if (who === undefined || typed === undefined || extra !== undefined) {
		return usage(text);
	}

	const at = parseSquare(typed);

	return at === undefined ? notASquare(typed) : { who, at };
};

const place: Spec<"ff-place"> = {
	name: "place",
	usage: "/place <who> <square>",
	summary: "Put a figure on the map at a square like c5.",
	gmOnly: false,
	parse: (args) => {
		const found = squareOf(place.usage, args);

		return isRefused(found)
			? found
			: { type: "ff-place", who: found.who, at: found.at };
	},
	complete: figureThen(),
};

const move: Spec<"ff-move"> = {
	name: "move",
	usage: "/move <who> <square>",
	summary: "Move a figure to a square it can walk to.",
	gmOnly: false,
	parse: (args) => {
		const found = squareOf(move.usage, args);

		return isRefused(found)
			? found
			: { type: "ff-move", who: found.who, to: found.at };
	},
	complete: figureThen(),
};

const remove: Spec<"ff-remove"> = {
	name: "remove",
	usage: "/remove <who>",
	summary: "Take a figure off the table.",
	gmOnly: true,
	parse: (args) => {
		const [who, extra] = words(args);

		return who === undefined || extra !== undefined
			? usage(remove.usage)
			: { type: "ff-remove", who };
	},
	complete: (slice, partial, actor) => completeFigures(slice, partial, actor),
};

const start: Spec<"ff-start"> = {
	name: "start",
	usage: "/start [who...]",
	summary:
		"Start turns in the order you name, or everyone's: the party first, then the foes.",
	gmOnly: true,
	parse: (args) => ({ type: "ff-start", who: words(args) }),
	complete: (slice, partial, actor) => {
		const at = partial.lastIndexOf(" ");
		const head = at === -1 ? "" : partial.slice(0, at + 1);

		return completeFigures(slice, partial.slice(at + 1), actor).map(
			(id) => `${head}${id}`
		);
	},
};

const next: Spec<"ff-next"> = {
	name: "next",
	usage: "/next",
	summary:
		"End the turn: the next in the order goes, and a new round after the last.",
	gmOnly: false,
	parse: (args) =>
		args.trim() === "" ? { type: "ff-next" } : usage(next.usage),
};

const end: Spec<"ff-end"> = {
	name: "end",
	usage: "/end",
	summary: "End the turns.",
	gmOnly: true,
	parse: (args) => (args.trim() === "" ? { type: "ff-end" } : usage(end.usage)),
};

export const commands: CommandSpecs<FfCommand, FfState> = {
	"ff-pc": pc,
	"ff-add": add,
	"ff-play": play,
	"ff-unplay": unplay,
	"ff-stat": stat,
	"ff-tag": tag,
	"ff-check": check,
	"ff-map": map,
	"ff-place": place,
	"ff-move": move,
	"ff-remove": remove,
	"ff-start": start,
	"ff-next": next,
	"ff-end": end,
};

const mapNeed = (
	command: Extract<FfCommand, { readonly type: "ff-map" }>
): HostNeed | undefined => {
	if (command.grid !== undefined) {
		return undefined;
	}

	if (command.generate !== undefined) {
		return { kind: "generate", generation: command.generate };
	}

	return command.id === undefined ? undefined : { kind: "map", id: command.id };
};

export const ffHostNeed = (command: FfCommand): HostNeed | undefined => {
	switch (command.type) {
		case "ff-map": {
			return mapNeed(command);
		}

		case "ff-pc": {
			return command.sheet === undefined
				? { kind: "ff-hero", id: command.id }
				: undefined;
		}

		case "ff-add": {
			return command.sheet === undefined
				? { kind: "ff-monster", id: command.monster }
				: undefined;
		}

		case "ff-play": {
			return command.seated === undefined ? { kind: "seated" } : undefined;
		}

		case "ff-unplay":
		case "ff-stat":
		case "ff-tag":
		case "ff-check":
		case "ff-place":
		case "ff-move":
		case "ff-remove":
		case "ff-start":
		case "ff-next":
		case "ff-end": {
			return undefined;
		}

		default: {
			return undefined;
		}
	}
};

export const ffFillHostFact = (
	command: FfCommand,
	fact: HostFact
): FfCommand => {
	if (command.type === "ff-map") {
		if (fact.kind === "generated") {
			return { type: "ff-map", id: fact.id };
		}

		return fact.kind === "map"
			? { type: "ff-map", id: fact.id, grid: fact.grid }
			: command;
	}

	if (command.type === "ff-pc" && fact.kind === "ff-hero") {
		return { ...command, sheet: fact.sheet };
	}

	if (command.type === "ff-add" && fact.kind === "ff-monster") {
		return { ...command, sheet: fact.sheet };
	}

	return command.type === "ff-play" && fact.kind === "seated"
		? { ...command, seated: fact.seated }
		: command;
};
