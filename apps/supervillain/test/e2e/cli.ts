import { join } from "node:path";
import { Effect } from "effect";

const root = join(import.meta.dir, "../../../..");
const main = join(root, "apps/supervillain/src/main.ts");

/** Runs `supervillain <args>` to completion, from the repo root as `bun supervillain` does, or from `cwd`. */
export const cli = (args: ReadonlyArray<string>, cwd = root) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["bun", main, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  });

export interface Host {
  readonly port: number;
  /** Everything the host has printed so far. */
  readonly output: () => string;
  /** Sends SIGINT and waits for the exit code. */
  readonly stop: () => Promise<number>;
}

/** Starts `supervillain host <args> --port 0` as a child for the life of the scope, from the repo root or `cwd`. */
export const startHost = (args: ReadonlyArray<string>, cwd = root) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const proc = Bun.spawn(["bun", main, "host", ...args, "--port", "0"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      let output = "";
      const decoder = new TextDecoder();
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
      };
      void pump(proc.stdout);
      void pump(proc.stderr);
      const start = Date.now();
      let port: number | undefined;
      while (port === undefined) {
        const found = /ssh -p (\d+) /.exec(output);
        if (found) port = Number(found[1]);
        else if (proc.exitCode !== null || Date.now() - start > 10_000)
          throw new Error(`host did not start:\n${output}`);
        else await Bun.sleep(20);
      }
      const host: Host = {
        port,
        output: () => output,
        stop: async () => {
          proc.kill("SIGINT");
          return proc.exited;
        },
      };
      return { host, proc };
    }),
    ({ proc }) =>
      Effect.promise(async () => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        await proc.exited;
      }),
  ).pipe(Effect.map(({ host }) => host));
