import { describe, expect } from "bun:test";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Random, type Scope } from "effect";
import { generateMap, mapFileText } from "../../src/content/mapgen.ts";
import { writeGeneratedMap } from "../../src/content/newMap.ts";
import { plainText, readMapText } from "../../src/game/index.ts";
import { type Reply, runLine } from "../../src/host/line.ts";
import { openSeat } from "../../src/host/Seat.ts";
import { type TableServices, tableServices } from "../../src/host/services.ts";
import { SetWorld } from "../../src/host/SetWorld.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import type { TableView } from "../../src/table/view.ts";
import { sampleCampaign } from "./campaign.ts";
import { effect, waitFor } from "./effect.ts";

const alice = "key:SHA256:aliceAAAAkeyfingerprint";

/** set.world mustn't be asked anything here. */
const noSetWorld = Layer.succeed(
  SetWorld,
  SetWorld.of({ roll: (seed) => Effect.die(new Error(`fetched seed ${seed}`)) }),
);

const atTable = <A, E>(dir: string, body: Effect.Effect<A, E, TableServices | Scope.Scope>) =>
  Effect.scoped(body.pipe(Effect.provide(tableServices(dir, { setWorld: noSetWorld }))));

const said = (reply: Reply): ReadonlyArray<string> | string =>
  reply.kind === "done" ? reply.lines.map(plainText) : reply.kind === "empty" ? "" : reply.text;

const stateNow = Effect.flatMap(TableRoom, (r) => r.state.get);

/** The prep panel's sections as titles and items, once the seat has read the files. */
const listed = (view: TableView) =>
  view.prep
    ?.view()
    ?.sections.map((s) => [
      s.title,
      s.items.map((i) => `${i.label} ${i.line}${i.note ? ` (${i.note})` : ""}`),
    ]);

const mapFiles = (dir: string) =>
  Effect.promise(async () => (await readdir(join(dir, "maps"))).toSorted());

describe("the prep panel's lists, from the campaign", () => {
  effect("the GM's seat lists the sample's files with their names; a player's seat has none", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      yield* atTable(
        dir,
        Effect.gen(function* () {
          const gm = yield* openSeat({ actor: "gm", room: "den", leave: () => undefined });
          const player = yield* openSeat({ actor: alice, room: "den", leave: () => undefined });
          expect(player.prep).toBeUndefined();
          // Nothing is read until the panel opens.
          expect(gm.prep?.view()).toBeUndefined();
          expect(yield* Effect.promise(() => gm.prep!.reload())).toBeUndefined();
          expect(listed(gm)).toEqual([
            [
              "Heroes",
              ["Brann /hero brann", "Ilsa /hero ilsa", "Kesh /hero kesh", "Wren /hero wren"],
            ],
            [
              "Monsters",
              [
                "Bandit Bruiser /add bandit-bruiser",
                "Bandit Chief /add bandit-chief",
                "Bandit Cutpurse /add bandit-cutpurse",
                "Bandit Slinger /add bandit-slinger",
              ],
            ],
            [
              "Maps",
              [
                "The Ford Road /map ford-road",
                "New crossing /map new crossing",
                "New keep /map new keep",
                "New, by seed /map new ",
              ],
            ],
            ["Place", []],
            ["Start", ["Start combat /start"]],
          ]);
          // What the table holds shows as it changes.
          yield* runLine("gm", "/hero brann");
          yield* runLine("gm", "/map ford");
          yield* runLine("gm", "/add bandit-chief");
          // The seat follows the room a moment behind: wait for the last of the three.
          yield* waitFor("the panel to follow the table", () =>
            JSON.stringify(listed(gm)).includes("Bandit Chief /add bandit-chief (1 in play)"),
          );
          expect(listed(gm)![0]![1]).toContain("Brann /hero brann (in play)");
          const now = listed(gm)!;
          expect(now[1]![1]).toContain("Bandit Chief /add bandit-chief (1 in play)");
          expect(now[2]![1]).toContain("The Ford Road /map ford-road (loaded)");
          expect(now[3]).toEqual([
            "Place",
            ["Brann /place brann", "Bandit Chief /place bandit-chief"],
          ]);
        }),
      );
    }),
  );

  effect(
    "files are read again each time the panel opens: a new sheet shows, a broken one by its id",
    () =>
      Effect.gen(function* () {
        const dir = yield* sampleCampaign;
        yield* atTable(
          dir,
          Effect.gen(function* () {
            const gm = yield* openSeat({ actor: "gm", room: "den", leave: () => undefined });
            yield* Effect.promise(() => gm.prep!.reload());
            yield* Effect.promise(async () => {
              const brann = await readFile(join(dir, "heroes/brann.yaml"), "utf8");
              await writeFile(
                join(dir, "heroes/tor.yaml"),
                brann.replace(/^name: Brann$/m, "name: Tor"),
              );
              await writeFile(join(dir, "heroes/broken.yaml"), "name: [unclosed\n");
            });
            expect(listed(gm)![0]![1]).not.toContain("Tor /hero tor");
            yield* Effect.promise(() => gm.prep!.reload());
            expect(listed(gm)![0]![1]).toEqual([
              "Brann /hero brann",
              "broken /hero broken",
              "Ilsa /hero ilsa",
              "Kesh /hero kesh",
              "Tor /hero tor",
              "Wren /hero wren",
            ]);
          }),
        );
      }),
  );

  effect("a set.world campaign: Recruit and Foe, maps, who to place, Start", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      yield* Effect.promise(() => writeFile(join(dir, "campaign.yaml"), "rules: set-world\n"));
      yield* atTable(
        dir,
        Effect.gen(function* () {
          const gm = yield* openSeat({ actor: "gm", room: "den", leave: () => undefined });
          yield* Effect.promise(() => gm.prep!.reload());
          expect(listed(gm)).toEqual([
            ["Fighters", ["Recruit /recruit ", "Foe /foe "]],
            [
              "Maps",
              [
                "The Ford Road /map ford-road",
                "New crossing /map new crossing",
                "New keep /map new keep",
                "New, by seed /map new ",
              ],
            ],
            ["Place", []],
            ["Start", ["Start the fight /start"]],
          ]);
        }),
      );
    }),
  );
});

