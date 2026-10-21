import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Envelope } from "@supervillain/engine";
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect";
import { bandOf, feedLines, plainText, tableLabel } from "../../src/game/index.ts";
import { runLine } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { TableServer } from "../../src/host/TableServer.ts";
import { sampleCampaign } from "../host/campaign.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { type ClientKey, clientKey, sshExec } from "./openssh.ts";

/**
 * The host as `supervillain host` builds it, in this process so the test can sit in the GM's
 * seat (the local one, which no ssh client can reach). Closing the returned scope stops it.
 */
const hostTable = (dir: string) =>
  Effect.gen(function* () {
    // A child of the test's scope: closed by `stop`, or with the test if it fails first.
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const layer = TableServer.layer({
      campaignDir: dir,
      room: "ford",
      port: 0,
      bind: "127.0.0.1",
    }).pipe(Layer.provideMerge(tableServices(dir)), Layer.provide(Logger.layer([])));
    const context = yield* Layer.buildWithScope(layer, scope);
    const gm = (line: string) => runLine("gm", line).pipe(Effect.provideContext(context));
    const state = Context.get(context, TableRoom).state.get;
    return {
      port: Context.get(context, TableServer).port,
      gm,
      state,
      stop: Scope.close(scope, Exit.void),
    };
  });

type Hosted = Effect.Success<ReturnType<typeof hostTable>>;

/** Runs one GM line, failing the test unless it was written; returns what it said. */
const asGm = (table: Hosted, line: string) =>
  Effect.gen(function* () {
    const reply = yield* table.gm(line);
    if (reply.kind !== "done")
      throw new Error(`the GM's ${line} came back ${JSON.stringify(reply)}`);
    return reply.lines.map(plainText);
  });

/** Runs one player line over real ssh, failing the test unless it worked; returns stdout. */
const asPlayer = (port: number, key: ClientKey, line: string) =>
  Effect.gen(function* () {
    const result = yield* sshExec(port, line, key);
    if (result.exitCode !== 0) throw new Error(`${line} failed: ${result.stderr}`);
    return result.stdout;
  });

