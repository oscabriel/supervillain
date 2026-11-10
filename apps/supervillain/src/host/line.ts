import { type Envelope, Refusal } from "@supervillain/engine";
import { DateTime, Effect, Random } from "effect";
import { CampaignContent, type LoadError, type MapLoadError } from "../content/index.ts";
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
  MAP_SEED_MAX,
  mapGeneration,
  mapNeed,
  parseInputLine,
  SEED_MAX,
  setNeed,
  sheetOf,
  type Surface,
  tableLabel,
  type TableState,
  unknownHelpTopic,
  withHostFact,
  withMapGrid,
  withMapId,
  withSetFact,
} from "../game/index.ts";
import { writeGeneratedMap } from "../content/newMap.ts";
import { nameKey } from "../game/text.ts";
import { shownState } from "./check.ts";
import { Presence } from "./Presence.ts";
import type { TableServices } from "./services.ts";
import { SetWorld } from "./SetWorld.ts";
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

/** The types of the commands only the GM may use. */
const GM_ONLY: ReadonlySet<string> = new Set(commands.filter((c) => c.gmOnly).map((c) => c.type));

/** A sheet that won't load, refused on one line: a seat gives a one-line refusal back to fix. */
const refused = (e: LoadError | MapLoadError) =>
  new Refusal({
    message: e._tag === "SheetInvalid" ? `${e.file}: ${e.problems.join("; ")}` : e.message,
  });

/**
 * The actor a typed label names: someone seated first, then any key the log knows. A guest who has
 * left answers to no name: they are a new actor next time, and someone else may have the name now.
 * Labels are compared the way names are (case and lookalikes don't count), by their own label, not
 * their hero.
 */
const actorLabelled = (
  state: TableState,
  seated: ReadonlyArray<string>,
  typed: string,
): string | undefined => {
  const label = labelOf(state);
  const key = nameKey(typed);
  const away = [...state.actors, ...Object.keys(state.core.names)];
  const known = [...seated, ...away.filter((actor) => !actor.startsWith("guest:"))];
  return known.find((actor) => actor !== GM && nameKey(label(actor)) === key);
};

/**
 * Adds what the host knows and the rules can't see: who is seated, for a name to be checked against
 * (with the names in play, whichever ruleset's) and a hero whose guest has left to be taken; the
 * time now, for a player's /undo window, and whose change a GM's `/undo <who>` means; the sheet a /hero or /add brings in, or the map a /map loads,
 * read from the campaign folder now so the event carries it (a /map new writes it there first, from
 * its seed); the character a set.world /recruit or /foe rolls at set.world, by its seed or one
 * picked here; and the actor a GM's /play names. A file that can't be read, or a roll that doesn't
 * come, is refused, saying why. Nothing is read or fetched for a GM-only command someone else sent:
 * the rules refuse it as it is.
 */
const withHostFacts = (
  actor: string,
  typed: Command,
): Effect.Effect<Command, Refusal, TableServices> =>
  Effect.gen(function* () {
    // Whose guest has left, for a hero they held to be free to take.
    const command: Command =
      typed.type === "play" || typed.type === "set-play"
        ? { ...typed, seated: yield* (yield* Presence).here.get }
        : typed;
    if (command.type === "name") {
      const seated = yield* (yield* Presence).here.get;
      const { ds, sw } = yield* (yield* TableRoom).state.get;
      const inPlay = [...ds.heroes.map((h) => h.sheet), ...ds.creatures, ...sw.fighters];
      return { ...command, seated, cast: inPlay.map((w) => w.name) };
    }
    // The same clock the room stamps envelopes with, so the window is measured on one clock; and
    // for `/undo <who>`, whose change, found the way a GM's /play finds a player.
    if (command.type === "undo") {
      const now = DateTime.formatIso(yield* DateTime.now);
      if (command.who === undefined) return { ...command, now };
      const state = yield* (yield* TableRoom).state.get;
      const seated = yield* (yield* Presence).here.get;
      const whose =
        nameKey(command.who) === nameKey(labelOf(state)(GM))
          ? GM
          : actorLabelled(state, seated, command.who);
      return whose === undefined ? { ...command, now } : { ...command, now, whose };
    }
    if (actor !== GM && GM_ONLY.has(command.type)) return command;
    const content = yield* CampaignContent;
    // `/map new`: the map is generated into maps/ now, by the seed typed or one picked here, and
    // then loaded as `/map <id>` is, so the event carries its grid and replay reads no file.
    const generate = mapGeneration(command);
    if (generate !== undefined) {
      const seed = generate.seed ?? (yield* Random.nextIntBetween(0, MAP_SEED_MAX));
      const written = yield* writeGeneratedMap(content.dir, generate.kind, seed).pipe(
        Effect.mapError(
          (e) =>
            new Refusal({
              message:
                e.reason === "exists"
                  ? `There's already a map called ${e.id} in maps/: /map ${e.id} loads it.`
                  : `Can't make that ${generate.kind}: ${e.message}.`,
            }),
        ),
      );
      return yield* withHostFacts(actor, withMapId(command, written.id));
    }
    const set = setNeed(command);
    if (set !== undefined) {
      if (set.kind === "map") {
        const { id, grid } = yield* content.map(set.id).pipe(Effect.mapError(refused));
        return withSetFact(command, { kind: "map", id, grid });
      }
      const seed = set.seed ?? (yield* Random.nextIntBetween(0, SEED_MAX));
      const character = yield* (yield* SetWorld).roll(seed).pipe(
        Effect.mapError(
          (e) =>
            new Refusal({
              message: `No roll from set.world for seed ${seed}: ${e.message}${/[.?!]$/.test(e.message) ? "" : "."}`,
            }),
        ),
      );
      return withSetFact(command, { kind: "character", character });
    }
    const mapId = mapNeed(command);
    if (mapId !== undefined) {
      const { id, grid } = yield* content.map(mapId).pipe(Effect.mapError(refused));
      return withMapGrid(command, grid, id);
    }
    const need = hostNeeds(command);
    if (need === undefined) return command;
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
    const { ruleset } = yield* CampaignContent;
    const parsed = parseInputLine(line, "chat", ruleset);
    switch (parsed.kind) {
      case "empty":
        return { kind: "empty" };
      case "refusal":
        return { kind: "refusal", text: parsed.message };
      case "help": {
        const unknown = unknownHelpTopic(parsed.topic, ruleset);
        if (unknown !== undefined) return { kind: "refusal", text: unknown };
        return { kind: "message", text: helpText(actor, parsed.topic, surface, ruleset) };
      }
      case "sheet": {
        const text = sheetOf(yield* room.state.get, parsed.who, ruleset);
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
          const lines = feedLines(state, tableLabel(state, ruleset)).filter((l) => seqs.has(l.seq));
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

/** The state pane: the state as JSON (see `shownState`), then the last envelopes. */
export function debugText(state: TableState, recent: ReadonlyArray<Envelope>): string {
  const shown = shownState(state);
  return [
    JSON.stringify(shown, null, 2),
    "",
    `last ${recent.length} envelopes:`,
    ...recent.map((e) => JSON.stringify(e)),
  ].join("\n");
}
