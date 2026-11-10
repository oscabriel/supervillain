import { describe, expect, spyOn } from "bun:test";
import { appendFile, chmod, type FileHandle, open, readFile, writeFile } from "node:fs/promises";
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

/**
 * For the test's scope every file write lands at most `bytes` bytes and says so, as a nearly full
 * disk does. With `full`, the write after a short one fails as the disk runs out.
 */
const diskTakes = (bytes: number, full = false) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const probe = await open(import.meta.path);
      const prototype: FileHandle = Object.getPrototypeOf(probe);
      await probe.close();
      const write: (this: FileHandle, data: Uint8Array) => Promise<unknown> = prototype.write;
      let short = false;
      return spyOn(prototype, "write").mockImplementation(async function (
        this: FileHandle,
        data: Uint8Array,
        offset = 0,
      ) {
        if (full && short) throw new Error("ENOSPC: no space left on device, write");
        const rest = data.subarray(offset);
        short = rest.length > bytes;
        return write.call(this, rest.subarray(0, bytes));
      } as FileHandle["write"]);
    }),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

describe("CampaignLog", () => {
  effect("reads back what it appended, one JSON object per line", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const first = [env(1, "added", { n: 2 }), env(2, "added", { n: 3 })];
      yield* withLog(dir, (log) => log.append(first));
      const reopened = yield* withLog(dir, (log) => Effect.succeed(log.take()));
      expect(reopened).toEqual(first);
      const text = yield* Effect.promise(() => readFile(join(dir, "events.jsonl"), "utf8"));
      expect(text).toBe(first.map((e) => JSON.stringify(e) + "\n").join(""));
    }),
  );

  effect("hands over what it read once, so it doesn't hold the whole log for the host's life", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const first = [env(1, "added", { n: 2 })];
      yield* withLog(dir, (log) => log.append(first));
      const [once, again] = yield* withLog(dir, (log) => Effect.succeed([log.take(), log.take()]));
      expect(once).toEqual(first);
      expect(again).toEqual([]);
    }),
  );

  effect("cuts a half-written last line from the file when it opens", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const one = env(1, "added", { n: 2 });
      yield* writeLog(dir, line(one) + '{"actor":"gm","se');
      const opened = yield* withLog(dir, (log) => Effect.succeed(log.take()));
      expect(opened).toEqual([one]);
      expect(yield* readLog(dir)).toBe(line(one));
    }),
  );

  effect("refuses to open a log with a bad line, and says which line and what's wrong", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* writeLog(
        dir,
        line(env(1, "added", { n: 2 })) + "garbage\n" + line(env(3, "added", { n: 1 })),
      );
      const error = yield* Effect.flip(withLog(dir, () => Effect.void));
      expect(error._tag).toBe("LogError");
      expect(error.message).toContain("events.jsonl:2: expected a valid JSON string");
    }),
  );

  effect("lets one host at a time open a campaign", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const second = yield* withLog(dir, () => Effect.flip(withLog(dir, () => Effect.void)));
      expect(second.message).toContain(`another host (pid ${process.pid})`);
      // A crash can leave a lock whose pid another program has since taken: say how to clear it.
      expect(second.message).toContain(
        `if no host has it open, delete ${join(dir, "events.lock")} and start again`,
      );
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

  effect("leaves a lock another host has taken since when it closes", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const lock = join(dir, "events.lock");
      yield* withLog(dir, () => Effect.promise(() => writeFile(lock, "1234567\n")));
      expect(yield* Effect.promise(() => readFile(lock, "utf8"))).toBe("1234567\n");
    }),
  );

  effect("stops at a lock it can't read, rather than taking it for a stale one", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const lock = join(dir, "events.lock");
      yield* Effect.promise(() => writeFile(lock, "1234567\n"));
      yield* Effect.promise(() => chmod(lock, 0o000));
      const error = yield* Effect.flip(withLog(dir, () => Effect.void));
      expect(error.message).toContain("lock campaign: EACCES");
      yield* Effect.promise(() => chmod(lock, 0o600));
      expect(yield* Effect.promise(() => readFile(lock, "utf8"))).toBe("1234567\n");
    }),
  );

  effect("writes nothing once something else has written the log", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const one = env(1, "added", { n: 1 });
      // A second host that got past the lock.
      const theirs = line(env(2, "added", { n: 5 }));
      const error = yield* withLog(dir, (log) =>
        Effect.gen(function* () {
          yield* log.append([one]);
          yield* Effect.promise(() => appendFile(join(dir, "events.jsonl"), theirs));
          return yield* Effect.flip(log.append([env(2, "added", { n: 2 })]));
        }),
      );
      expect(error.message).toContain("something else wrote");
      expect(error.message).toContain("nothing written");
      expect(yield* readLog(dir)).toBe(line(one) + theirs);
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

  effect("writes all of an append that the disk takes in pieces", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const two = [env(1, "added", { n: 1 }), env(2, "added", { n: 2 })];
      yield* diskTakes(10);
      yield* withLog(dir, (log) => log.append(two));
      expect(yield* readLog(dir)).toBe(two.map(line).join(""));
    }),
  );

  effect("leaves the log as it was when the disk fills part way through an append", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const one = env(1, "added", { n: 1 });
      yield* writeLog(dir, line(one));
      yield* diskTakes(10, true);
      const error = yield* withLog(dir, (log) =>
        Effect.flip(log.append([env(2, "added", { n: 2 })])),
      );
      expect(error.message).toContain("no space left on device");
      expect(yield* readLog(dir)).toBe(line(one));
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
            const opened = log.take();
            expect(opened.length).toBeGreaterThan(0);
            expect(opened.map((e) => e.seq)).toEqual(opened.map((_, i) => i + 1));
            yield* log.append([env(opened.length + 1, "added", { n: 1 })]);
            return opened.length + 1;
          }),
        );
        const reread = yield* withLog(dir, (log) => Effect.succeed(log.take().length));
        expect(reread).toBe(count);
      }),
    10_000,
  );
});
