import { describe, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { writeGeneratedMap } from "../../src/content/newMap.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const NEW_MAP = join(import.meta.dir, "../../src/content/newMap.ts");

/** Writes keep-7 into the campaign at $DIR and prints why it couldn't. */
const WRITE = `
import { Effect } from "effect";
import { writeGeneratedMap } from ${JSON.stringify(NEW_MAP)};
const failure = await Effect.runPromise(Effect.flip(writeGeneratedMap(process.env.DIR, "keep", 7)));
console.log(failure.reason);
`;

/**
 * Runs `code` in a bun that may create files but write nothing into them, as on a full disk: the
 * file size limit is 0 and its signal ignored, so every write to a file fails with an error.
 */
const whereNoFileGrows = (code: string, dir: string) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(
      ["sh", "-c", `trap '' XFSZ; ulimit -f 0; exec "$0" -e "$1"`, process.execPath, code],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env, DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { out: out.trim(), err };
  });

describe("writing a generated map", () => {
  effect("a write that fails leaves no file holding the map's id", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const { out, err } = yield* whereNoFileGrows(WRITE, dir);
      expect(err).toBe("");
      expect(out).toBe("write");
      expect(yield* Effect.promise(() => readdir(join(dir, "maps")))).toEqual([]);
      // So the same seed can be written once there's room.
      expect((yield* writeGeneratedMap(dir, "keep", 7)).file).toBe("maps/keep-7.txt");
    }),
  );
});
