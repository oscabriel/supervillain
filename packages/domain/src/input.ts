import { core } from "./rules/core/core.ts";
import { GM } from "./rules/core/module.ts";
import { isRefused } from "./rules/engine.ts";
import type { Refused } from "./rules/engine.ts";
import { DEFAULT_RULESET } from "./Ruleset.ts";
import type { RulesetName } from "./Ruleset.ts";
import { commandsFor, completeSheet } from "./table.ts";
import type { Command, TableState } from "./table.ts";
import { cleanText, quote } from "./text.ts";

export type Parsed =
	| { readonly kind: "command"; readonly command: Command }
	| { readonly kind: "refusal"; readonly message: string }
	| { readonly kind: "help"; readonly topic?: string }
	| { readonly kind: "sheet"; readonly who: string }
	| { readonly kind: "state" }
	| { readonly kind: "auto"; readonly foes?: boolean }
	| { readonly kind: "quit" }
	| { readonly kind: "empty" };

export type Surface = "seat" | "exec";

export type InputMode = "chat" | "name";

interface Entry {
	readonly name: string;
	readonly usage: string;
	readonly summary: string;
	readonly gmOnly: boolean;
	readonly seatOnly?: boolean;
	readonly run: (args: string) => Parsed;
	readonly complete?: (
		state: TableState,
		actor: string,
		partial: string
	) => ReadonlyArray<string>;
}

const LEADING_SLASH = /^\//u;

const SPACE = /\s/u;

const fromSpec =
	(parse: (args: string) => Command | Refused) =>
	(args: string): Parsed => {
		const result = parse(args);

		return isRefused(result)
			? { kind: "refusal", message: result.refusal }
			: { kind: "command", command: result };
	};

const SHEETS = {
	"draw-steel": "Show a hero's or creature's sheet, to you alone.",
	"set-world": "Show a fighter's sheet, to you alone.",
	pf2e: "Show a PC's or creature's stat block, to you alone.",
} as const satisfies Record<RulesetName, string>;

const specEntries = (ruleset: RulesetName): ReadonlyArray<Entry> =>
	commandsFor(ruleset).map((spec): Entry => {
		const entry: Entry = {
			name: spec.name,
			usage: spec.usage,
			summary: spec.summary,
			gmOnly: spec.gmOnly,
			run: fromSpec(spec.parse),
		};

		const { complete } = spec;

		return complete === undefined
			? entry
			: {
					...entry,
					complete: (state, actor, partial) => complete(state, partial, actor),
				};
	});

const startingWith = (
	options: ReadonlyArray<string>,
	partial: string
): Array<string> =>
	options.filter((option) => option.startsWith(partial.trim().toLowerCase()));

export const AUTO_USAGE = "/auto foes [on|off]";

const AUTO_WORDS: ReadonlyMap<string, Parsed> = new Map([
	["", { kind: "auto" }],
	["foes", { kind: "auto", foes: true }],
	["foes on", { kind: "auto", foes: true }],
	["foes off", { kind: "auto", foes: false }],
]);

const autoEntry: Entry = {
	name: "auto",
	usage: AUTO_USAGE,
	summary:
		"Let the table play the foes' turns: each attacks the nearest of the party in reach, else closes in, else rests. Off again with off; it lasts while the table is open.",
	gmOnly: true,
	run: (args) =>
		AUTO_WORDS.get(args.trim().toLowerCase().split(/\s+/u).join(" ")) ?? {
			kind: "refusal",
			message: `Usage: ${AUTO_USAGE}`,
		},
	complete: (_state, _actor, partial) =>
		startingWith(["foes on", "foes off"], partial),
};

const RULESET_ENTRIES = {
	"draw-steel": [],
	"set-world": [autoEntry],
	pf2e: [],
} as const satisfies Record<RulesetName, ReadonlyArray<Entry>>;

