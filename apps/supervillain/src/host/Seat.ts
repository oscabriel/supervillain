import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { View } from "@supervillain/engine";
import { Effect, FiberSet, type Scope, Stream } from "effect";
import { type Accessor, createComponent, createMemo, createRoot, createSignal } from "solid-js";
import {
  bandOf,
  completeLine,
  type FeedLine,
  feedLines,
  GM,
  mapOf,
  nameOf,
  tableLabel,
} from "../game/index.ts";
import { App } from "../table/App.tsx";
import type { Present, TableView } from "../table/view.ts";
import { debugText, type Reply, runLine } from "./line.ts";
import { Presence } from "./Presence.ts";
import type { TableServices } from "./services.ts";
import { TableRoom } from "./TableRoom.ts";

/** How long a seat gathers state changes before drawing them: about one frame. */
const BATCH = "16 millis";

export interface SeatOptions {
  readonly actor: string;
  /** Whose rate this seat's lines count against; the actor by default. */
  readonly rateKey?: string;
  readonly room: string;
  /** Closes the seat: ends the SSH session, or the GM's terminal and the host with it. */
  readonly leave: () => void;
  /** Appended to this seat's /help, e.g. how players join (for the GM). */
  readonly helpFooter?: string;
  /** How players join, shown on this seat while nobody else is at the table (for the GM). */
  readonly joinHint?: string;
  /** Said instead of the join hint, as it changes: how the relay link is doing (for the GM). */
  readonly joinNote?: View<string>;
  /** Trouble with the way in, for the header whatever is on screen (for the GM). */
  readonly alert?: View<string | undefined>;
}

/** A Solid accessor following a View, updated at most once per batch, for the life of the scope. */
const follow = <A>(view: View<A>): Effect.Effect<Accessor<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const [get, set] = createSignal<A>(yield* view.get, { equals: false });
    yield* view.changes.pipe(
      Stream.groupedWithin(1024, BATCH),
      Stream.runForEach((batch) =>
        Effect.sync(() => {
          // By length, not by value: a view may well change to undefined.
          if (batch.length > 0) set(() => batch[batch.length - 1] as A);
        }),
      ),
      Effect.forkScoped,
    );
    return get;
  });

/**
 * Reuses last time's row for every line whose seq, label, kind and text are unchanged. The feed
 * renders rows by identity, so an append adds one row instead of rebuilding up to FEED_LIMIT.
 */
const keepRows = () => {
  let previous = new Map<number, FeedLine>();
  return (lines: ReadonlyArray<FeedLine>): ReadonlyArray<FeedLine> => {
    const next = new Map<number, FeedLine>();
    const kept = lines.map((line) => {
      const old = previous.get(line.seq);
      const row =
        old && old.who === line.who && old.kind === line.kind && old.text === line.text
          ? old
          : line;
      next.set(line.seq, row);
      return row;
    });
    previous = next;
    return kept;
  };
};

/** What the App shows for a reply: nothing once the line is in the feed, else the text. */
const replyText = (reply: Reply): string | undefined =>
  reply.kind === "message" || reply.kind === "refusal" ? reply.text : undefined;

/**
 * Opens one seat: enters presence for the life of the scope and builds the TableView the App
 * reads. Labels are resolved here, from the current names and heroes, every time the feed is
 * projected, and so are this seat's Draw Steel band and map.
 */
export const openSeat = (
  options: SeatOptions,
): Effect.Effect<TableView, never, Scope.Scope | TableServices> =>
  Effect.gen(function* () {
    const { actor } = options;
    const room = yield* TableRoom;
    const presence = yield* Presence;
    yield* presence.enter(actor);
    const state = yield* follow(room.state);
    const recent = yield* follow(room.recent);
    const here = yield* follow(presence.here);
    const joinNote = options.joinNote === undefined ? undefined : yield* follow(options.joinNote);
    const alert = options.alert === undefined ? undefined : yield* follow(options.alert);
    // In-flight submits end with the seat.
    const run = yield* FiberSet.makeRuntimePromise<TableServices>();
    const rows = keepRows();

    const derived = createRoot((dispose) => ({
      dispose,
      feed: createMemo(() => rows(feedLines(state(), tableLabel(state())))),
      present: createMemo((): ReadonlyArray<Present> => {
        const label = tableLabel(state());
        return here().map((a) => ({ actor: a, label: label(a), gm: a === GM }));
      }),
      myName: createMemo(() => nameOf(state(), actor)),
      ...(() => {
        // The band and the map read the Draw Steel slice and the names, which a chat line leaves
        // as they were: then neither is built, nor drawn, again.
        const ds = createMemo(() => state().ds);
        const sw = createMemo(() => state().sw);
        const names = createMemo(() => state().core.names);
        return {
          combat: createMemo(() => bandOf({ ds: ds(), sw: sw(), core: { names: names() } }, actor)),
          map: createMemo(() => mapOf({ ds: ds(), sw: sw() }, actor)),
        };
      })(),
    }));
    yield* Effect.addFinalizer(() => Effect.sync(derived.dispose));

    const footer = options.helpFooter === undefined ? "" : `\n\n${options.helpFooter}`;
    return {
      me: actor,
      room: options.room,
      feed: derived.feed,
      present: derived.present,
      myName: derived.myName,
      combat: derived.combat,
      map: derived.map,
      submit: (line) =>
        run(
          runLine(actor, line, "seat", options.rateKey ?? actor).pipe(
            Effect.map((reply) => {
              const text = replyText(reply);
              return reply.kind === "message" && /^\s*\/help\s*$/i.test(line)
                ? `${text}${footer}`
                : text;
            }),
          ),
        ),
      complete: (line) => completeLine(state(), actor, line),
      // The App opens the state pane only on the GM's seat; this is the backstop.
      debug: () =>
        actor === GM ? debugText(state(), recent()) : "Only the GM can see the table's state.",
      leave: options.leave,
      ...(options.joinHint === undefined ? {} : { joinHint: options.joinHint }),
      ...(joinNote === undefined ? {} : { joinNote }),
      ...(alert === undefined ? {} : { alert }),
    } satisfies TableView;
  });

/** Draws the table App for `view` on a renderer. The App goes when the renderer is destroyed. */
export const mountTable = (renderer: CliRenderer, view: TableView): Effect.Effect<void> =>
  Effect.promise(() => render(() => createComponent(App, { view }), renderer));