const logOf = (dir: string) =>
  Effect.promise(async () =>
    (await readFile(join(dir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Envelope),
  );

/** Every band the table could draw, and the feed as text: what a restart must reproduce. */
const projection = (table: Hosted, actors: ReadonlyArray<string>) =>
  Effect.map(table.state, (s) => ({
    bands: actors.map((a) => bandOf(s, a)),
    feed: feedLines(s, tableLabel(s)).map(plainText),
    state: s,
  }));

describe("a short Draw Steel encounter over real ssh", () => {
  effect(
    "the GM sets up from the sample campaign, players act over exec, and a restart replays it",
    () =>
      Effect.gen(function* () {
        const dir = yield* sampleCampaign;
        const keys = yield* tempDir;
        const alice = yield* clientKey(keys, "alice");
        const bob = yield* clientKey(keys, "bob");
        const aliceActor = `key:${alice.fingerprint}`;
        const bobActor = `key:${bob.fingerprint}`;
        const everyone = ["gm", aliceActor, bobActor];

        let table = yield* hostTable(dir);
        const { port } = table;
        yield* asPlayer(port, alice, "/name Alice");
        yield* asPlayer(port, bob, "/name Bob");

        expect(yield* asGm(table, "/hero brann")).toEqual([
          expect.stringMatching(/^Brann joins the party:/),
        ]);
        yield* asGm(table, "/hero kesh");
        expect(yield* asPlayer(port, alice, "/play brann")).toBe("Alice takes Brann.\n");
        expect(yield* asPlayer(port, bob, "/play kesh")).toBe("Bob takes Kesh.\n");

        expect(yield* asGm(table, "/add bandit-cutpurse x4")).toEqual([
          "Bandit Cutpurse A (4 minions) joins the fight.",
        ]);
        expect(yield* asGm(table, "/add bandit-chief")).toEqual(["Bandit Chief joins the fight."]);
        const started = yield* asGm(table, "/start");
        // The sample heroes have no Victories: Malice is 0 for Victories, 2 heroes and round 1.
        expect(started[0]).toMatch(
          /^Combat begins, round 1\. d10: ([1-9]|10), so (the players pick|the Director picks) who goes first .* Malice \+3 \(0 for Victories, 2 heroes, round 1\) → 3\.$/,
        );
        yield* asGm(table, "/first heroes");

        // Brann's turn: Wrath +2 a turn, from the sheet.
        expect(yield* asPlayer(port, alice, "/turn")).toBe("Brann's turn. wrath +2 → 2.\n");
        const blow = yield* asPlayer(port, alice, "/pr brann driving");
        expect(blow).toMatch(/^Brann uses Driving Blow: \[\d+, \d+\] \+2 = \d+.* · tier [123] — /);
        const rolled = (yield* logOf(dir)).at(-1)!;
        expect(rolled).toMatchObject({
          actor: aliceActor,
          type: "ds.power-rolled",
          payload: { id: "brann", ability: "Driving Blow", bonus: 2, edges: 0, banes: 0 },
        });
        const roll = rolled.payload as { dice: [number, number]; total: number; tier: number };
        expect(roll.dice.every((d) => d >= 1 && d <= 10)).toBe(true);
        expect(roll.total).toBe(roll.dice[0] + roll.dice[1] + 2);
        // Tiers: 11 or less is tier 1, 12 to 16 tier 2, 17 or more tier 3.
        expect(roll.tier).toBe(roll.total <= 11 ? 1 : roll.total <= 16 ? 2 : 3);

        // 7 damage to a squad of four 5-Stamina minions: the pool drops to 13, and one dies.
        expect(yield* asGm(table, "/dmg bandit-cutpurse-a 7")).toEqual([
          expect.stringMatching(
            /^Bandit Cutpurse A takes 7 damage → 13\/20 · 1 minion dies, 3 left/,
          ),
        ]);
        expect(yield* asPlayer(port, alice, "/cond brann slowed save")).toBe(
          "Brann is slowed (save ends).\n",
        );
        const ended = yield* asPlayer(port, alice, "/done");
        expect(ended).toMatch(
          /^Brann's turn ends\. Save against slowed: ([1-9]|10), it (ends|goes on)\.\n$/,
        );
        const save = (yield* logOf(dir)).at(-1)!;
        expect(save).toMatchObject({ type: "ds.turn-ended", payload: { id: "brann", ended: [] } });
        const [saved] = (save.payload as { saves: { condition: string; roll: number }[] }).saves;
        expect(saved!.condition).toBe("slowed");
        // A save of 6 or more ends the condition.
        const brann = (yield* table.state).ds.heroes.find((h) => h.id === "brann")!;
        expect(brann.conditions).toEqual(
          saved!.roll >= 6 ? [] : [{ name: "slowed", duration: "save" }],
        );

        // The Director's side: the chief, then its free strike on Kesh.
        expect(yield* sshExec(port, "/turn", bob)).toMatchObject({
          exitCode: 1,
          stderr: "It's the Director's turn to pick a creature.\n",
        });
        expect(yield* asGm(table, "/turn bandit-chief")).toEqual(["Bandit Chief's turn."]);
        expect(yield* asGm(table, "/fs bandit-chief kesh")).toEqual([
          "Bandit Chief free strikes: Kesh takes 4 damage → 20/24",
        ]);
        yield* asGm(table, "/done");
        expect(yield* asPlayer(port, bob, "/turn")).toMatch(
          /^Kesh's turn\. ferocity \+[123] \(1d3: [123]\) → [123]\.\n$/,
        );
        expect(yield* asPlayer(port, alice, "/sheet kesh")).toStartWith(
          "Kesh: Fury 1\nStamina 20/24",
        );
        yield* asGm(table, "/turn bandit-cutpurse-a");

        // Mid-fight, the host goes down and comes back: the log alone rebuilds every band.
        const before = yield* projection(table, everyone);
        expect(before.bands[1]).toMatchObject({ active: true, round: 1, malice: 3 });
        expect(before.bands[1]!.combatants.map((c) => [c.id, c.acting, c.mine])).toEqual([
          ["brann", false, true],
          ["kesh", false, false],
          ["bandit-cutpurse-a", true, false],
          ["bandit-chief", false, false],
        ]);
        yield* table.stop;
        table = yield* hostTable(dir);
        expect(yield* projection(table, everyone)).toEqual(before);

        const port2 = table.port;
        expect(yield* asGm(table, "/end")).toEqual([
          "Combat ends. Heroic resources, surges and Malice are lost; temporary Stamina and conditions end.",
        ]);
        expect(yield* asPlayer(port2, bob, "hello")).toBe("Bob (Kesh): hello\n");
        const after = yield* projection(table, everyone);
        expect(after.bands[0]).toMatchObject({ active: false });
        expect(after.bands[0]!.combatants.map((c) => c.name)).toEqual([
          "Brann (Alice)",
          "Kesh (Bob)",
        ]);
        yield* table.stop;
        table = yield* hostTable(dir);
        expect(yield* projection(table, everyone)).toEqual(after);
        yield* table.stop;
      }),
    60_000,
  );
});
