import type { Decision, Dice, Envelope } from "@supervillain/engine";
import * as Schema from "effect/Schema";
import { parseNotation, signed } from "./dice.ts";
import { GM, type Module, type Shared } from "./module.ts";
import {
  cleanText,
  hasControls,
  hasTerminalControls,
  lengthOf,
  looksLikeGuestLabel,
  mixesLatin,
  nameKey,
} from "./text.ts";

export const CHAT_MAX = 500;
export const NAME_MAX = 24;
/**
 * What replay holds stored text to: room for today's limits to grow. Decide enforces the real
 * rules; replay checks only facts no rule change or Unicode upgrade can move (see `storedText`).
 */
const STORED_CHAT_MAX = 4 * CHAT_MAX;
const STORED_NAME_MAX = 4 * NAME_MAX;

/** Who is who. Names live here, apart from the feed, so a label never depends on the feed cap. */
export interface CoreState {
  /** Display names by actor, set by `core.name-set`. */
  readonly names: Readonly<Record<string, string>>;
}

export type CoreCommand =
  | { readonly type: "say"; readonly text: string }
  | { readonly type: "me"; readonly text: string }
  | { readonly type: "narrate"; readonly text: string }
  | {
      readonly type: "name";
      readonly name: string;
      /**
       * Actors with a seat open when the line was sent, filled in by the host (presence isn't in
       * the log). Their labels are held: a guest's name only while they sit, a key's for good.
       */
      readonly seated?: ReadonlyArray<string>;
      /** The names of the heroes, creatures and fighters in play, filled in by the host. */
      readonly cast?: ReadonlyArray<string>;
    }
  | { readonly type: "roll"; readonly notation: string };

/** Plain chat has no style; `/me` is an emote and the GM's `/narrate` is narration, with no speaker. */
const ChatPosted = Schema.Struct({
  text: Schema.String,
  style: Schema.optionalKey(Schema.Literals(["emote", "narration"])),
});
type ChatStyle = "emote" | "narration";
const NameSet = Schema.Struct({ name: Schema.String });
const DiceRolled = Schema.Struct({
  notation: Schema.String,
  rolls: Schema.Array(Schema.Int),
  modifier: Schema.Int,
  total: Schema.Int,
});

/** Offered when completing /roll; Draw Steel's power roll comes first. */
const COMMON_DICE = ["2d10", "d3", "d6", "d10", "d20", "d100"];

const refuse = (refusal: string): Decision => ({ refusal });

