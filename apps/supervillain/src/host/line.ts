import type { Envelope } from "@supervillain/engine";
import { Effect } from "effect";
import {
  BARE_OVER_EXEC,
  type Command,
  type FeedLine,
  feedLines,
  GM,
  helpText,
  labelOf,
  parseInputLine,
  type Surface,
  type TableState,
} from "../game/index.ts";
import { Presence } from "./Presence.ts";
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

/** Adds what the host knows and the rules can't see: who is seated, for a name to be checked against. */
const withHostFacts = (command: Command): Effect.Effect<Command, never, Presence> =>
  Effect.gen(function* () {
    if (command.type !== "name") return command;
    const seated = yield* (yield* Presence).here.get;
    return { ...command, seated };
  });

/**
 * Runs one input line as `actor`: parses it with the command registry, answers seat-local
 * commands (/help, /state, /quit) itself, and submits the rest to the room.
 */
export const runLine = (
  actor: string,
  line: string,
  surface: Surface = "seat",
): Effect.Effect<Reply, never, TableRoom | Presence> =>
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
    const command = yield* withHostFacts(parsed.command);
    return yield* room.submit(actor, command).pipe(
      Effect.flatMap((written) =>
        Effect.map(room.state.get, (state): Reply => {
          const seqs = new Set(written.map((e) => e.seq));
          const lines = feedLines(state, labelOf(state)).filter((l) => seqs.has(l.seq));
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
