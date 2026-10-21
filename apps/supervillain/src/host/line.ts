import { type Envelope, Refusal } from "@supervillain/engine";
import { Effect } from "effect";
import { CampaignContent, type LoadError } from "../content/index.ts";
import {
  BARE_OVER_EXEC,
  type Command,
  commands,
  type FeedLine,
  feedLines,
  GM,
  helpText,
  hostNeeds,
  labelOf,
  parseInputLine,
  sheetOf,
  type Surface,
  tableLabel,
  type TableState,
  withHostFact,
} from "../game/index.ts";
import { nameKey } from "../game/text.ts";
import { Presence } from "./Presence.ts";
import type { TableServices } from "./services.ts";
import { TableRoom } from "./TableRoom.ts";

/** What one input line came to, for the seat or exec channel that sent it. */
export type Reply =
  /** Accepted and written: the feed lines it made. */
  | { readonly kind: "done"; readonly lines: ReadonlyArray<FeedLine> }
  /** For the sender only, nothing written: help or the state text. */
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "refusal"; readonly text: string }
  /** Nothing visible was typed. */
  | { readonly kind: "empty" };

const GM_ONLY: ReadonlySet<string> = new Set(commands.filter((c) => c.gmOnly).map((c) => c.name));

/** A sheet that won't load, refused on one line: a seat gives a one-line refusal back to fix. */
const refused = (e: LoadError) =>
  new Refusal({
    message: e._tag === "SheetInvalid" ? `${e.file}: ${e.problems.join("; ")}` : e.message,
  });

/**
 * The actor a typed label names: someone seated first, then anyone the log knows. Labels are
 * compared the way names are (case and lookalikes don't count), by their own label, not their hero.
 */
const actorLabelled = (
  state: TableState,
  seated: ReadonlyArray<string>,
  typed: string,
): string | undefined => {
  const label = labelOf(state);
  const key = nameKey(typed);
  const known = [...seated, ...state.actors, ...Object.keys(state.core.names)];
  return known.find((actor) => actor !== GM && nameKey(label(actor)) === key);
};

/**
 * Adds what the host knows and the rules can't see: who is seated, for a name to be checked
 * against; the sheet a /hero or /add brings in, read from the campaign folder now so the event
 * carries it; and the actor a GM's /play names. A sheet that can't be read is refused, naming
 * the file and the field. Nothing is read for a GM-only command someone else sent: the rules
 * refuse it as it is.
 */
const withHostFacts = (
  actor: string,
  command: Command,
): Effect.Effect<Command, Refusal, TableServices> =>
  Effect.gen(function* () {
    if (command.type === "name") {
      const seated = yield* (yield* Presence).here.get;
      return { ...command, seated };
    }
    const need = hostNeeds(command);
    if (need === undefined || (actor !== GM && GM_ONLY.has(command.type))) return command;
    const content = yield* CampaignContent;
    switch (need.kind) {
      case "hero": {
        const sheet = yield* content.hero(need.id).pipe(Effect.mapError(refused));
        return withHostFact(command, { kind: "hero", sheet });
      }
      case "monster": {
        const sheet = yield* content.monster(need.id).pipe(Effect.mapError(refused));
        return withHostFact(command, { kind: "monster", sheet });
      }
      case "player": {
        const state = yield* (yield* TableRoom).state.get;
        const seated = yield* (yield* Presence).here.get;
        const found = actorLabelled(state, seated, need.label);
        return found === undefined
          ? command
          : withHostFact(command, { kind: "player", actor: found });
      }
    }
  });

/**
 * Runs one input line as `actor`: parses it with the command registry, answers the sender-only
 * commands (/help, /sheet, /state, /quit) itself, and submits the rest to the room, rated by
 * `rateKey`.
 */
export const runLine = (
  actor: string,
  line: string,
  surface: Surface = "seat",
  rateKey: string = actor,
): Effect.Effect<Reply, never, TableServices> =>
  Effect.gen(function* () {
    const room = yield* TableRoom;
    const parsed = parseInputLine(line);
    switch (parsed.kind) {
      case "empty":
        return { kind: "empty" };
      case "refusal":
        return { kind: "refusal", text: parsed.message };
      case "help":
        return { kind: "message", text: helpText(actor, parsed.topic, surface) };
      case "sheet": {
        const text = sheetOf(yield* room.state.get, parsed.who);
        return typeof text === "string"
          ? { kind: "message", text }
          : { kind: "refusal", text: text.refusal };
      }
      case "state":
        if (actor !== GM) return { kind: "refusal", text: "Only the GM can use /state." };
        return {
          kind: "message",
          text: debugText(yield* room.state.get, yield* room.recent.get),
        };
      case "quit":
        // A seat leaves on /quit before it gets here; a one-off command has nothing to leave.
        return { kind: "refusal", text: "There's no seat to leave: this command ends by itself." };
      case "command":
        break;
    }
    return yield* withHostFacts(actor, parsed.command).pipe(
      Effect.flatMap((command) => room.submit(actor, command, rateKey)),
      Effect.flatMap((written) =>
        Effect.map(room.state.get, (state): Reply => {
          const seqs = new Set(written.map((e) => e.seq));
          const lines = feedLines(state, tableLabel(state)).filter((l) => seqs.has(l.seq));
          return { kind: "done", lines };
        }),
      ),
      Effect.catchTag("Refusal", (e) =>
        Effect.succeed<Reply>({ kind: "refusal", text: e.message }),
      ),
    );
  });

/**
 * Reads an exec command (`ssh host roll 2d10`) as an input line. A shell would make you quote a
 * slash-free command, so a leading `roll`, `help` or `state` needs none. Commands that take free
 * text keep their slash, since a chat line often starts with "me", "say" or "name".
 */
export function execLine(command: string): string {
  const word = /^\S+/.exec(command)?.[0];
  return word !== undefined && BARE_OVER_EXEC.has(word.toLowerCase()) ? `/${command}` : command;
}

/** The state pane: the state as JSON (the feed only counted, since it's on screen), then the last envelopes. */
export function debugText(state: TableState, recent: ReadonlyArray<Envelope>): string {
  const shown = { ...state, feed: `[${state.feed.length} lines]` };
  return [
    JSON.stringify(shown, null, 2),
    "",
    `last ${recent.length} envelopes:`,
    ...recent.map((e) => JSON.stringify(e)),
  ].join("\n");
}
