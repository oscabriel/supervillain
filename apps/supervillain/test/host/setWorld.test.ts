import { describe, expect } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit, Layer, Random, type Scope } from "effect";
import { CampaignContent } from "../../src/content/index.ts";
import { plainText } from "../../src/game/index.ts";
import { type Reply, runLine } from "../../src/host/line.ts";
import { type TableServices, tableServices } from "../../src/host/services.ts";
import { decodeRoll, SetWorld } from "../../src/host/SetWorld.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { FIXTURES, recordedAnswer } from "../setWorld/harness.ts";
import { SAMPLE } from "./campaign.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const alice = "key:SHA256:aliceALICEaliceKEY";

/** A campaign folder whose campaign.yaml says `text` (none when undefined), with the ford's map. */
const campaign = (text: string | undefined) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    yield* Effect.promise(async () => {
      if (text !== undefined) await writeFile(join(dir, "campaign.yaml"), text);
      await mkdir(join(dir, "maps"));
      await copyFile(join(SAMPLE, "maps/ford-road.txt"), join(dir, "maps/ford-road.txt"));
    });
    return dir;
  });

/** set.world from the recorded answers, counting the seeds it was asked for. */
const recordedSetWorld = () => {
  const asked: number[] = [];
  const layer = SetWorld.answering((seed) => {
    asked.push(seed);
    return recordedAnswer(seed);
  });
  return { asked, layer };
};

/** A set.world that must not be asked: replay never fetches. */
const unreachable = Layer.succeed(
  SetWorld,
  SetWorld.of({ roll: (seed) => Effect.die(new Error(`fetched seed ${seed}`)) }),
);

const atTable = <A, E>(
  dir: string,
  setWorld: Layer.Layer<SetWorld>,
  body: Effect.Effect<A, E, TableServices | Scope.Scope>,
) => body.pipe(Effect.provide(tableServices(dir, { setWorld })));

const said = (reply: Reply): ReadonlyArray<string> | string =>
  reply.kind === "done" ? reply.lines.map(plainText) : reply.kind === "empty" ? "" : reply.text;

const rulesetOf = (dir: string) =>
  Effect.map(CampaignContent, (c) => c.ruleset).pipe(Effect.provide(CampaignContent.layer(dir)));

describe("campaign.yaml", () => {
  effect("names the ruleset; without one a campaign plays Draw Steel", () =>
    Effect.gen(function* () {
      expect(yield* rulesetOf(yield* campaign(undefined))).toBe("draw-steel");
      expect(yield* rulesetOf(yield* campaign(""))).toBe("draw-steel");
      expect(yield* rulesetOf(yield* campaign("rules: set-world\n"))).toBe("set-world");
      expect(yield* rulesetOf(yield* campaign("# a note\nrules: draw-steel\n"))).toBe("draw-steel");
      expect(yield* rulesetOf(SAMPLE)).toBe("draw-steel");
    }),
  );

  effect("a ruleset or setting the table doesn't know stops the host, saying which", () =>
    Effect.gen(function* () {
      const unknown = yield* campaign("rules: pathfinder\n");
      const exit = yield* Effect.exit(rulesetOf(unknown));
      expect(exit).toEqual(
        Exit.fail(
          expect.objectContaining({
            _tag: "CampaignConfigInvalid",
            message: `${unknown}/campaign.yaml: says rules: pathfinder, but a campaign plays draw-steel or set-world`,
          }),
        ),
      );
      const typo = yield* campaign("rule: set-world\n");
      const typoExit = yield* Effect.exit(rulesetOf(typo));
      expect(Exit.isFailure(typoExit) && JSON.stringify(typoExit.cause)).toContain(
        "has `rule`, which no campaign has; it holds only `rules`",
      );
      const list = yield* campaign("- set-world\n");
      expect(Exit.isFailure(yield* Effect.exit(rulesetOf(list)))).toBe(true);
    }),
  );
});

