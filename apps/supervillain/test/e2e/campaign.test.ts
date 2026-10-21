import { describe, expect } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { SAMPLE } from "../host/campaign.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { cli } from "./cli.ts";

const BESTIARY = join(import.meta.dir, "../content/fixtures/bestiary");

const list = (dir: string) => Effect.promise(async () => (await readdir(dir)).toSorted());

describe("supervillain new", () => {
  effect("makes a campaign folder its owner alone can read, with heroes/ and monsters/", () =>
    Effect.gen(function* () {
      const dir = join(yield* tempDir, "den");
      const made = yield* cli(["new", dir]);
      expect(made).toMatchObject({ exitCode: 0, stderr: "" });
      expect(made.stdout).toStartWith(`supervillain: made ${dir} with heroes/ and monsters/\n`);
      expect(yield* list(dir)).toEqual(["README.md", "heroes", "monsters"]);
      expect(yield* list(join(dir, "heroes"))).toEqual([]);
      expect((yield* Effect.promise(() => stat(dir))).mode & 0o777).toBe(0o700);
      expect(yield* Effect.promise(() => readFile(join(dir, "README.md"), "utf8"))).toContain(
        "heroes/<id>.yaml",
      );
    }),
  );

  effect("copies the sample campaign with --example", () =>
    Effect.gen(function* () {
      const dir = join(yield* tempDir, "ford");
      expect((yield* cli(["new", dir, "--example"])).exitCode).toBe(0);
      expect(yield* list(join(dir, "heroes"))).toEqual(yield* list(join(SAMPLE, "heroes")));
      expect(yield* list(join(dir, "monsters"))).toEqual(yield* list(join(SAMPLE, "monsters")));
    }),
  );

  effect("refuses a folder that already has files, in one plain line", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      yield* Effect.promise(() => writeFile(join(dir, "events.jsonl"), ""));
      const result = yield* cli(["new", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `supervillain: can't make a campaign in ${dir}: it already has files in it\n`,
      );
      expect(yield* list(dir)).toEqual(["events.jsonl"]);
    }),
  );
});

describe("supervillain import", () => {
  effect("writes the named creatures into the campaign's monsters/ and reports each", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const result = yield* cli(["import", BESTIARY, "--into", dir, "Gutter Rat"]);
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "wrote monsters/gutter-rat.yaml (Gutter Rat)\n",
        stderr: "",
      });
      expect(yield* list(join(dir, "monsters"))).toEqual(["gutter-rat.yaml"]);
      // Run again, the file is kept: --overwrite replaces it.
      expect((yield* cli(["import", BESTIARY, "--into", dir, "gutter"])).stdout).toBe(
        "kept monsters/gutter-rat.yaml (Gutter Rat): it exists; --overwrite replaces it\n",
      );
    }),
  );

  effect("a creature it can't find or read fails the import, naming why", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const result = yield* cli(["import", BESTIARY, "--into", dir, "nobody"]);
      expect(result).toMatchObject({
        exitCode: 1,
        stdout: 'no monster named "nobody"\n',
        stderr: "supervillain: one creature not imported\n",
      });
      const missing = yield* cli(["import", join(dir, "nope"), "--into", dir]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toStartWith(`supervillain: can't read ${join(dir, "nope")}: `);
    }),
  );
});
