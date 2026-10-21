import { mkdir, open, readFile, truncate, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { Context, Data, Effect, Layer } from "effect"
import { type Envelope, parseLog } from "../game/events.ts"

export class LogError extends Data.TaggedError("LogError")<{ message: string; line?: number }> {}

const io = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new LogError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` }),
  })

// One host per campaign folder: events.lock holds the owner's pid. A lock whose pid is gone is stale.
async function takeLock(path: string): Promise<FileHandle> {
  try {
    const handle = await open(path, "wx")
    await handle.write(`${process.pid}\n`)
    return handle
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
    const pid = Number((await readFile(path, "utf8").catch(() => "")).trim())
    if (pid > 0 && isAlive(pid)) throw new Error(`another host (pid ${pid}) has this campaign open: ${path}`)
    await unlink(path)
    return takeLock(path)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

export class CampaignLog extends Context.Service<
  CampaignLog,
  {
    readonly path: string
    readonly replay: Effect.Effect<Envelope[], LogError>
    readonly append: (envs: Envelope[]) => Effect.Effect<void, LogError>
  }
>()("spike-d/host/CampaignLog") {
  static readonly layer = (campaignDir: string) =>
    Layer.effect(
      CampaignLog,
      Effect.gen(function* () {
        const path = join(campaignDir, "events.jsonl")
        const lockPath = join(campaignDir, "events.lock")
        yield* io("create campaign dir", () => mkdir(campaignDir, { recursive: true }))
        yield* Effect.acquireRelease(io("lock campaign", () => takeLock(lockPath)), (h) =>
          Effect.promise(() => h.close().then(() => unlink(lockPath)).catch(() => undefined)),
        )
        const handle: FileHandle = yield* Effect.acquireRelease(
          io("open log", () => open(path, "a")),
          (h) => Effect.promise(() => h.close()),
        )

        const replay = Effect.gen(function* () {
          const parsed = parseLog(yield* io("read log", () => readFile(path, "utf8")))
          if (parsed.torn !== undefined) {
            yield* io("truncate torn line", () => truncate(path, Buffer.byteLength(parsed.intact, "utf8")))
            yield* Effect.logWarning(`Cut a half-written last line from ${path}: ${JSON.stringify(parsed.torn.slice(0, 80))}`)
          }
          if (parsed.error) {
            const { line, message } = parsed.error
            return yield* new LogError({ message: `${path}:${line}: ${message}`, line })
          }
          return parsed.envelopes
        })

        const append = (envs: Envelope[]) =>
          envs.length === 0
            ? Effect.void
            : io("append", async () => {
                await handle.write(envs.map((e) => JSON.stringify(e) + "\n").join(""))
                await handle.sync()
              })

        return CampaignLog.of({ path, replay, append })
      }),
    )
}
