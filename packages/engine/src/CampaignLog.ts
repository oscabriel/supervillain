import { mkdir, open, readFile, unlink } from "node:fs/promises";
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

/**
 * Creates `events.lock` holding our pid, so one host at a time writes a campaign.
 * A lock whose pid is no longer running is stale and taken over.
 */
async function takeLock(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx");
    await handle.write(`${process.pid}\n`);
    await handle.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (owner > 0 && isRunning(owner))
      throw new Error(
        `another host (pid ${owner}) has this campaign open; if no host has it open, delete ${path} and start again`,
      );
    await unlink(path);
    return takeLock(path);
  }
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
    /** Appends whole lines in one write, then fsyncs. */
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
          () => Effect.promise(() => unlink(lockPath).catch(() => undefined)),
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
            yield* io("append", async () => {
              await handle.write(envelopes.map((e) => JSON.stringify(e) + "\n").join(""));
              await handle.sync();
            });
            last += envelopes.length;
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