/** Decodes a payload or throws, naming the event. */
function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  envelope: Envelope,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(envelope.payload);
  } catch (e) {
    throw new Error(
      `bad ${envelope.type} payload at seq ${envelope.seq}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Chat text after cleaning, or why it can't be posted. */
function chatText(raw: string): string | { refusal: string } {
  const text = cleanText(raw);
  if (text === "") return { refusal: "Say something." };
  const length = lengthOf(text);
  if (length > CHAT_MAX)
    return { refusal: `Keep it to ${CHAT_MAX} characters (that was ${length}).` };
  return text;
}

/**
 * What the table draws around a label, "Alice (Vex)" or "Oscar (GM)", and the feed's own marks,
 * "↶ GM undid: …" or "→ 10/24 · winded", which a name must not fake.
 */
const MARKS = /[()[\]{}↶↷→·]/;

/**
 * A display name in its stored form (compatibility-normalised, trimmed, whitespace collapsed),
 * or why it can't be one. Anything a terminal would act on or draw as nothing is refused, not stripped.
 */
function normalName(raw: string): string | { refusal: string } {
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name === "") return { refusal: "Pick a name." };
  if (hasControls(name)) return { refusal: "Names can't hold control or invisible characters." };
  if (cleanText(name) !== name) return { refusal: "Names can't hold stray or stacked accents." };
  if (lengthOf(name) > NAME_MAX) return { refusal: `Keep names to ${NAME_MAX} characters.` };
  if (mixesLatin(name)) return { refusal: "Names can't mix Latin letters with another script's." };
  return name;
}

/**
 * Whether stored text may be replayed: some text, within a generous bound, and nothing a terminal
 * acts on or that reorders a line. Decide's sanitising may change; this must not, or an old log
 * would halt the writer.
 */
const storedText = (text: string, max: number): boolean =>
  text !== "" && lengthOf(text) <= max && !hasTerminalControls(text);

type NameCommand = Extract<CoreCommand, { readonly type: "name" }>;

/**
 * Every label someone other than `actor` answers to, as name keys: "GM", then each key's name and
 * default label (held for good: a key is a person), the labels of everyone seated, and the names
 * of those in play, so no line reads as a hero's. A guest is a new actor each connection, so a
 * guest's name is held only while that guest is seated.
 */
function takenLabels(
  slice: CoreState,
  shared: Shared,
  actor: string,
  { seated = [], cast = [] }: NameCommand,
): Set<string> {
  const others = new Set([
    GM,
    ...[...shared.actors, ...Object.keys(slice.names)].filter((a) => !a.startsWith("guest:")),
    ...seated,
  ]);
  others.delete(actor);
  const taken = new Set(cast.map(nameKey));
  for (const other of others) {
    taken.add(nameKey(defaultLabel(other)));
    const name = slice.names[other];
    if (name !== undefined) taken.add(nameKey(name));
  }
  return taken;
}

function chooseName(
  slice: CoreState,
  shared: Shared,
  actor: string,
  command: NameCommand,
): Decision {
  const name = normalName(command.name);
  if (typeof name !== "string") return name;
  if (slice.names[actor] === name) return refuse(`You're already ${name}.`);
  const key = nameKey(name);
  if (takenLabels(slice, shared, actor, command).has(key))
    return refuse(`"${name}" is taken; pick another name.`);
  if (MARKS.test(name)) return refuse(`"${name}" would read like a marker; pick another name.`);
  if (looksLikeGuestLabel(name) && key !== nameKey(defaultLabel(actor)))
    return refuse(`"${name}" looks like a guest's label; pick another name.`);
  return { events: [{ type: "core.name-set", payload: { name } }] };
}

function roll(raw: string, dice: Dice): Decision {
  const notation = parseNotation(raw);
  if ("refusal" in notation) return notation;
  const rolls = Array.from({ length: notation.count }, () => dice(notation.sides));
  for (const face of rolls) {
    if (!Number.isInteger(face) || face < 1 || face > notation.sides)
      throw new Error(`the dice gave ${face} for a d${notation.sides}`);
  }
  const total = sum(rolls) + notation.modifier;
  const payload = { notation: notation.text, rolls, modifier: notation.modifier, total };
  return { events: [{ type: "core.dice-rolled", payload }] };
}

const sum = (ns: ReadonlyArray<number>) => ns.reduce((a, b) => a + b, 0);

function post(raw: string, style?: ChatStyle): Decision {
  const text = chatText(raw);
  if (typeof text !== "string") return text;
  const payload = style === undefined ? { text } : { text, style };
  return { events: [{ type: "core.chat-posted", payload }] };
}

export const core: Module<"core", CoreState, CoreCommand> = {
  key: "core",
  initial: { names: {} },
  events: ["core.chat-posted", "core.name-set", "core.dice-rolled"],
  formats: {
    chat: { speaker: true, separator: ": " },
    emote: { speaker: true, separator: " " },
    narration: { speaker: false, separator: "" },
    roll: { speaker: true, separator: " " },
    name: { speaker: false, separator: "" },
  },
  commands: {
    say: {
      usage: "/say <text>",
      summary: "Say something to the table (plain text does the same).",
      gmOnly: false,
      parse: (args) =>
        cleanText(args) === "" ? { refusal: "Usage: /say <text>" } : { type: "say", text: args },
    },
    me: {
      usage: "/me <action>",
      summary: "Act something out: /me waves.",
      gmOnly: false,
      parse: (args) =>
        cleanText(args) === "" ? { refusal: "Usage: /me <action>" } : { type: "me", text: args },
    },
    narrate: {
      usage: "/narrate <text>",
      summary: "Describe the scene, with no speaker.",
      gmOnly: true,
      parse: (args) =>
        cleanText(args) === ""
          ? { refusal: "Usage: /narrate <text>" }
          : { type: "narrate", text: args },
    },
    name: {
      usage: "/name <name>",
      summary: "Set the name the table calls you.",
      gmOnly: false,
      parse: (args) =>
        args.trim() === "" ? { refusal: "Usage: /name <name>" } : { type: "name", name: args },
    },
    roll: {
      usage: "/roll <dice>",
      summary: "Roll dice: 2d10+3, d20, 3d6-1.",
      gmOnly: false,
      parse: (args) => {
        if (args.trim() === "") return { refusal: "Usage: /roll <dice>, e.g. 2d10+3" };
        const notation = parseNotation(args);
        return "refusal" in notation ? notation : { type: "roll", notation: notation.text };
      },
      complete: (_slice, partial) => {
        const typed = partial.trim().toLowerCase();
        return COMMON_DICE.filter((d) => d.startsWith(typed));
      },
    },
  },
  decide: (slice, shared, actor, command, dice) => {
    switch (command.type) {
      case "say":
        return post(command.text);
      case "me":
        return post(command.text, "emote");
      case "narrate":
        return post(command.text, "narration");
      case "name":
        return chooseName(slice, shared, actor, command);
      case "roll":
        return roll(command.notation, dice);
    }
  },
  apply: (slice, envelope) => {
    switch (envelope.type) {
      case "core.chat-posted": {
        const { text, style } = decode(ChatPosted, envelope);
        if (!storedText(text, STORED_CHAT_MAX))
          throw new Error(`unsafe chat text at seq ${envelope.seq}`);
        return { slice, feed: { kind: style ?? "chat", text } };
      }
      case "core.name-set": {
        const { name } = decode(NameSet, envelope);
        if (!storedText(name, STORED_NAME_MAX))
          throw new Error(`bad name ${JSON.stringify(name)} at seq ${envelope.seq}`);
        const was = slice.names[envelope.actor];
        return {
          slice: { names: { ...slice.names, [envelope.actor]: name } },
          // A first name is someone arriving; the label they had till now was only a placeholder.
          feed: {
            kind: "name",
            text: was === undefined ? `${name} joins the table.` : `${was} is now ${name}`,
          },
        };
      }
      case "core.dice-rolled": {
        const p = decode(DiceRolled, envelope);
        const notation = parseNotation(p.notation);
        const fits =
          !("refusal" in notation) &&
          notation.text === p.notation &&
          notation.count === p.rolls.length &&
          notation.modifier === p.modifier &&
          p.rolls.every((face) => face >= 1 && face <= notation.sides) &&
          sum(p.rolls) + p.modifier === p.total;
        if (!fits) throw new Error(`the roll at seq ${envelope.seq} doesn't add up`);
        const text = `rolled ${p.notation}: [${p.rolls.join(", ")}]${p.modifier === 0 ? "" : ` ${signed(p.modifier)}`} = ${p.total}`;
        return { slice, feed: { kind: "roll", text } };
      }
      default:
        throw new Error(`core can't apply "${envelope.type}"`);
    }
  },
};

/** The label an actor has before choosing a name. */
export function defaultLabel(actor: string): string {
  if (actor === GM) return "GM";
  if (actor.startsWith("key:"))
    return actor
      .slice(4)
      .replace(/^SHA256:/, "")
      .slice(0, 8);
  if (actor.startsWith("guest:")) return `guest-${actor.slice(6, 10)}`;
  return cleanText(actor).slice(0, 12);
}

/** Labels actors by display name, else their default label. Read it when projecting, never store it. */
export const labelOf =
  (state: { readonly core: CoreState }) =>
  (actor: string): string =>
    state.core.names[actor] ?? defaultLabel(actor);

/** Whether the table should ask this actor what to call them (Q2). The GM never needs a name. */
export const needsName = (state: { readonly core: CoreState }, actor: string): boolean =>
  actor !== GM && state.core.names[actor] === undefined;

/** This actor's display name, if they have chosen one. */
export const nameOf = (state: { readonly core: CoreState }, actor: string): string | undefined =>
  state.core.names[actor];
