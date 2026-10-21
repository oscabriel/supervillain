import { GM } from "./module.ts";
import { type Command, commands, completeSheet, type TableState } from "./table.ts";
import { cleanText, quote } from "./text.ts";

/**
 * What one input line asks for. `help`, `sheet`, `state` and `quit` stay with the sender; only
 * `command` reaches the room.
 */
export type Parsed =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "refusal"; readonly message: string }
  | { readonly kind: "help"; readonly topic?: string }
  | { readonly kind: "sheet"; readonly who: string }
  | { readonly kind: "state" }
  | { readonly kind: "quit" }
  | { readonly kind: "empty" };

/** Where a line was typed: at a seat (the table App), or as a one-off `ssh host <line>`. */
export type Surface = "seat" | "exec";

/**
 * How plain text is read. `name` is for a player the table is asking what to call them (Q2):
 * a plain line becomes `/name <line>`, and slash commands still work.
 */
export type InputMode = "chat" | "name";

/** One line of the input surface: a registry command, or a seat-local one. */
interface Entry {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly gmOnly: boolean;
  /** Only a seat has it: there is nothing to leave over exec. */
  readonly seatOnly?: boolean;
  readonly run: (args: string) => Parsed;
  readonly complete?: (state: TableState, actor: string, partial: string) => ReadonlyArray<string>;
}

const fromSpec =
  (parse: (args: string) => Command | { readonly refusal: string }) =>
  (args: string): Parsed => {
    const result = parse(args);
    return "refusal" in result
      ? { kind: "refusal", message: result.refusal }
      : { kind: "command", command: result };
  };

