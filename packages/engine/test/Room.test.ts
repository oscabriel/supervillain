import { describe, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Random } from "effect";
import {
  CampaignLog,
  type Envelope,
  LogError,
  makeRoom,
  type Room,
  type Rules,
} from "../src/index.ts";
import { effect } from "./effect.ts";
import { env, tally, type TallyCommand, type Tally } from "./tally.ts";
import { tempDir } from "./tempDir.ts";

/** Opens a room over the campaign in `dir` for the length of `body`. */
const withRoom = <A, E>(
  dir: string,
  body: (room: Room<Tally, TallyCommand>, log: CampaignLog["Service"]) => Effect.Effect<A, E>,
  rules: Rules<Tally, TallyCommand> = tally,
) =>
  Effect.gen(function* () {
    const room = yield* makeRoom(rules);
    return yield* body(room, yield* CampaignLog);
  }).pipe(Effect.provide(CampaignLog.layer(dir)));

describe("makeRoom", () => {
  effect("writes an accepted command's events with the actor, the next seq and a timestamp", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const written = yield* withRoom(dir, (room) =>
        Effect.gen(function* () {
          const envelopes = yield* room.submit("key:alice", { type: "add", n: 4 });
          expect(yield* room.state.get).toEqual({ total: 4, rolls: [] });
          return envelopes;
        }),
      );
      expect(written).toHaveLength(1);
      const [e] = written;
      expect(e).toMatchObject({ actor: "key:alice", seq: 1, type: "added", payload: { n: 4 } });
      expect(new Date(e!.timestamp).toISOString()).toBe(e!.timestamp);
      expect(yield* withRoom(dir, (_, log) => Effect.succeed(log.envelopes))).toEqual(written);
    }),
  );

  for (const [command, message] of [
    [{ type: "refuse" }, "not today"],
    [{ type: "throw" }, "Rule error, nothing written: decide blew up"],
    [{ type: "poison" }, "Rule error, nothing written: apply blew up"],
  ] as const) {
    effect(`writes nothing and keeps the state when a command ${command.type}s`, () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withRoom(dir, (room) =>
          Effect.gen(function* () {
            yield* room.submit("gm", { type: "add", n: 2 });
            const refusal = yield* Effect.flip(room.submit("gm", command));
            expect(refusal).toMatchObject({ _tag: "Refusal", message });
            expect(yield* room.state.get).toEqual({ total: 2, rolls: [] });
            expect((yield* room.submit("gm", { type: "add", n: 1 }))[0]?.seq).toBe(2);
          }),
        );
        expect(
          yield* withRoom(dir, (_, log) => Effect.succeed(log.envelopes.map((e) => e.seq))),
        ).toEqual([1, 2]);
      }),
    );
  }

  effect("replays the log on reopen without deciding or rolling", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const before = yield* withRoom(dir, (room) =>
        Effect.gen(function* () {
          for (let i = 0; i < 5; i++) yield* room.submit("gm", { type: "roll", sides: 10 });
          return yield* room.state.get;
        }),
      );
      expect(before.rolls).toHaveLength(5);
      const noDecide: Rules<Tally, TallyCommand> = {
        ...tally,
        decide: () => {
          throw new Error("replay called decide");
        },
      };
      expect(yield* withRoom(dir, (room) => room.state.get, noDecide)).toEqual(before);
    }),
  );

  effect("refuses to open over an event its rules can't apply", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const lines = [env(1, "added", { n: 1 }), env(2, "teleported", {})];
      yield* Effect.promise(() =>
        writeFile(join(dir, "events.jsonl"), lines.map((e) => JSON.stringify(e) + "\n").join("")),
      );
      const error = yield* Effect.flip(withRoom(dir, () => Effect.void));
      expect(error).toMatchObject({
        _tag: "LogError",
        message: 'Replay halted at seq 2: unknown event type "teleported"',
      });
    }),
  );

  effect(
    "takes 800 simultaneous rolls from two players in one order, with no seq repeated",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const submits = Array.from({ length: 800 }, (_, i) => ({
          actor: i % 2 ? "key:alice" : "key:bob",
          i,
        }));
        const state = yield* withRoom(dir, (room) =>
          Effect.gen(function* () {
            const results = yield* Effect.forEach(
              submits,
              ({ actor }) => room.submit(actor, { type: "roll", sides: 6 }),
              {
                concurrency: "unbounded",
              },
            );
            expect(results.map((r) => r[0]!.seq).sort((a, b) => a - b)).toEqual(
              submits.map((_, i) => i + 1),
            );
            return yield* room.state.get;
          }),
        );
        const onDisk = yield* withRoom(dir, (_, log) => Effect.succeed(log.envelopes));
        expect(onDisk.map((e) => e.seq)).toEqual(submits.map((_, i) => i + 1));
        expect(onDisk.filter((e) => e.actor === "key:alice")).toHaveLength(400);
        expect(onDisk.map((e) => (e.payload as { value: number }).value)).toEqual([...state.rolls]);
      }).pipe(Random.withSeed("800 rolls")),
    20_000,
  );

  effect("finishes a submit whose caller leaves mid-write, so the state matches the log", () =>
    Effect.gen(function* () {
      const written: Envelope[] = [];
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Like a real append, the bytes land at once and the fsync takes a while.
      const slowLog = CampaignLog.of({
        path: "memory",
        envelopes: [],
        append: (envelopes) =>
          Effect.gen(function* () {
            written.push(...envelopes);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
      });
      const room = yield* makeRoom(tally).pipe(Effect.provideService(CampaignLog, slowLog));

      const submit = yield* Effect.forkChild(room.submit("key:alice", { type: "add", n: 5 }));
      yield* Deferred.await(entered);
      const leave = yield* Effect.forkChild(Fiber.interrupt(submit));
      yield* Effect.sleep("10 millis"); // let the interrupt land while the write is still in flight
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(leave);

      expect(written).toHaveLength(1);
      expect(yield* room.state.get).toEqual({ total: 5, rolls: [] });
    }),
  );

  effect("halts after a failed write and refuses everything after it", () =>
    Effect.gen(function* () {
      let appends = 0;
      const flakyLog = CampaignLog.of({
        path: "memory",
        envelopes: [],
        append: () =>
          ++appends === 1 ? Effect.fail(new LogError({ message: "disk full" })) : Effect.void,
      });
      const room = yield* makeRoom(tally).pipe(Effect.provideService(CampaignLog, flakyLog));
      const first = yield* Effect.flip(room.submit("gm", { type: "add", n: 1 }));
      expect(first.message).toBe("Log write failed, room halted: disk full");
      const second = yield* Effect.flip(room.submit("gm", { type: "add", n: 1 }));
      expect(second.message).toBe("The room is halted: disk full");
      expect(appends).toBe(1);
      expect(yield* room.state.get).toEqual({ total: 0, rolls: [] });
    }),
  );
});