describe("rolling at set.world, a host fact", () => {
  effect(
    "decodes a recorded roll: the kept part, every piece of gear, two hands and two rings",
    () =>
      Effect.gen(function* () {
        const ada = yield* decodeRoll(101, recordedAnswer(101));
        expect(ada).toMatchObject({
          seed: 101,
          contentVersion: "7.1bmmTgz1B0Y9UKhiu84STg",
          className: "Wayguard",
          mainhand: "targe",
          powerRating: 1271,
          finalStats: { strength: 21, resolve: 23 },
          attributes: { maxHealth: 191, stamina: 102, initiative: 1.078 },
        });
        expect(ada.gear).toHaveLength(15);
        expect(ada.gear.filter((g) => g.slot === "hand").map((g) => g.name)).toEqual([
          "fine copper grips",
          "cotton wraps",
        ]);
        // What the table doesn't use stays out of the event.
        expect(Object.keys(ada)).not.toContain("equipment");
      }),
  );

  effect("refuses an answer for another seed, or one missing what the fight reads", () =>
    Effect.gen(function* () {
      const other = yield* Effect.flip(decodeRoll(7, recordedAnswer(101)));
      expect(other.message).toContain("it rolled seed 101, not 7");
      const answer = recordedAnswer(101) as { attributes: Record<string, unknown> };
      const { initiative: _gone, ...attributes } = answer.attributes;
      const partial = yield* Effect.flip(decodeRoll(101, { ...answer, attributes }));
      expect(partial.message).toStartWith(
        "set.world's answer isn't a character the table can read",
      );
      // A changed shape is told on one line, fit for a refusal.
      const roll = recordedAnswer(101) as { class: Record<string, unknown> };
      const renamed = { ...roll, class: { ...roll.class, name: 7 } };
      const shape = yield* Effect.flip(decodeRoll(101, renamed));
      expect(shape.message).not.toContain("\n");
      expect(shape.message).toContain('["class"]["name"]');
      const error = JSON.parse(
        yield* Effect.promise(() => readFile(join(FIXTURES, "invalid-seed.json"), "utf8")),
      );
      expect((yield* Effect.flip(decodeRoll(1, error)))._tag).toBe("SetWorldError");
    }),
  );

  effect("the GM's /recruit carries the roll in the event; replay never fetches", () =>
    Effect.gen(function* () {
      const dir = yield* campaign("rules: set-world\n");
      const live = recordedSetWorld();
      yield* atTable(
        dir,
        live.layer,
        Effect.gen(function* () {
          expect(said(yield* runLine("gm", "/recruit Ada 101"))).toEqual([
            "Ada the Wayguard joins the party: 191 health, 102 stamina, a targe (melee, reach 1), speed 5, set.world seed 101.",
          ]);
          expect(said(yield* runLine("gm", "/foe Grub 501"))).toEqual([
            "Grub the Dragoon comes as a foe: 150 health, 76 stamina, a pike (melee, reach 2), speed 5, set.world seed 501.",
          ]);
          expect(said(yield* runLine("gm", "/map ford"))).toEqual([
            "The map is The Ford Road, 20 by 10.",
          ]);
          expect(said(yield* runLine("gm", "/place ada b5"))).toEqual(["Ada is placed at b5."]);
        }),
      );
      expect(live.asked).toEqual([101, 501]);
      const log = yield* Effect.promise(() => readFile(join(dir, "events.jsonl"), "utf8"));
      const joined = JSON.parse(log.split("\n")[0]!);
      expect(joined).toMatchObject({
        type: "sw.fighter-joined",
        payload: { id: "ada", side: "party", character: { seed: 101, className: "Wayguard" } },
      });
      // The room opens again over the log with a set.world that mustn't be asked anything.
      yield* atTable(
        dir,
        unreachable,
        Effect.gen(function* () {
          const state = yield* Effect.flatMap(TableRoom, (r) => r.state.get);
          expect(state.sw.fighters.map((f) => [f.name, f.health, f.at])).toEqual([
            ["Ada", 191, { x: 1, y: 4 }],
            ["Grub", 150, undefined],
          ]);
          expect(said(yield* runLine("gm", "/sheet grub"))).toStartWith("Grub: Dragoon, a foe");
        }),
      );
    }),
  );

  effect("without a seed the host picks one, and the event says which", () =>
    Effect.gen(function* () {
      const dir = yield* campaign("rules: set-world\n");
      const asked: number[] = [];
      // Any seed gets Ada's roll, stamped with the seed it was asked for.
      const anySeed = SetWorld.answering((seed) => {
        asked.push(seed);
        return { ...(recordedAnswer(101) as object), seed };
      });
      yield* atTable(
        dir,
        anySeed,
        Effect.gen(function* () {
          const reply = yield* runLine("gm", "/recruit Bo").pipe(Random.withSeed("supervillain"));
          expect(said(reply)).toEqual([
            `Bo the Wayguard joins the party: 191 health, 102 stamina, a targe (melee, reach 1), speed 5, set.world seed ${asked[0]}.`,
          ]);
          expect(asked).toHaveLength(1);
          expect(asked[0]).toBeGreaterThanOrEqual(0);
          expect(asked[0]).toBeLessThanOrEqual(4_294_967_295);
        }),
      );
    }),
  );

  effect(
    "a player's /recruit is refused without asking; a failed roll is refused, saying why",
    () =>
      Effect.gen(function* () {
        const dir = yield* campaign("rules: set-world\n");
        const live = recordedSetWorld();
        yield* atTable(
          dir,
          live.layer,
          Effect.gen(function* () {
            expect(yield* runLine(alice, "/recruit Ada 101")).toEqual({
              kind: "refusal",
              text: "Only the GM can use /recruit.",
            });
            expect(live.asked).toEqual([]);
            expect(yield* runLine("gm", "/recruit Ada 5")).toEqual({
              kind: "refusal",
              text: "No roll from set.world for seed 5: set.world answered 404.",
            });
            expect((yield* Effect.flatMap(TableRoom, (r) => r.state.get)).seq).toBe(0);
          }),
        );
      }),
  );

  effect(
    "a Draw Steel campaign offers none of it, and a set.world campaign none of Draw Steel",
    () =>
      Effect.gen(function* () {
        const live = recordedSetWorld();
        yield* atTable(
          yield* campaign(undefined),
          live.layer,
          Effect.gen(function* () {
            const reply = yield* runLine("gm", "/recruit Ada 101");
            expect(reply.kind).toBe("refusal");
            expect(said(reply)).toStartWith("Unknown command /recruit.");
            const help = said(yield* runLine("gm", "/help"));
            expect(help).toContain("/hero <hero id>");
            expect(help).not.toContain("/attack");
          }),
        );
        yield* atTable(
          yield* campaign("rules: set-world\n"),
          live.layer,
          Effect.gen(function* () {
            expect(said(yield* runLine("gm", "/hero brann"))).toStartWith("Unknown command /hero.");
            expect(said(yield* runLine("gm", "/help"))).toContain("/attack <who> <target>");
          }),
        );
        expect(live.asked).toEqual([]);
      }),
  );
});
