import { describe, expect } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Effect, Exit, Scope, SubscriptionRef } from "effect";
import { mountTable, openSeat } from "../../src/host/Seat.ts";
import { type TableServices, tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { sampleCampaign } from "./campaign.ts";
import { effect } from "./effect.ts";

const alice = "key:SHA256:aliceAAAAkeyfingerprint";
const bob = "key:SHA256:bobBBBBBkeyfingerprint";

/** A copy of the sample campaign with the table's services, for the length of `body`. */
const atTable = <A, E>(body: Effect.Effect<A, E, TableServices | Scope.Scope>) =>
  Effect.gen(function* () {
    const dir = yield* sampleCampaign;
    return yield* body.pipe(Effect.provide(tableServices(dir)));
  });

interface Seated {
  readonly t: TestRendererSetup;
  readonly view: Effect.Success<ReturnType<typeof openSeat>>;
  readonly left: () => number;
  /** Closes this seat's scope, as a dropped SSH session would. */
  readonly close: Effect.Effect<void>;
}

/** Opens a seat for `actor` in its own scope and mounts the App on a 100x30 test renderer. */
const seat = (actor: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let left = 0;
    const t = yield* Effect.acquireRelease(
      Effect.promise(() => createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })),
      (setup) => Effect.sync(() => setup.renderer.destroy()),
    ).pipe(Scope.provide(scope));
    const view = yield* openSeat({ actor, room: "den", leave: () => void left++ }).pipe(
      Scope.provide(scope),
    );
    yield* mountTable(t.renderer, view);
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    return { t, view, left: () => left, close: Scope.close(scope, Exit.void) } satisfies Seated;
  });

