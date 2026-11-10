import { link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import type { Envelope } from "./envelope.ts";
import { parseLog } from "./parseLog.ts";

export class LogError extends Schema.TaggedError<LogError>()("LogError", {
  message: Schema.String,
}) {}

const io = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) =>
      new LogError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` }),
  });

/** A rejection handler that lets one error code through as `false`. */
const unless = (code: string) => (e: unknown) => {
  if ((e as NodeJS.ErrnoException).code !== code) throw e;
  return false;
};

/** The pid in the lock, or NaN when there is no lock. A lock that can't be read is not a missing one. */
const lockOwner = async (path: string) => {
  const text = await readFile(path, "utf8").catch(unless("ENOENT"));
  return typeof text === "string" ? Number(text.trim()) : Number.NaN;
};

/**
 * Creates `events.lock` holding our pid, so one host at a time writes a campaign. The pid is
 * written to a temporary file and linked into place, so no host ever reads a lock without its pid.
 * A lock whose pid is no longer running is stale and taken over. One with our own pid is not: in
 * another pid namespace (a second container on the same folder) a live host can share our pid.
 */
async function takeLock(path: string): Promise<void> {
  const live = (owner: number) => owner > 0 && isRunning(owner);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const aside = `${temporary}.stale`;
  await writeFile(temporary, `${process.pid}\n`);
  try {
    while (!(await link(temporary, path).then(() => true, unless("EEXIST")))) {
      const owner = await lockOwner(path);
      if (live(owner))
        throw new Error(
          `another host (pid ${owner}) has this campaign open; if no host has it open, delete ${path} and start again`,
        );
      // A host that found the same stale lock may have taken the campaign since we read it:
      // move whatever is there aside, and put it back if it is a live lock.
      if (await rename(path, aside).then(() => true, unless("ENOENT"))) {
        if (live(await lockOwner(aside))) await link(aside, path).catch(unless("EEXIST"));
        await unlink(aside);
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Removes the lock only if it is still ours: someone may have deleted it and another host taken it. */
async function releaseLock(path: string): Promise<void> {
  const owner = await lockOwner(path).catch(() => Number.NaN);
  if (owner === process.pid) await unlink(path).catch(() => undefined);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The campaign's `events.jsonl`, open for appending. */
export class CampaignLog extends Context.Service<
  CampaignLog,
  {
    readonly path: string;
    /**
     * The envelopes on disk when the log was opened, handed over once (to the room, to replay):
     * a second call gets none, so the log doesn't hold every event for the host's whole life.
     */
    readonly take: () => ReadonlyArray<Envelope>;
    /**
     * Appends whole lines and fsyncs them, or fails with the file cut back as it was. It writes
     * nothing to a file that isn't the size this host left it: something else wrote the log.
     */
    readonly append: (envelopes: ReadonlyArray<Envelope>) => Effect.Effect<void, LogError>;
  }
>()("@supervillain/engine/CampaignLog") {
  static readonly layer = (campaignDir: string) =>
    Layer.effect(
      CampaignLog,
      Effect.gen(function* () {
        const path = join(campaignDir, "events.jsonl");
        yield* io("create campaign folder", () => mkdir(campaignDir, { recursive: true }));
        const lockPath = join(campaignDir, "events.lock");
        yield* Effect.acquireRelease(
          io("lock campaign", () => takeLock(lockPath)),
          () => Effect.promise(() => releaseLock(lockPath)),
        );
        const handle = yield* Effect.acquireRelease(
          io("open log", () => open(path, "a+")),
          (h) => Effect.promise(() => h.close()),
        );
        const parsed = parseLog(yield* io("read log", () => readFile(path, "utf8")));
        if (parsed.torn !== undefined) {
          yield* io("cut half-written line", () =>
            handle.truncate(Buffer.byteLength(parsed.intact, "utf8")),
          );
          yield* Effect.logWarning(
            `Cut a half-written last line from ${path}: ${JSON.stringify(parsed.torn.slice(0, 80))}`,
          );
        }
        if (parsed.error) {
          return yield* new LogError({
            message: `${path}:${parsed.error.line}: ${parsed.error.message}`,
          });
        }

        let last = parsed.envelopes.length;
        let size = Buffer.byteLength(parsed.intact, "utf8");
        const append = (envelopes: ReadonlyArray<Envelope>) =>
          Effect.gen(function* () {
            for (const [i, e] of envelopes.entries()) {
              if (e.seq !== last + i + 1) {
                return yield* new LogError({
                  message: `append: seq ${e.seq} after seq ${last + i}; nothing written`,
                });
              }
            }
            if (envelopes.length === 0) return;
            // The lock keeps a second host out; this stops one that got in from writing over the first.
            const onDisk = yield* io("append", async () => (await handle.stat()).size);
            if (onDisk !== size) {
              return yield* new LogError({
                message: `append: something else wrote ${path} (${onDisk} bytes, not the ${size} this host left); nothing written`,
              });
            }
            const bytes = Buffer.from(envelopes.map((e) => JSON.stringify(e) + "\n").join(""));
            yield* io("append", async () => {
              try {
                // A nearly full disk takes part of a write and says so without an error.
                for (let written = 0; written < bytes.length;) {
                  const { bytesWritten } = await handle.write(bytes, written);
                  if (bytesWritten === 0) throw new Error("the disk took nothing");
                  written += bytesWritten;
                }
                await handle.sync();
              } catch (e) {
                // Part of a batch on disk would replay as a half-done command, or glue onto the next line.
                await handle.truncate(size).catch(() => undefined);
                throw e;
              }
            });
            last += envelopes.length;
            size += bytes.length;
          });

        let opened: ReadonlyArray<Envelope> = parsed.envelopes;
        const take = () => {
          const taken = opened;
          opened = [];
          return taken;
        };
        return CampaignLog.of({ path, take, append });
      }),
    );
}
