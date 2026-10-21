import { describe, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { cli } from "./cli.ts";

const vex = "key:SHA256:vexVEXvexVEXvexVEXvexVEXvexVEXvexVEXvexVEXvex";
const guest = "guest:7f3aQ2xYzW9vLm0pNs1tRk";
const at = (seq: number) => `2026-10-20T19:0${seq}:00.000Z`;
const line = (seq: number, actor: string, type: string, payload: unknown) =>
  JSON.stringify({ actor, seq, timestamp: at(seq), type, payload });

const KNOWN_LOG = [
  line(1, "gm", "core.chat-posted", { text: "Welcome to the den." }),
  line(2, vex, "core.name-set", { name: "Vex" }),
  line(3, vex, "core.dice-rolled", { notation: "2d10+2", rolls: [4, 9], modifier: 2, total: 15 }),
  line(4, "gm", "ds.combat-started", { round: 1 }),
  line(5, guest, "core.chat-posted", { text: "waves", style: "emote" }),
  "",
].join("\n");

describe("supervillain check", () => {
  effect(
    "prints the summary, the feed and the final state, and names what it skipped",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const path = join(dir, "events.jsonl");
        yield* Effect.promise(() => writeFile(path, KNOWN_LOG));
        const result = yield* cli(["check", dir]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('seq 4: skipped unknown event type "ds.combat-started"\n');
        const [summary, state] = result.stdout.split("\nstate:\n");
        expect(summary).toBe(
          [
            `${path}: 5 events, through seq 5, 1 skipped`,
            "events: core.chat-posted ×2, core.name-set ×1, core.dice-rolled ×1",
            `actors: GM (gm), Vex (${vex}), guest-7f3a (${guest})`,
            "",
            "feed:",
            "     1  GM: Welcome to the den.",
            "     2  vexVEXve is now Vex",
            "     3  Vex rolled 2d10+2: [4, 9] +2 = 15",
            "     5  guest-7f3a waves",
            "",
          ].join("\n"),
        );
        expect(JSON.parse(state!)).toEqual({
          seq: 5,
          actors: ["gm", vex, guest],
          feed: "[4 lines]",
          core: { names: { [vex]: "Vex" } },
        });
      }),
    15_000,
  );

  effect(
    "stops at an event it can't apply, says where, and exits 1",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const bad = line(2, vex, "core.dice-rolled", {
          notation: "d6",
          rolls: [9],
          modifier: 0,
          total: 9,
        });
        yield* Effect.promise(() =>
          writeFile(join(dir, "events.jsonl"), `${KNOWN_LOG.split("\n")[0]}\n${bad}\n`),
        );
        const result = yield* cli(["check", dir]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("     1  GM: Welcome to the den.");
        expect(result.stderr).toContain("stopped at seq 2: the roll at seq 2 doesn't add up");
      }),
    15_000,
  );

  effect(
    "a folder with no log says so and exits 1",
    () =>
      Effect.gen(function* () {
        const result = yield* cli(["check", join(yield* tempDir, "nowhere")]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("events.jsonl");
      }),
    15_000,
  );
});
