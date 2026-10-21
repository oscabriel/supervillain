import { describe, expect } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { Presence } from "../../src/host/Presence.ts";
import { effect } from "./effect.ts";

const here = Effect.flatMap(Presence, (p) => p.here.get);

/** Seats `actor` in a scope of its own, returning that scope's closer. */
const seat = (actor: string) =>
  Effect.gen(function* () {
    const presence = yield* Presence;
    const scope = yield* Scope.make();
    yield* presence.enter(actor).pipe(Scope.provide(scope));
    return Scope.close(scope, Exit.void);
  });

describe("Presence", () => {
  effect("lists who has a seat open, in arrival order, until each seat's scope closes", () =>
    Effect.gen(function* () {
      expect(yield* here).toEqual([]);
      const leaveAlice = yield* seat("key:alice");
      yield* seat("gm");
      expect(yield* here).toEqual(["key:alice", "gm"]);
      yield* leaveAlice;
      expect(yield* here).toEqual(["gm"]);
    }).pipe(Effect.provide(Presence.layer)),
  );

  effect("lists an actor with two seats once, and keeps them until both close", () =>
    Effect.gen(function* () {
      const first = yield* seat("key:alice");
      const second = yield* seat("key:alice");
      expect(yield* here).toEqual(["key:alice"]);
      yield* first;
      expect(yield* here).toEqual(["key:alice"]);
      yield* second;
      expect(yield* here).toEqual([]);
    }).pipe(Effect.provide(Presence.layer)),
  );
});