/** Draws frames until one satisfies `predicate`. */
const frameWhere = (s: Seated, what: string, predicate: (frame: string) => boolean) =>
  Effect.promise(async () => {
    const start = Date.now();
    for (;;) {
      await s.t.renderOnce();
      const frame = s.t.captureCharFrame();
      if (predicate(frame)) return frame;
      if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${what}:\n${frame}`);
      await Bun.sleep(10);
    }
  });

const type = (s: Seated, text: string) =>
  Effect.promise(async () => {
    await s.t.mockInput.typeText(text);
    s.t.mockInput.pressEnter();
  });

describe("a seat over a real room", () => {
  effect(
    "follows a view to undefined and back: the GM's relay alert clears once the link is up",
    () =>
      atTable(
        Effect.gen(function* () {
          const alert = yield* SubscriptionRef.make<string | undefined>("relay: connecting…");
          const view = yield* openSeat({
            actor: "gm",
            room: "den",
            leave: () => undefined,
            alert: { get: SubscriptionRef.get(alert), changes: SubscriptionRef.changes(alert) },
          });
          const settled = (want: string | undefined) =>
            Effect.promise(async () => {
              const start = Date.now();
              while (view.alert?.() !== want) {
                if (Date.now() - start > 2000) throw new Error(`alert stayed ${view.alert?.()}`);
                await Bun.sleep(10);
              }
            });
          yield* settled("relay: connecting…");
          yield* SubscriptionRef.set(alert, undefined);
          yield* settled(undefined);
          yield* SubscriptionRef.set(alert, "relay: down, redialing");
          yield* settled("relay: down, redialing");
        }),
      ),
  );

  effect("asks a new player's name, then chat reaches every seat's feed", () =>
    atTable(
      Effect.gen(function* () {
        const a = yield* seat(alice);
        const b = yield* seat(bob);
        yield* frameWhere(a, "the name prompt", (f) =>
          f.includes("what should the table call you?"),
        );
        yield* type(a, "Alice");
        yield* frameWhere(a, "chat mode", (f) => !f.includes("what should the table call you?"));
        yield* type(a, "hello all");
        yield* frameWhere(a, "the line in Alice's feed", (f) => f.includes("Alice: hello all"));
        yield* frameWhere(b, "the line in Bob's feed", (f) => f.includes("Alice: hello all"));
        expect(b.view.myName()).toBeUndefined();
        expect(a.view.myName()).toBe("Alice");
      }),
    ),
  );

  effect("labels every line by the speaker's current name", () =>
    atTable(
      Effect.gen(function* () {
        const a = yield* seat(alice);
        const b = yield* seat(bob);
        yield* type(a, "/say hi before my name");
        yield* frameWhere(b, "the default label", (f) => f.includes("aliceAAA: hi before my name"));
        yield* type(a, "Alice");
        yield* frameWhere(b, "the relabelled line", (f) => f.includes("Alice: hi before my name"));
        expect(b.view.feed().map((l) => l.who)).toEqual(["Alice", "Alice"]);
      }),
    ),
  );

  effect("shows who is here until each seat's scope closes", () =>
    atTable(
      Effect.gen(function* () {
        const a = yield* seat(alice);
        const b = yield* seat(bob);
        yield* frameWhere(a, "Bob's seat", (f) => f.includes("bobBBBBB"));
        expect(a.view.present()).toEqual([
          { actor: alice, label: "aliceAAA", gm: false },
          { actor: bob, label: "bobBBBBB", gm: false },
        ]);
        yield* b.close;
        yield* frameWhere(a, "Bob gone", (f) => !f.includes("bobBBBBB"));
        expect(a.view.present().map((p) => p.actor)).toEqual([alice]);
      }),
    ),
  );

  effect("answers /help to this seat only, and Ctrl-C leaves without writing", () =>
    atTable(
      Effect.gen(function* () {
        const g = yield* seat("gm");
        const b = yield* seat(bob);
        yield* type(g, "/help");
        yield* frameWhere(g, "the help pane", (f) => f.includes("/narrate <text>"));
        // Anything broadcast after the help would reach Bob before the GM's next line does.
        yield* type(b, "Bob");
        yield* type(g, "/narrate after the help");
        const bobs = yield* frameWhere(b, "the GM's next line", (f) =>
          f.includes("after the help"),
        );
        expect(bobs).not.toContain("/narrate <text>");
        b.t.mockInput.pressCtrlC();
        expect(b.left()).toBe(1);
        expect((yield* Effect.flatMap(TableRoom, (r) => r.state.get)).seq).toBe(2);
      }),
    ),
  );

  effect("keeps each feed row's object across unrelated appends, and relabels on a rename", () =>
    atTable(
      Effect.gen(function* () {
        const a = yield* seat(alice);
        yield* type(a, "Alice");
        yield* frameWhere(a, "chat mode", (f) => f.includes("say something, or /help"));
        yield* type(a, "first");
        yield* frameWhere(a, "the first line", (f) => f.includes("Alice: first"));
        const before = a.view.feed();
        yield* type(a, "second");
        yield* frameWhere(a, "the second line", (f) => f.includes("Alice: second"));
        const after = a.view.feed();
        expect(after).toHaveLength(3);
        expect(after[0]).toBe(before[0]!);
        expect(after[1]).toBe(before[1]!);
        yield* type(a, "/name Vex");
        yield* frameWhere(a, "the rename", (f) => f.includes("Vex: first"));
        expect(a.view.feed()[1]).not.toBe(before[1]!);
        expect(a.view.feed()[1]).toMatchObject({ who: "Vex", text: "first" });
      }),
    ),
  );

  effect("refusals show on the seat that sent them", () =>
    atTable(
      Effect.gen(function* () {
        const b = yield* seat(bob);
        yield* type(b, "Bob");
        yield* type(b, "/narrate The sky falls.");
        yield* frameWhere(b, "the refusal", (f) => f.includes("Only the GM can use /narrate."));
        expect(b.view.complete("/ro")).toEqual(["/roll "]);
      }),
    ),
  );

  effect("draws the band from the room: the party, each seat's own hero, then the fight", () =>
    atTable(
      Effect.gen(function* () {
        const g = yield* seat("gm");
        const a = yield* seat(alice);
        expect(g.view.combat?.()).toBeUndefined();
        yield* type(a, "Alice");
        yield* type(g, "/hero brann");
        yield* type(g, "/hero kesh");
        yield* frameWhere(g, "the party", (f) => f.includes("party · hero tokens 0"));
        yield* type(a, "/play brann");
        yield* frameWhere(g, "Brann's player", (f) => f.includes("Brann (Alice)"));
        expect(g.view.combat?.()?.combatants.map((c) => [c.name, c.mine])).toEqual([
          ["Brann (Alice)", false],
          ["Kesh", false],
        ]);
        expect(a.view.combat?.()?.combatants.map((c) => [c.name, c.mine])).toEqual([
          ["Brann", true],
          ["Kesh", false],
        ]);
        expect(g.view.present().map((p) => p.label)).toEqual(["GM", "Alice (Brann)"]);

        yield* type(g, "/add bandit-chief");
        yield* type(g, "/start");
        yield* frameWhere(a, "the fight", (f) => f.includes("round 1"));
        const band = a.view.combat?.();
        expect(band).toMatchObject({ active: true, round: 1 });
        expect(band?.combatants.map((c) => [c.id, c.side, c.stamina, c.max])).toEqual([
          ["brann", "heroes", 24, 24],
          ["kesh", "heroes", 24, 24],
          ["bandit-chief", "director", 80, 80],
        ]);
      }),
    ),
  );

  effect("draws the map from the room, with each seat's own hero and where it can reach", () =>
    atTable(
      Effect.gen(function* () {
        const g = yield* seat("gm");
        const a = yield* seat(alice);
        expect(g.view.map?.()).toBeUndefined();
        yield* type(a, "Alice");
        yield* type(g, "/hero brann");
        yield* type(a, "/play brann");
        yield* type(g, "/map ford-road");
        yield* frameWhere(a, "the map's column letters", (f) => f.includes("The Ford Road"));
        yield* type(a, "/place brann b5");
        yield* frameWhere(g, "Brann's token", () => (g.view.map?.()?.tokens.length ?? 0) > 0);
        const mine = a.view.map?.();
        expect(mine).toMatchObject({ name: "The Ford Road", width: 20, height: 10 });
        expect(mine?.tokens).toEqual([
          {
            id: "brann",
            mark: "B",
            name: "Brann",
            x: 1,
            y: 4,
            side: "heroes",
            mine: true,
            acting: false,
            dead: false,
          },
        ]);
        // Brann's speed is 5: from b5 he reaches a5 to g5 along his row, and no wall square.
        expect(mine?.reachLabel).toBe("Brann can reach: speed 5");
        const reach = new Set(mine?.reach.map((r) => `${r.x},${r.y}`));
        for (const x of [0, 2, 3, 4, 5, 6]) expect(reach.has(`${x},4`)).toBe(true);
        expect(reach.has("7,4")).toBe(false);
        expect(reach.has("1,1")).toBe(false);
        // The GM has no hero, so sees the token but no reach until a creature acts.
        expect(g.view.map?.()?.tokens.map((t) => [t.mark, t.mine])).toEqual([["B", false]]);
        expect(g.view.map?.()?.reach).toEqual([]);
      }),
    ),
  );
});