const seatEntries = (ruleset: RulesetName): ReadonlyArray<Entry> => [
	...RULESET_ENTRIES[ruleset],
	{
		name: "help",
		usage: "/help [command]",
		summary: "List the commands, or explain one.",
		gmOnly: false,
		run: (args) => {
			const topic = args.trim().replace(LEADING_SLASH, "").toLowerCase();

			return topic === "" ? { kind: "help" } : { kind: "help", topic };
		},
		complete: (_state, actor, partial) =>
			namesFor(actor, partial.trim().replace(LEADING_SLASH, ""), ruleset),
	},
	{
		name: "sheet",
		usage: "/sheet <who>",
		summary: SHEETS[ruleset],
		gmOnly: false,
		run: (args) =>
			args.trim() === ""
				? { kind: "refusal", message: "Usage: /sheet <who>" }
				: { kind: "sheet", who: args.trim() },
		complete: (state, actor, partial) =>
			completeSheet(state, partial, actor, ruleset),
	},
	{
		name: "state",
		usage: "/state",
		summary: "Show or hide the state pane.",
		gmOnly: true,
		run: () => ({ kind: "state" }),
	},
	{
		name: "view",
		usage: "/view [map|feed|both|pictures|text|<square|who>]",
		summary:
			"Show the map, the feed or both, in pictures or text, or centre the map; Alt+1-4 show or hide each panel.",
		gmOnly: false,
		seatOnly: true,
		run: () => ({
			kind: "refusal",
			message: "/view changes a seat's own screen; this one has none.",
		}),
		complete: (_state, _actor, partial) =>
			startingWith(["map", "feed", "both", "pictures", "text"], partial),
	},
	{
		name: "mouse",
		usage: "/mouse [on|off]",
		summary:
			"Click tokens, menus and panel titles, or turn that off to select text the terminal's way.",
		gmOnly: false,
		seatOnly: true,
		run: () => ({
			kind: "refusal",
			message: "/mouse changes a seat's own screen; this one has none.",
		}),
		complete: (_state, _actor, partial) => startingWith(["on", "off"], partial),
	},
	{
		name: "prep",
		usage: "/prep",
		summary:
			"Open the prep panel: click to bring in heroes, add foes, load or generate a map, place tokens and start, each item showing the command it sends; Alt+5 shows or hides it.",
		gmOnly: true,
		seatOnly: true,
		run: () => ({
			kind: "refusal",
			message: "/prep opens a panel on the GM's seat; this one has none.",
		}),
	},
	{
		name: "quit",
		usage: "/quit",
		summary: "Leave the table.",
		gmOnly: false,
		seatOnly: true,
		run: () => ({ kind: "quit" }),
	},
];

const entriesOf = (ruleset: RulesetName): ReadonlyArray<Entry> => [
	...specEntries(ruleset),
	...seatEntries(ruleset),
];

export const BARE_OVER_EXEC: ReadonlySet<string> = new Set([
	"roll",
	"dist",
	"undo",
	"redo",
	"help",
	"sheet",
]);

const ENTRIES = {
	"draw-steel": entriesOf("draw-steel"),
	"set-world": entriesOf("set-world"),
	pf2e: entriesOf("pf2e"),
} as const satisfies Record<RulesetName, ReadonlyArray<Entry>>;

const sayLine = fromSpec(core.commands.say.parse);

const nameLine = fromSpec(core.commands.name.parse);

const visibleTo = (
	actor: string,
	surface: Surface,
	ruleset: RulesetName
): ReadonlyArray<Entry> =>
	ENTRIES[ruleset].filter(
		(e) =>
			(!e.gmOnly || actor === GM) && (e.seatOnly !== true || surface === "seat")
	);

const namesFor = (
	actor: string,
	partial: string,
	ruleset: RulesetName
): ReadonlyArray<string> => {
	const typed = partial.toLowerCase();

	return visibleTo(actor, "seat", ruleset)
		.map((e) => e.name)
		.filter((n) => n.startsWith(typed));
};

const find = (name: string, ruleset: RulesetName): Entry | undefined =>
	ENTRIES[ruleset].find((e) => e.name === name.toLowerCase());

const editDistance = (a: string, b: string): number => {
	const rows: Array<Array<number>> = Array.from(
		{ length: a.length + 1 },
		(_, i) =>
			Array.from({ length: b.length + 1 }, (_unused, j) => (i === 0 ? j : i))
	);

	const at = (i: number, j: number): number => rows[i]?.[j] ?? Infinity;

	for (const i of Array.from({ length: a.length }, (_, n) => n + 1)) {
		const row = rows[i] ?? [];

		for (const j of Array.from({ length: b.length }, (_, n) => n + 1)) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;

			const swapped =
				i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
					? at(i - 2, j - 2) + 1
					: Infinity;

			row[j] = Math.min(
				at(i - 1, j) + 1,
				at(i, j - 1) + 1,
				at(i - 1, j - 1) + cost,
				swapped
			);
		}
	}

	return at(a.length, b.length);
};

const isNearMiss = (a: string, b: string): boolean => {
	const limit = Math.min(a.length, b.length) > 4 ? 2 : 1;

	if (Math.abs(a.length - b.length) > limit) {
		return false;
	}

	return editDistance(a, b) <= limit;
};