describe("/map new: a generated map, written into maps/ and loaded", () => {
  effect(
    "by its seed: the file is the CLI's, the event carries the grid, replay reads no file",
    () =>
      Effect.gen(function* () {
        const dir = yield* sampleCampaign;
        const text = mapFileText(generateMap("keep", 42));
        const grid = readMapText("keep-42", text);
        if ("refusal" in grid) throw new Error(grid.refusal);
        yield* atTable(
          dir,
          Effect.gen(function* () {
            expect(said(yield* runLine("gm", "/map new keep 42"))).toEqual([
              `The map is ${grid.name}, 24 by 14.`,
            ]);
            const map = (yield* stateNow).ds.map;
            expect(map).toMatchObject({ id: "keep-42", name: grid.name, terrain: grid.terrain });
            expect(map?.dressing).toEqual(grid.dressing);
            // The same seed again: the map is there already, and the GM is told how to load it.
            expect(said(yield* runLine("gm", "/map new keep 42"))).toBe(
              "There's already a map called keep-42 in maps/: /map keep-42 loads it.",
            );
            // A player can't write a map file.
            expect(said(yield* runLine(alice, "/map new crossing 9"))).toBe(
              "Only the GM can use /map.",
            );
          }),
        );
        expect(yield* mapFiles(dir)).toEqual(["ford-road.txt", "keep-42.txt"]);
        // The text `supervillain map keep <dir> --seed 42` writes too (e2e/campaign.test.ts).
        expect(yield* Effect.promise(() => readFile(join(dir, "maps/keep-42.txt"), "utf8"))).toBe(
          text,
        );
        const log = yield* Effect.promise(() => readFile(join(dir, "events.jsonl"), "utf8"));
        expect(JSON.parse(log.trim().split("\n").at(-1)!)).toMatchObject({
          type: "ds.map-loaded",
          payload: { id: "keep-42", terrain: grid.terrain },
        });
        // Replay never generates or reads a map: with maps/ gone, the room opens on the same grid.
        yield* Effect.promise(() => rm(join(dir, "maps"), { recursive: true }));
        yield* atTable(
          dir,
          Effect.gen(function* () {
            expect((yield* stateNow).ds.map).toMatchObject({
              id: "keep-42",
              terrain: grid.terrain,
            });
          }),
        );
      }),
  );

  effect("without a seed the host picks one, and the map's id says which", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      yield* atTable(
        dir,
        Effect.gen(function* () {
          const reply = yield* runLine("gm", "/map new crossing").pipe(
            Random.withSeed("supervillain"),
          );
          expect(reply.kind).toBe("done");
          const id = (yield* stateNow).ds.map?.id ?? "";
          expect(id).toMatch(/^crossing-\d+$/);
          const seed = Number(id.slice("crossing-".length));
          const grid = readMapText(id, mapFileText(generateMap("crossing", seed)));
          expect((yield* stateNow).ds.map?.terrain).toEqual("refusal" in grid ? [] : grid.terrain);
        }),
      );
      expect((yield* mapFiles(dir)).filter((f) => f.startsWith("crossing-"))).toHaveLength(1);
    }),
  );

  effect("a set.world table generates its map the same way", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      yield* Effect.promise(() => writeFile(join(dir, "campaign.yaml"), "rules: set-world\n"));
      yield* atTable(
        dir,
        Effect.gen(function* () {
          expect(said(yield* runLine("gm", "/map new crossing 7"))).toEqual([
            expect.stringMatching(/^The map is .+, 24 by 14\.$/),
          ]);
          expect((yield* stateNow).sw.map?.id).toBe("crossing-7");
        }),
      );
      expect(yield* mapFiles(dir)).toContain("crossing-7.txt");
    }),
  );

  effect("a file that would load by the same id, in other letters, is never written beside", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      yield* Effect.promise(() =>
        copyFile(join(dir, "maps/ford-road.txt"), join(dir, "maps/Keep-42.txt")),
      );
      yield* atTable(
        dir,
        Effect.gen(function* () {
          expect(said(yield* runLine("gm", "/map new keep 42"))).toBe(
            "There's already a map called keep-42 in maps/: /map keep-42 loads it.",
          );
          expect((yield* stateNow).ds.map).toBeUndefined();
        }),
      );
      expect(yield* mapFiles(dir)).toEqual(["Keep-42.txt", "ford-road.txt"]);
    }),
  );

  effect("the writer takes no seed /map new wouldn't, and no id /map reads as a word", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      for (const seed of [-1, 4294967296, 1.5])
        expect((yield* Effect.flip(writeGeneratedMap(dir, "keep", seed))).reason).toBe("bad-seed");
      for (const id of ["new", "OFF"])
        expect((yield* Effect.flip(writeGeneratedMap(dir, "keep", 1, id))).reason).toBe("bad-id");
      expect(yield* mapFiles(dir)).toEqual(["ford-road.txt"]);
    }),
  );

  effect("the GM's panel lists a map /map new just wrote, loaded, without being reopened", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      yield* atTable(
        dir,
        Effect.gen(function* () {
          const gm = yield* openSeat({ actor: "gm", room: "den", leave: () => undefined });
          yield* Effect.promise(() => gm.prep!.reload());
          yield* runLine("gm", "/map new keep 42");
          yield* waitFor("the panel to read maps/ again", () =>
            JSON.stringify(listed(gm)).includes("/map keep-42 (loaded)"),
          );
        }),
      );
    }),
  );
});

describe("the prep panel's maps", () => {
  effect("not one /map reads as a word, nor one too big to load, which is listed unread", () =>
    Effect.gen(function* () {
      const dir = yield* sampleCampaign;
      yield* Effect.promise(async () => {
        const ford = await readFile(join(dir, "maps/ford-road.txt"));
        await writeFile(join(dir, "maps/new.txt"), ford);
        await writeFile(join(dir, "maps/off.txt"), ford);
        await writeFile(join(dir, "maps/huge.txt"), `name: Huge\n${".".repeat(64 * 1024)}\n`);
      });
      yield* atTable(
        dir,
        Effect.gen(function* () {
          const gm = yield* openSeat({ actor: "gm", room: "den", leave: () => undefined });
          yield* Effect.promise(() => gm.prep!.reload());
          expect(listed(gm)![2]).toEqual([
            "Maps",
            [
              "The Ford Road /map ford-road",
              "huge /map huge",
              "New crossing /map new crossing",
              "New keep /map new keep",
              "New, by seed /map new ",
            ],
          ]);
        }),
      );
    }),
  );
});
