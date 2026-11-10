import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { View } from "@supervillain/engine";
import { Cause, Effect, FiberSet, type Scope, Stream } from "effect";
import {
  type Accessor,
  catchError,
  createComponent,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
} from "solid-js";
import {
  actionsOf,
  bandOf,
  completeLine,
  feedLines,
  GM,
  mapOf,
  nameOf,
  type PrepCatalog,
  prepOf,
  tableLabel,
} from "../game/index.ts";
import { CampaignContent } from "../content/index.ts";
import { App } from "../table/App.tsx";
import { kept } from "../table/keep.ts";
import type { PrepSource, Present, TableView } from "../table/view.ts";
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
        }).pipe(
          // Drawing it threw. Say why, and follow on: the next change may well draw.
          Effect.catchCause((cause) => Effect.logError("a seat couldn't draw a change", cause)),
        ),
      ),
      Effect.forkScoped,
    );
    return get;
  });

/** What the App shows for a reply: nothing once the line is in the feed, else the text. */
const replyText = (reply: Reply): string | undefined =>
  reply.kind === "message" || reply.kind === "refusal" ? reply.text : undefined;

/**
 * Opens one seat: enters presence for the life of the scope and builds the TableView the App
 * reads. Labels are resolved here, from the current names and heroes, every time the feed is
 * projected, and so are this seat's band and map, of the campaign's ruleset, and on the GM's seat
 * the prep panel, from the campaign's files as they were when it last opened.
 */
export const openSeat = (
  options: SeatOptions,
): Effect.Effect<TableView, never, Scope.Scope | TableServices> =>
  Effect.gen(function* () {
    const { actor } = options;
    const room = yield* TableRoom;
    const presence = yield* Presence;
    const content = yield* CampaignContent;
    const { ruleset } = content;
    yield* presence.enter(actor);
    const state = yield* follow(room.state);
    const recent = yield* follow(room.recent);
    const here = yield* follow(presence.here);
    const joinNote = options.joinNote === undefined ? undefined : yield* follow(options.joinNote);
    const alert = options.alert === undefined ? undefined : yield* follow(options.alert);
    // In-flight submits end with the seat.
    const run = yield* FiberSet.makeRuntimePromise<TableServices>();
    /**
     * One of the seat's views, projected from the table's state and kept as last time's wherever
     * it reads the same, so the App draws nothing again for it. One that throws is logged with
     * why, and the seat shows what it last could until a state it can project.
     */
    const projected = <A>(project: () => A, initial: A) =>
      createMemo<A>((was) => {
        try {
          return kept(was, project());
        } catch (error) {
          void run(Effect.logError(`seat ${actor}: couldn't project the table`, Cause.die(error)));
          return was;
        }
      }, initial);
    // The prep panel's files, as the GM's seat last read them (when the panel opened).
    const [catalog, setCatalog] = createSignal<PrepCatalog>();
    const reload = () =>
      run(
        content.catalog.pipe(
          Effect.match({
            onFailure: (e) => e.message,
            onSuccess: (files) => void setCatalog(files),
          }),
        ),
        // The seat closed while it read: nothing is left to list them.
      ).catch(() => undefined);

    const derived = createRoot((dispose) => ({
      dispose,
      feed: projected(() => feedLines(state(), tableLabel(state(), ruleset)), []),
      present: projected((): ReadonlyArray<Present> => {
        const label = tableLabel(state(), ruleset);
        return here().map((a) => ({ actor: a, label: label(a), gm: a === GM }));
      }, []),
      myName: projected(() => nameOf(state(), actor), undefined),
      ...(() => {
        // The band and the map read the game's slices and the names, which a chat line leaves
        // as they were: then neither is built, nor drawn, again.
        const ds = createMemo(() => state().ds);
        const sw = createMemo(() => state().sw);
        const names = createMemo(() => state().core.names);
        // A map loaded that the files read last didn't have (a `/map new` just wrote it): read
        // them again, so the GM's prep panel lists it, loaded. Once for the map, not for every
        // event while it is loaded.
        const mapId = createMemo(() => (ruleset === "set-world" ? sw().map?.id : ds().map?.id));
        if (actor === GM)
          createEffect(
            on(
              mapId,
              (id) => {
                const files = catalog();
                if (id !== undefined && files !== undefined && !files.maps.some((m) => m.id === id))
                  void reload();
              },
              { defer: true },
            ),
          );
        return {
          combat: projected(
            () => bandOf({ ds: ds(), sw: sw(), core: { names: names() } }, actor, ruleset),
            undefined,
          ),
          map: projected(() => mapOf({ ds: ds(), sw: sw() }, actor, ruleset), undefined),
          prep: projected(() => {
            const files = catalog();
            return files === undefined ? undefined : prepOf({ ds: ds(), sw: sw() }, files, ruleset);
          }, undefined),
        };
      })(),
    }));
    yield* Effect.addFinalizer(() => Effect.sync(derived.dispose));

    const prep: PrepSource = { view: derived.prep, reload };
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
      complete: (line) => completeLine(state(), actor, line, ruleset),
      actions: (id) => actionsOf(state(), actor, ruleset, id),
      // The App opens the state pane only on the GM's seat; this is the backstop.
      debug: () =>
        actor === GM ? debugText(state(), recent()) : "Only the GM can see the table's state.",
      leave: options.leave,
      // The GM prepares the game; a player's seat has no prep panel.
      ...(actor === GM ? { prep } : {}),
      ...(options.joinHint === undefined ? {} : { joinHint: options.joinHint }),
      ...(joinNote === undefined ? {} : { joinNote }),
      ...(alert === undefined ? {} : { alert }),
    } satisfies TableView;
  });

/**
 * Draws the table App for `view` on a renderer. The App goes when the renderer is destroyed. A
 * throw while it lays the table out is logged with why: caught here, it leaves the rest of the
 * App drawing, where it would otherwise freeze the seat, and the App says so on the seat.
 */
export const mountTable = (renderer: CliRenderer, view: TableView): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fork = Effect.runForkWith(yield* Effect.context());
    const report = (error: unknown) =>
      void fork(Effect.logError(`seat ${view.me}: couldn't draw the table`, Cause.die(error)));
    yield* Effect.promise(() =>
      render(() => catchError(() => createComponent(App, { view }), report), renderer),
    );
  });