const unknown = (name: string, ruleset: RulesetName): string => {
	const entries = ENTRIES[ruleset];
	const typed = name.toLowerCase();
	const begun = entries.filter((e) => e.name.startsWith(typed));

	const near =
		begun.length > 0 ? begun : entries.filter((e) => isNearMiss(typed, e.name));

	const hint =
		near.length === 0
			? "/help lists the commands."
			: `Did you mean ${near.map((e) => `/${e.name}`).join(" or ")}?`;

	return `Unknown command /${quote(name)}. ${hint}`;
};

const split = (
	line: string
): { readonly name: string; readonly args: string | undefined } => {
	const body = line.trimStart().slice(1);
	const space = body.search(SPACE);

	return space === -1
		? { name: body, args: undefined }
		: { name: body.slice(0, space), args: body.slice(space + 1) };
};

export const parseInputLine = (
	line: string,
	mode: InputMode = "chat",
	ruleset: RulesetName = DEFAULT_RULESET
): Parsed => {
	if (cleanText(line) === "") {
		return { kind: "empty" };
	}

	const start = line.trimStart();

	if (start.startsWith("//")) {
		return sayLine(start.slice(1));
	}

	if (!start.startsWith("/")) {
		return mode === "name" ? nameLine(line) : sayLine(line);
	}

	const { name, args } = split(start);

	if (name === "") {
		return { kind: "help" };
	}

	const entry = find(name, ruleset);

	if (entry === undefined) {
		return { kind: "refusal", message: unknown(name, ruleset) };
	}

	return entry.run(args ?? "");
};

export const completeLine = (
	state: TableState,
	actor: string,
	line: string,
	ruleset: RulesetName = DEFAULT_RULESET
): ReadonlyArray<string> => {
	const start = line.trimStart();

	if (!start.startsWith("/") || start.startsWith("//")) {
		return [];
	}

	const { name, args } = split(start);

	if (args === undefined) {
		return namesFor(actor, name, ruleset).map((n) => {
			const takesArgs = find(n, ruleset)?.usage.includes(" ") ?? false;

			return takesArgs ? `/${n} ` : `/${n}`;
		});
	}

	const entry = find(name, ruleset);

	if (entry?.complete === undefined || (entry.gmOnly && actor !== GM)) {
		return [];
	}

	return entry
		.complete(state, actor, args)
		.map((arg) => `/${entry.name} ${arg}`);
};

const HELP_COLUMN = 15;

const helpLine = (e: Entry, width: number, gmMark: string): string => {
	const summary = e.gmOnly ? `${e.summary} ${gmMark}` : e.summary;

	return width > 0 && e.usage.length > width
		? `${e.usage}\n${" ".repeat(width)}  ${summary}`
		: `${e.usage.padEnd(width)}  ${summary}`;
};

export const unknownHelpTopic = (
	topic: string | undefined,
	ruleset: RulesetName = DEFAULT_RULESET
): string | undefined =>
	topic === undefined ||
	find(topic.replace(LEADING_SLASH, ""), ruleset) !== undefined
		? undefined
		: unknown(topic, ruleset);

const execIntro = (bare: ReadonlyArray<string>): string => {
	const listed =
		bare.length <= 1
			? bare.join("")
			: `${bare.slice(0, -1).join(", ")} and ${bare.at(-1) ?? ""}`;

	return `Plain text is chat. Commands start with /; ${listed} work without it here.`;
};

export const helpText = (
	actor: string,
	topic?: string,
	surface: Surface = "seat",
	ruleset: RulesetName = DEFAULT_RULESET
): string => {
	if (topic !== undefined) {
		const entry = find(topic.replace(LEADING_SLASH, ""), ruleset);

		if (entry === undefined) {
			return unknown(topic, ruleset);
		}

		if (entry.seatOnly === true && surface !== "seat") {
			return `/${entry.name} works only at a seat.`;
		}

		return helpLine(entry, 0, actor === GM ? "(GM)" : "(GM only)");
	}

	const shown = visibleTo(actor, surface, ruleset);

	const width = Math.min(
		HELP_COLUMN,
		Math.max(...shown.map((e) => e.usage.length))
	);

	const bare = shown
		.filter((e) => BARE_OVER_EXEC.has(e.name))
		.map((e) => e.name);

	const intro =
		surface === "seat"
			? "Plain text is chat. Commands start with /, and Tab completes them."
			: execIntro(bare);

	return [intro, ...shown.map((e) => helpLine(e, width, "(GM)"))].join("\n");
};
