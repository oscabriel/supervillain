import { describe, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { CampaignLog } from "../src/index.ts";
import { effect } from "./effect.ts";
import { env } from "./tally.ts";
import { tempDir } from "./tempDir.ts";

/** Opens the campaign in `dir` for the length of `body`, then closes it. */
const line = (e: ReturnType<typeof env>) => JSON.stringify(e) + "\n";
const readLog = (dir: string) => Effect.promise(() => readFile(join(dir, "events.jsonl"), "utf8"));
const writeLog = (dir: string, text: string) =>
  Effect.promise(() => writeFile(join(dir, "events.jsonl"), text));

const withLog = <A, E>(dir: string, body: (log: CampaignLog["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* body(yield* CampaignLog);
  }).pipe(Effect.provide(CampaignLog.layer(dir)));

describe("CampaignLog", () => {
  effect("reads back what it appended, one JSON object per line", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const first = [env(1, "added", { n: 2 }), env(2, "added", { n: 3 })];
      yield* withLog(dir, (log) => log.append(first));
      const reopened = yield* withLog(dir, (log) => Effect.succeed(log.envelopes));
      expect(reopened).toEqual(first);
      const text = yield* Effect.promise(() => readFile(join(dir, "events.jsonl"), "utf8"));
      expect(text).toBe(first.map((e) => JSON.stringify(e) + "\n").join(""));
    }),
  );

  effect("cuts a half-written last line from the file when it opens", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const one = env(1, "added", { n: 2 });
      yield* writeLog(dir, line(one) + '{"actor":"gm","se');
      const opened = yield* withLog(dir, (log) => Effect.succeed(log.envelopes));
      expect(opened).toEqual([one]);
      expect(yield* readLog(dir)).toBe(line(one));
    }),
  );

  effect("refuses to open a log with a bad line, and names the line", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* writeLog(
        dir,
        line(env(1, "added", { n: 2 })) + "garbage\n" + line(env(3, "added", { n: 1 })),
      );
      const error = yield* Effect.flip(withLog(dir, () => Effect.void));
      expect(error._tag).toBe("LogError");
      expect(error.message).toContain("events.jsonl:2:");
    }),
  );

  effect("lets one host at a time open a campaign", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const second = yield* withLog(dir, () => Effect.flip(withLog(dir, () => Effect.void)));
      expect(second.message).toContain(`another host (pid ${process.pid})`);
      yield* withLog(dir, () => Effect.void);
    }),
  );

  effect("takes over a lock whose host is gone", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const gone = Bun.spawn(["true"]);
      yield* Effect.promise(() => gone.exited);
      yield* Effect.promise(() => writeFile(join(dir, "events.lock"), `${gone.pid}\n`));
      yield* withLog(dir, (log) => log.append([env(1, "added", { n: 1 })]));
      expect(yield* readLog(dir)).toBe(line(env(1, "added", { n: 1 })));
    }),
  );

  effect("refuses an append whose seq doesn't follow the last line, and writes nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const error = yield* withLog(dir, (log) =>
        log
          .append([env(1, "added", { n: 1 })])
          .pipe(Effect.andThen(Effect.flip(log.append([env(3, "added", { n: 1 })])))),
      );
      expect(error.message).toContain("seq 3 after seq 1");
      expect(yield* readLog(dir)).toBe(line(env(1, "added", { n: 1 })));
    }),
  );

  effect(
    "reopens cleanly after its host is killed mid-append",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const host = Bun.spawn(
          [process.execPath, join(import.meta.dir, "fixtures/appender.ts"), dir],
          { stdout: "pipe" },
        );
        const reader = host.stdout.getReader();
        yield* Effect.promise(() => reader.read());
        yield* Effect.sleep("150 millis");
        host.kill("SIGKILL");
        yield* Effect.promise(() => host.exited);

        const count = yield* withLog(dir, (log) =>
          Effect.gen(function* () {
            expect(log.envelopes.length).toBeGreaterThan(0);
            expect(log.envelopes.map((e) => e.seq)).toEqual(log.envelopes.map((_, i) => i + 1));
            yield* log.append([env(log.envelopes.length + 1, "added", { n: 1 })]);
            return log.envelopes.length + 1;
          }),
        );
        const reread = yield* withLog(dir, (log) => Effect.succeed(log.envelopes.length));
        expect(reread).toBe(count);
      }),
    10_000,
  );
});
