import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const alice = "key:SHA256:aliceAAAAkey";
const bob = "key:SHA256:bobBBBBBkey";

const withTable = <A, E>(dir: string, body: (room: TableRoom["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(TableRoom, body).pipe(Effect.provide(TableRoom.layer(dir)));

const logLines = (dir: string) =>
  Effect.promise(async () =>
    (await readFile(join(dir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l)),
  );

describe("TableRoom", () => {
  effect("writes accepted commands to the campaign log and folds them into the state", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withTable(dir, (room) =>
        Effect.gen(function* () {
          yield* room.submit(alice, { type: "name", name: "Vex" });
          const [rolled] = yield* room.submit(alice, { type: "roll", notation: "2d6" });
          const payload = rolled!.payload as { rolls: number[]; total: number };
          expect(payload.rolls).toHaveLength(2);
          for (const face of payload.rolls) expect(face).toBeWithin(1, 7);
          const state = yield* room.state.get;
          expect(state.core.names).toEqual({ [alice]: "Vex" });
          expect(state.feed.map((f) => f.kind)).toEqual(["name", "roll"]);
        }),
      );
      const lines = yield* logLines(dir);
      expect(lines.map((l) => [l.seq, l.actor, l.type])).toEqual([
        [1, alice, "core.name-set"],
        [2, alice, "core.dice-rolled"],
      ]);
    }),
  );

  effect("refuses what the rules refuse, and writes nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const refusal = yield* withTable(dir, (room) =>
        Effect.flip(room.submit(alice, { type: "narrate", text: "It rains." })),
      );
      expect(refusal.message).toBe("Only the GM can use /narrate.");
      expect(yield* logLines(dir)).toEqual([]);
    }),
  );

  effect("replays the campaign when reopened, and remembers the last few envelopes", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withTable(dir, (room) =>
        Effect.gen(function* () {
          for (const text of ["one", "two", "three"])
            yield* room.submit("gm", { type: "say", text });
        }),
      );
      yield* withTable(dir, (room) =>
        Effect.gen(function* () {
          expect((yield* room.state.get).feed.map((f) => f.text)).toEqual(["one", "two", "three"]);
          expect((yield* room.recent.get).map((e) => e.seq)).toEqual([1, 2, 3]);
          yield* room.submit("gm", { type: "say", text: "four" });
          expect((yield* room.recent.get).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
        }),
      );
    }),
  );

  effect(
    "a player sending faster than a few lines a second is refused; others and the GM aren't",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withTable(dir, (room) =>
          Effect.gen(function* () {
            const say = (actor: string) => room.submit(actor, { type: "say", text: "spam" });
            for (let i = 0; i < 10; i++) yield* say(alice);
            expect((yield* Effect.flip(say(alice))).message).toBe(
              "You're sending lines too fast; wait a moment.",
            );
            yield* say(bob);
            for (let i = 0; i < 20; i++) yield* say("gm");
            // Two lines a second come back.
            yield* Effect.sleep("600 millis");
            yield* say(alice);
          }),
        );
        expect((yield* logLines(dir)).filter((l) => l.actor === alice)).toHaveLength(11);
      }),
  );
});
