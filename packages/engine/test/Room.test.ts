import { describe, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Random } from "effect";
import { TestClock } from "effect/testing";
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

/** What the campaign in `dir` holds on disk, read by opening its log alone. */
const onDisk = (dir: string) =>
  Effect.gen(function* () {
    return (yield* CampaignLog).take();
  }).pipe(Effect.provide(CampaignLog.layer(dir)));

describe("makeRoom", () => {
  effect("keeps only the last few envelopes it replayed, when asked for them", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* withRoom(dir, (room) =>
        Effect.gen(function* () {
          for (const n of [1, 2, 3]) yield* room.submit("gm", { type: "add", n });
        }),
      );
      const recent = yield* Effect.map(makeRoom(tally, { recent: 2 }), (room) =>
        room.recent.map((e) => e.seq),
      ).pipe(Effect.provide(CampaignLog.layer(dir)));
      expect(recent).toEqual([2, 3]);
      expect(
        yield* Effect.map(makeRoom(tally), (room) => room.recent).pipe(
          Effect.provide(CampaignLog.layer(dir)),
        ),
      ).toEqual([]);
    }),
  );

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
      expect(yield* onDisk(dir)).toEqual(written);
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
        expect(yield* Effect.map(onDisk(dir), (es) => es.map((e) => e.seq))).toEqual([1, 2]);
      }),
    );
  }

  effect("stamps each submission later than the one before, even when the clock stands still", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      // A log whose last event is a little ahead of the clock, as after a clock step back.
      yield* Effect.promise(() =>
        writeFile(
          join(dir, "events.jsonl"),
          JSON.stringify({ ...env(1, "added", { n: 1 }), timestamp: "1970-01-01T00:00:05.000Z" }) +
            "\n",
        ),
      );
      const written = yield* withRoom(dir, (room) =>
        Effect.gen(function* () {
          const a = yield* room.submit("gm", { type: "add", n: 1 });
          const b = yield* room.submit("gm", { type: "add", n: 1 });
          yield* TestClock.adjust("10 seconds");
          const c = yield* room.submit("gm", { type: "add", n: 1 });
          return [...a, ...b, ...c].map((e) => e.timestamp);
        }),
      ).pipe(Effect.provide(TestClock.layer()));
      // The test clock reads the epoch: one millisecond after the log's last, then one more,
      // then the clock again once it has passed them.
      expect(written).toEqual([
        "1970-01-01T00:00:05.001Z",
        "1970-01-01T00:00:05.002Z",
        "1970-01-01T00:00:10.000Z",
      ]);
    }),
  );

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
        const written = yield* onDisk(dir);
        expect(written.map((e) => e.seq)).toEqual(submits.map((_, i) => i + 1));
        expect(written.filter((e) => e.actor === "key:alice")).toHaveLength(400);
        expect(written.map((e) => (e.payload as { value: number }).value)).toEqual([
          ...state.rolls,
        ]);
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
        take: () => [],
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
        take: () => [],
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