const entries: ReadonlyArray<Entry> = [
  ...commands.map(
    (spec): Entry => ({
      name: spec.name,
      usage: spec.usage,
      summary: spec.summary,
      gmOnly: spec.gmOnly,
      run: fromSpec(spec.parse),
      ...(spec.complete && {
        complete: (state: TableState, actor: string, partial: string) =>
          spec.complete?.(state, partial, actor) ?? [],
      }),
    }),
  ),
  {
    name: "help",
    usage: "/help [command]",
    summary: "List the commands, or explain one.",
    gmOnly: false,
    run: (args) => {
      const topic = args.trim().replace(/^\//, "").toLowerCase();
      return topic === "" ? { kind: "help" } : { kind: "help", topic };
    },
    complete: (_state, actor, partial) => namesFor(actor, partial.trim().replace(/^\//, "")),
  },
  {
    name: "sheet",
    usage: "/sheet <who>",
    summary: "Show a hero's or creature's sheet, to you alone.",
    gmOnly: false,
    run: (args) =>
      args.trim() === ""
        ? { kind: "refusal", message: "Usage: /sheet <who>" }
        : { kind: "sheet", who: args.trim() },
    complete: (state, actor, partial) => completeSheet(state, partial, actor),
  },
  {
    name: "state",
    usage: "/state",
    summary: "Show or hide the state pane.",
    // The whole state, and later what players mustn't see: the GM's alone.
    gmOnly: true,
    run: () => ({ kind: "state" }),
  },
  {
    // The App changes its own layout on /view and never sends it; it's here for /help and Tab.
    name: "view",
    usage: "/view [map|feed|both|<square|who>]",
    summary: "Show the map, the feed or both; alone, show or hide the map; or centre it somewhere.",
    gmOnly: false,
    seatOnly: true,
    run: () => ({
      kind: "refusal",
      message: "/view changes a seat's own screen; this one has none.",
    }),
    complete: (_state, _actor, partial) =>
      ["map", "feed", "both"].filter((l) => l.startsWith(partial.trim().toLowerCase())),
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

/**
 * Commands that run without their slash over exec: none takes free text, so chat can't start one.
 * /sheet is read-only and answers the sender alone, so "sheet kesh" said as chat would be the slip;
 * a bare "undo" or "dist kesh chief" said as chat would be a slip too.
 */
export const BARE_OVER_EXEC: ReadonlySet<string> = new Set([
  "roll",
  "dist",
  "undo",
  "redo",
  "help",
  "sheet",
]);

const say = commands.find((c) => c.name === "say");
const name = commands.find((c) => c.name === "name");
if (!say || !name) throw new Error("the registry lost /say or /name");
const sayLine = fromSpec(say.parse);
const nameLine = fromSpec(name.parse);

const visibleTo = (actor: string, surface: Surface = "seat") =>
  entries.filter((e) => (!e.gmOnly || actor === GM) && (!e.seatOnly || surface === "seat"));

function namesFor(actor: string, partial: string): ReadonlyArray<string> {
  const typed = partial.toLowerCase();
  return visibleTo(actor)
    .map((e) => e.name)
    .filter((n) => n.startsWith(typed));
}

const find = (name: string): Entry | undefined =>
  entries.find((e) => e.name === name.toLowerCase());

/** "Unknown command /x." plus the commands it most likely meant: those it begins, else near misses. */
function unknown(name: string): string {
  const typed = name.toLowerCase();
  const begun = entries.filter((e) => e.name.startsWith(typed));
  const near = begun.length > 0 ? begun : entries.filter((e) => isNearMiss(typed, e.name));
  const hint =
    near.length === 0
      ? "/help lists the commands."
      : `Did you mean ${near.map((e) => `/${e.name}`).join(" or ")}?`;
  return `Unknown command /${quote(name)}. ${hint}`;
}

/** Within one edit (two for longer words), counting a swap of neighbours as one edit. */
function isNearMiss(a: string, b: string): boolean {
  const limit = Math.min(a.length, b.length) > 4 ? 2 : 1;
  if (Math.abs(a.length - b.length) > limit) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(d[i - 1]![j]! + 1, row[j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]! <= limit;
}

/** Splits "/roll 2d10" into the name and everything after the first space. */
function split(line: string): { name: string; args: string | undefined } {
  const body = line.trimStart().slice(1);
  const space = body.search(/\s/);
  return space === -1
    ? { name: body, args: undefined }
    : { name: body.slice(0, space), args: body.slice(space + 1) };
}

/**
 * Reads one input line. Plain text is chat (or a name, in name mode), `//text` says text that
 * starts with a slash, and `/x args` runs command x. Nothing visible is `empty`, to drop quietly.
 */
export function parseInputLine(line: string, mode: InputMode = "chat"): Parsed {
  if (cleanText(line) === "") return { kind: "empty" };
  const start = line.trimStart();
  if (start.startsWith("//")) return sayLine(start.slice(1));
  if (!start.startsWith("/")) return mode === "name" ? nameLine(line) : sayLine(line);
  const { name, args } = split(start);
  if (name === "") return { kind: "help" };
  const entry = find(name);
  if (!entry) return { kind: "refusal", message: unknown(name) };
  return entry.run(args ?? "");
}

/**
 * Tab completion for the whole line. Each result is a full replacement line: command names
 * after a slash (with a space when the command takes arguments), then the command's arguments.
 */
export function completeLine(
  state: TableState,
  actor: string,
  line: string,
): ReadonlyArray<string> {
  const start = line.trimStart();
  if (!start.startsWith("/") || start.startsWith("//")) return [];
  const { name, args } = split(start);
  if (args === undefined) {
    return namesFor(actor, name).map((n) => {
      const takesArgs = find(n)?.usage.includes(" ") ?? false;
      return takesArgs ? `/${n} ` : `/${n}`;
    });
  }
  const entry = find(name);
  if (!entry?.complete || (entry.gmOnly && actor !== GM)) return [];
  return entry.complete(state, actor, args).map((arg) => `/${entry.name} ${arg}`);
}

/** Summaries line up after usages this long; a longer usage puts its summary on the next line. */
const HELP_COLUMN = 15;

const helpLine = (e: Entry, width: number, gmMark: string) => {
  const summary = `${e.summary}${e.gmOnly ? ` ${gmMark}` : ""}`;
  return width > 0 && e.usage.length > width
    ? `${e.usage}\n${" ".repeat(width)}  ${summary}`
    : `${e.usage.padEnd(width)}  ${summary}`;
};

/** Why `/help <topic>` has nothing to show, when no command has that name. */
export const unknownHelpTopic = (topic: string | undefined): string | undefined =>
  topic === undefined || find(topic.replace(/^\//, "")) !== undefined ? undefined : unknown(topic);

/** The /help text for this actor: every command they can use where they are, or one command by name. */
export function helpText(actor: string, topic?: string, surface: Surface = "seat"): string {
  if (topic !== undefined) {
    const entry = find(topic.replace(/^\//, ""));
    if (!entry) return unknown(topic);
    if (entry.seatOnly && surface !== "seat") return `/${entry.name} works only at a seat.`;
    return helpLine(entry, 0, actor === GM ? "(GM)" : "(GM only)");
  }
  const shown = visibleTo(actor, surface);
  const width = Math.min(HELP_COLUMN, Math.max(...shown.map((e) => e.usage.length)));
  const bare = shown.filter((e) => BARE_OVER_EXEC.has(e.name)).map((e) => e.name);
  const intro =
    surface === "seat"
      ? "Plain text is chat. Commands start with /, and Tab completes them."
      : `Plain text is chat. Commands start with /; ${bare.length <= 1 ? bare.join("") : `${bare.slice(0, -1).join(", ")} and ${bare.at(-1)}`} work without it here.`;
  return [intro, ...shown.map((e) => helpLine(e, width, "(GM)"))].join("\n");
}
