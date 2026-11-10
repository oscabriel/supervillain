import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { formatSquare } from "../../src/game/drawSteel/index.ts";
import { bandOf, feedLines, mapView, plainText, tableLabel } from "../../src/game/index.ts";
import { sampleCampaign } from "../host/campaign.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { asGm, asPlayer, type Hosted, hostTable, logOf } from "./hosted.ts";
import { clientKey, sshExec } from "./openssh.ts";

/** Alice plays Brann's whole turn in a few seconds, faster than the table lets a player type. */
const QUICK = { playerRate: { burst: 100, perSecond: 100 } };

/** Every seat's map and band, the feed as text and the state: what a restart must reproduce. */
const projection = (table: Hosted, actors: ReadonlyArray<string>) =>
  Effect.map(table.state, (s) => ({
    maps: actors.map((a) => mapView(s.ds, a)),
    bands: actors.map((a) => bandOf(s, a, "draw-steel")),
    feed: feedLines(s, tableLabel(s, "draw-steel")).map(plainText),
    state: s,
  }));

/** Where each placed token stands, as the squares people type. */
const squares = (table: Hosted) =>
  Effect.map(table.state, (s) =>
    Object.fromEntries(
      Object.entries(s.ds.map?.tokens ?? {}).map(([id, at]) => [id, formatSquare(at)]),
    ),
  );

const staminaOf = (table: Hosted, id: string) =>
  Effect.map(table.state, (s) => s.ds.creatures.find((c) => c.id === id)?.stamina);

describe("the ford road over real ssh", () => {
  effect(
    "the GM loads the sample map, players move and push over exec, undo takes back, and a restart replays it",
    () =>
      Effect.gen(function* () {
        const dir = yield* sampleCampaign;
        const keys = yield* tempDir;
        const alice = yield* clientKey(keys, "alice");
        const bob = yield* clientKey(keys, "bob");
        const everyone = ["gm", `key:${alice.fingerprint}`, `key:${bob.fingerprint}`];

        let table = yield* hostTable(dir, QUICK);
        const { port } = table;
        yield* asPlayer(port, alice, "/name Alice");
        yield* asPlayer(port, bob, "/name Bob");
        yield* asGm(table, "/hero brann");
        yield* asGm(table, "/hero kesh");
        yield* asPlayer(port, alice, "/play brann");
        yield* asPlayer(port, bob, "/play kesh");

        // The map is examples/campaign/maps/ford-road.txt, 20 columns (a-t) by 10 rows.
        expect(yield* asGm(table, "/map ford")).toEqual(["The map is The Ford Road, 20 by 10."]);
        yield* asGm(table, "/add bandit-bruiser");
        yield* asGm(table, "/add bandit-chief");
        expect(yield* asPlayer(port, alice, "/place brann b5")).toBe("Brann is placed at b5.\n");
        expect(yield* asPlayer(port, bob, "/place kesh b7")).toBe("Kesh is placed at b7.\n");
        expect(yield* sshExec(port, "/place bandit-chief p5", bob)).toMatchObject({
          exitCode: 1,
          stderr: "You can only place your own hero.\n",
        });
        expect(yield* asGm(table, "/place bandit-bruiser h5")).toEqual([
          "Bandit Bruiser is placed at h5.",
        ]);
        yield* asGm(table, "/place bandit-chief p5");
        yield* asGm(table, "/start");
        yield* asGm(table, "/first heroes");
        yield* asPlayer(port, alice, "/turn");

        // Brann's speed is 5, and k5 is 9 squares east of b5.
        expect(yield* sshExec(port, "/move brann k5", alice)).toMatchObject({
          exitCode: 1,
          stderr:
            "Brann can't move that far: k5 takes 9 squares of movement, and Brann's speed is 5.\n",
        });
        expect(yield* asPlayer(port, alice, "/move brann f5")).toBe(
          "Brann moves to f5 (4 squares of movement).\n",
        );
        // Alice changes her mind: her own move, the latest change, within 30 seconds.
        expect(yield* asPlayer(port, alice, "/undo")).toBe(
          "↶ Alice (Brann) undid: Brann moves to f5 (4 squares of movement).\n",
        );
        expect((yield* squares(table)).brann).toBe("b5");
        expect(yield* asPlayer(port, alice, "/move brann g5")).toBe(
          "Brann moves to g5 (5 squares of movement).\n",
        );
        const moved = (yield* logOf(dir)).at(-1)!;
        expect(moved).toMatchObject({
          type: "ds.moved",
          payload: { id: "brann", cost: 5, speed: 5, spent: 5, allowance: 5 },
        });

        // Push 3 from Brann, less the bruiser's stability 2: one square straight away, h5 to i5.
        expect(yield* asPlayer(port, alice, "/push bandit-bruiser 3")).toBe(
          "Bandit Bruiser is pushed 1 square by Brann to i5 (push 3, stability 2).\n",
        );
        expect(yield* asPlayer(port, alice, "/dist brann bandit-bruiser")).toBe(
          "Alice (Brann) measures Brann (g5) to Bandit Bruiser (i5): 2 squares.\n",
        );

        // The GM takes back a slip: the damage goes, and so does what it did to Stamina.
        expect(yield* asGm(table, "/dmg bandit-bruiser 5")).toEqual([
          "Bandit Bruiser takes 5 damage → 15/20",
        ]);
        expect(yield* staminaOf(table, "bandit-bruiser")).toBe(15);
        expect(yield* asGm(table, "/undo")).toEqual([
          "↶ GM undid: Bandit Bruiser takes 5 damage → 15/20",
        ]);
        expect(yield* staminaOf(table, "bandit-bruiser")).toBe(20);
        const retracted = (yield* logOf(dir)).at(-1)!;
        expect(retracted).toMatchObject({ actor: "gm", type: "core.retracted" });

        // Brann's speed is spent; his main action goes on a second move. Then the GM changes
        // the game, and Alice's move is still hers to take back: the GM's damage stays.
        expect(yield* sshExec(port, "/move brann g6", alice)).toMatchObject({ exitCode: 1 });
        yield* asPlayer(port, alice, "/move brann g6 main");
        yield* asGm(table, "/dmg bandit-chief 2");
        expect(yield* asPlayer(port, alice, "undo")).toBe(
          "↶ Alice (Brann) undid: Brann moves to g6 (1 square of movement, 6 of 10 this turn with the main action).\n",
        );
        expect(yield* staminaOf(table, "bandit-chief")).toBe(
          (yield* table.state).ds.creatures.find((c) => c.id === "bandit-chief")!.max - 2,
        );
        // Kesh moves on Kesh's turn, not Brann's.
        expect(yield* sshExec(port, "/move kesh c7", bob)).toMatchObject({
          exitCode: 1,
          stderr: "It isn't Kesh's turn; the GM moves heroes between turns.\n",
        });
        expect(yield* squares(table)).toEqual({
          brann: "g5",
          kesh: "b7",
          "bandit-bruiser": "i5",
          "bandit-chief": "p5",
        });

        // The host goes down and comes back: the log alone rebuilds every map and band.
        const before = yield* projection(table, everyone);
        expect(before.maps[1]?.tokens.map((t) => [t.mark, t.mine, t.acting])).toEqual([
          ["B", true, true],
          ["K", false, false],
          ["b", false, false],
          ["c", false, false],
        ]);
        expect(before.maps[1]?.reachLabel).toBe("Brann can reach: 0 of speed 5 left");
        yield* table.stop;
        table = yield* hostTable(dir, QUICK);
        expect(yield* projection(table, everyone)).toEqual(before);
        yield* table.stop;
      }),
    60_000,
  );
});
