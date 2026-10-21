import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { importBestiary } from "../../src/content/index.ts";
import { plainText } from "../../src/game/index.ts";
import { execLine, type Reply, runLine } from "../../src/host/line.ts";
import { Presence } from "../../src/host/Presence.ts";
import { type TableServices, tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { sampleCampaign } from "./campaign.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const vex = "key:SHA256:vexVEXvexVEXkey";
const bob = "key:SHA256:bobBOBbobBOBkey";

const atTable = <A, E>(body: Effect.Effect<A, E, TableServices | Scope.Scope>) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    return yield* body.pipe(Effect.provide(tableServices(dir)));
  });

/** The table over a copy of the sample campaign; `body` gets its folder. */
const atSampleTable = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, TableServices | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const dir = yield* sampleCampaign;
    return yield* body(dir).pipe(Effect.provide(tableServices(dir)));
  });

const stateNow = Effect.flatMap(TableRoom, (r) => r.state.get);

/** The plain text of what a line wrote, or its refusal or message. */
const said = (reply: Reply): ReadonlyArray<string> | string =>
  reply.kind === "done" ? reply.lines.map(plainText) : reply.kind === "empty" ? "" : reply.text;

describe("runLine", () => {
  effect("plain text is chat, and the reply is the feed line it made, labelled now", () =>
    atTable(
      Effect.gen(function* () {
        expect(yield* runLine("gm", "hello there")).toEqual({
          kind: "done",
          lines: [{ seq: 1, who: "GM", kind: "chat", text: "hello there", gm: true }],
        });
        yield* runLine(vex, "/name Vex");
        const rolled = yield* runLine(vex, "/roll 2d6+1");
        expect(rolled.kind).toBe("done");
        const [line] = rolled.kind === "done" ? rolled.lines : [];
        expect(plainText(line!)).toMatch(/^Vex rolled 2d6\+1: \[[1-6], [1-6]\] \+1 = \d+$/);
      }),
    ),
  );

  effect("refusals from parsing and from the rules come back as refusals", () =>
    atTable(
      Effect.gen(function* () {
        expect(yield* runLine(vex, "/roll")).toEqual({
          kind: "refusal",
          text: "Usage: /roll <dice>, e.g. 2d10+3",
        });
        expect(yield* runLine(vex, "/narrate The sky falls.")).toEqual({
          kind: "refusal",
          text: "Only the GM can use /narrate.",
        });
        expect(yield* runLine(vex, "/dance")).toMatchObject({ kind: "refusal" });
      }),
    ),
  );

  effect("help, state and blank lines stay with the seat and write nothing", () =>
    atTable(
      Effect.gen(function* () {
        const help = yield* runLine(vex, "/help");
        expect(help.kind).toBe("message");
        expect(help.kind === "message" && help.text).toContain("/roll <dice>");
        expect(help.kind === "message" && help.text).not.toContain("/narrate");
        expect(yield* runLine(vex, "   ")).toEqual({ kind: "empty" });
        const state = yield* runLine("gm", "/state");
        expect(state.kind === "message" && state.text).toContain('"seq": 0');
        expect((yield* Effect.flatMap(TableRoom, (r) => r.state.get)).seq).toBe(0);
      }),
    ),
  );

  effect("help on a command there isn't is a refusal, so exec exits 1", () =>
    atTable(
      Effect.gen(function* () {
        expect(yield* runLine(vex, "/help nosuch", "exec")).toEqual({
          kind: "refusal",
          text: "Unknown command /nosuch. /help lists the commands.",
        });
        expect((yield* runLine(vex, "/help roll", "exec")).kind).toBe("message");
      }),
    ),
  );

  effect("the state dump is the GM's alone", () =>
    atTable(
      Effect.gen(function* () {
        expect(yield* runLine(vex, "/state")).toEqual({
          kind: "refusal",
          text: "Only the GM can use /state.",
        });
        expect(yield* runLine(vex, "/state", "exec")).toMatchObject({ kind: "refusal" });
      }),
    ),
  );

  effect("over exec, help speaks of exec, and /quit has nothing to leave", () =>
    atTable(
      Effect.gen(function* () {
        const help = yield* runLine(vex, "/help", "exec");
        expect(help.kind === "message" && help.text).toStartWith(
          "Plain text is chat. Commands start with /; roll, dist, undo, redo, help and sheet work without it here.",
        );
        expect(help.kind === "message" && help.text).not.toContain("/quit");
        expect(yield* runLine(vex, "/quit", "exec")).toMatchObject({ kind: "refusal" });
      }),
    ),
  );

  effect("a guest's name is held while they are seated, and free once they go", () =>
    atTable(
      Effect.gen(function* () {
        const guest = "guest:wrenWREN";
        const seat = yield* Scope.make();
        yield* Effect.flatMap(Presence, (p) => p.enter(guest)).pipe(Scope.provide(seat));
        expect((yield* runLine(guest, "/name Wren")).kind).toBe("done");
        expect(yield* runLine(vex, "/name wren")).toEqual({
          kind: "refusal",
          text: '"wren" is taken; pick another name.',
        });
        yield* Scope.close(seat, Exit.void);
        expect((yield* runLine(vex, "/name Wren")).kind).toBe("done");
      }),
    ),
  );
});

describe("runLine with Draw Steel", () => {
  effect("a guest who drops and comes back as a new guest takes their hero back", () =>
    atSampleTable(() =>
      Effect.gen(function* () {
        const [first, again] = ["guest:daveDAVE1", "guest:daveDAVE2"];
        yield* runLine("gm", "/hero wren");
        const seat = yield* Scope.make();
        yield* Effect.flatMap(Presence, (p) => p.enter(first)).pipe(Scope.provide(seat));
        yield* runLine(first, "/name Dave");
        yield* runLine(first, "/play wren");
        yield* Effect.flatMap(Presence, (p) => p.enter(again));
        expect(said(yield* runLine(again, "/play wren"))).toBe("Wren is played by Dave.");
        yield* Scope.close(seat, Exit.void);
        yield* runLine(again, "/name Dave");
        expect(said(yield* runLine(again, "/play wren"))).toEqual(["Dave takes Wren."]);
      }),
    ),
  );

  effect("/hero and /add load their sheets from the campaign folder into the event", () =>
    atSampleTable(() =>
      Effect.gen(function* () {
        expect(yield* runLine("gm", "/hero bra")).toMatchObject({ kind: "done" });
        expect((yield* runLine("gm", "/add bandit-cut x4")).kind).toBe("done");
        const state = yield* stateNow;
        expect(state.ds.heroes.map((h) => [h.id, h.sheet.class, h.stamina])).toEqual([
          ["brann", "Censor", 24],
        ]);
        // Four cutpurses of 5 Stamina each pool into one squad.
        expect(state.ds.creatures).toMatchObject([
          { id: "bandit-cutpurse-a", name: "Bandit Cutpurse A", squad: 4, stamina: 20, max: 20 },
        ]);
        const recent = yield* Effect.flatMap(TableRoom, (r) => r.recent.get);
        expect(recent.map((e) => e.type)).toEqual(["ds.hero-joined", "ds.creatures-added"]);
        expect(recent[0]!.payload).toMatchObject({ sheet: { id: "brann", stamina: 24 } });
        expect(recent[1]!.payload).toMatchObject({ block: { id: "bandit-cutpurse", stamina: 5 } });
      }),
    ),
  );

  effect("a sheet that's missing or wrong is refused, naming the file and the field", () =>
    atSampleTable((dir) =>
      Effect.gen(function* () {
        expect(said(yield* runLine("gm", "/hero nobody"))).toBe(
          'no hero "nobody" in heroes/ (there are: brann, ilsa, kesh, wren)',
        );
        expect(said(yield* runLine("gm", "/add dragon"))).toStartWith(
          'no monster "dragon" in monsters/',
        );
        yield* Effect.promise(() =>
          writeFile(
            join(dir, "heroes", "broken.yaml"),
            [
              "name: Broken",
              "class: Fury",
              "level: 1",
              "characteristics: { might: 9, agility: 0, reason: 0, intuition: 0, presence: 0 }",
              "stamina: 20",
              "recoveries: 8",
              "speed: 5",
              "resource: { name: ferocity, perTurn: 1d3 }",
              "",
            ].join("\n"),
          ),
        );
        expect(said(yield* runLine("gm", "/hero broken"))).toBe(
          "heroes/broken.yaml: characteristics.might must be a whole number from -5 to 5",
        );
        expect(said(yield* runLine("gm", "/hero b"))).toBe(
          '"b" could be any of these heroes: brann, broken',
        );
        // A player's GM-only command reads no file: the rules refuse it as it is.
        expect(said(yield* runLine(vex, "/hero broken"))).toBe("Only the GM can use /hero.");
        expect(said(yield* runLine(vex, "/add dragon"))).toBe("Only the GM can use /add.");
        expect((yield* stateNow).seq).toBe(0);
      }),
    ),
  );

  effect("a sheet the loader accepts is one /add and /hero accept: prose may run over lines", () =>
    atSampleTable((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(
            join(dir, "monsters", "ogre.yaml"),
            [
              "name: Ogre",
              "level: 2",
              "organization: elite",
              "stamina: 60",
              "speed: 5",
              "freeStrike: 5",
              "characteristics: { might: 3, agility: 0, reason: -1, intuition: 0, presence: 0 }",
              "abilities:",
              "  - name: Club Sweep",
              "    bonus: 3",
              "    tier1: 6 damage",
              "    effect: >",
              "      Each target is pushed",
              "      one square.",
              "  - name: Roar",
              "    effect: |",
              "      Every enemy within 3",
              "      \tis frightened.",
              "",
            ].join("\n"),
          ),
        );
        expect((yield* runLine("gm", "/add ogre")).kind).toBe("done");
        const block = (yield* stateNow).ds.blocks.ogre!;
        expect(block.abilities.map((a) => a.effect)).toEqual([
          "Each target is pushed one square.",
          "Every enemy within 3 is frightened.",
        ]);
      }),
    ),
  );

  effect("a multi-effect creature from an import goes straight onto the table", () =>
    atSampleTable((dir) =>
      Effect.gen(function* () {
        const source = yield* tempDir;
        yield* Effect.promise(() =>
          writeFile(
            join(source, "beast.json"),
            JSON.stringify({
              name: "Two Effect Beast",
              level: 1,
              roles: ["Elite Brute"],
              stamina: "30",
              speed: 5,
              stability: 1,
              free_strike: 3,
              might: 2,
              agility: 0,
              reason: -2,
              intuition: 0,
              presence: 0,
              features: [
                {
                  name: "Gore",
                  effects: [
                    { roll: "2d10 + 2", tier1: "4 damage", tier2: "6 damage", tier3: "8 damage" },
                    { effect: "Push 1." },
                    { name: "Malice 2", effect: "Grab." },
                  ],
                },
              ],
            }),
          ),
        );
        const report = yield* importBestiary({ from: source, into: dir });
        expect(report.imported.map((m) => [m.id, m.status])).toEqual([
          ["two-effect-beast", "written"],
        ]);
        expect((yield* runLine("gm", "/add two")).kind).toBe("done");
        expect((yield* stateNow).ds.blocks["two-effect-beast"]!.abilities[0]!.effect).toBe(
          "Push 1. Malice 2: Grab.",
        );
      }),
    ),
  );

  effect("what only the rules would refuse is refused on loading, naming the file and field", () =>
    atSampleTable((dir) =>
      Effect.gen(function* () {
        const long = "A Name Much Too Long For The Band To Hold";
        yield* Effect.promise(() =>
          writeFile(
            join(dir, "monsters", "wordy.yaml"),
            [
              "name: Wordy",
              "level: 1",
              "organization: solo",
              "stamina: 10",
              "speed: 5",
              "freeStrike: 1",
              "characteristics: { might: 0, agility: 0, reason: 0, intuition: 0, presence: 0 }",
              "abilities:",
              `  - name: ${long}`,
              '    effect: "Rings a bell\u0007"',
              "",
            ].join("\n"),
          ),
        );
        expect(said(yield* runLine("gm", "/add wordy"))).toBe(
          "monsters/wordy.yaml: abilities[1].name must be one line of up to 40 characters; abilities[1].effect holds control characters",
        );
        yield* Effect.promise(() =>
          Bun.write(join(dir, "heroes", "Vex.yaml"), Bun.file(join(dir, "heroes", "brann.yaml"))),
        );
        expect(said(yield* runLine("gm", "/hero vex"))).toBe(
          "heroes/Vex.yaml: the file name is the id, so it must be lowercase letters, digits and dashes",
        );
        expect((yield* stateNow).seq).toBe(0);
      }),
    ),
  );

  effect("a player who plays a hero is labelled with it; the GM gives a hero by label", () =>
    atSampleTable(() =>
      Effect.gen(function* () {
        yield* runLine(vex, "/name Vex");
        yield* runLine(bob, "/name Bob");
        yield* runLine("gm", "/hero brann");
        yield* runLine("gm", "/hero kesh");
        expect((yield* runLine(vex, "/play brann")).kind).toBe("done");
        expect(said(yield* runLine(vex, "hello"))).toEqual(["Vex (Brann): hello"]);
        expect(said(yield* runLine("gm", "/play kesh nobody"))).toBe(
          "Nobody at the table is called 'nobody'.",
        );
        expect((yield* runLine("gm", "/play kesh bob")).kind).toBe("done");
        const state = yield* stateNow;
        expect(state.ds.heroes.map((h) => [h.id, h.player])).toEqual([
          ["brann", vex],
          ["kesh", bob],
        ]);
        expect(said(yield* runLine(bob, "/me nods"))).toEqual(["Bob (Kesh) nods"]);
      }),
    ),
  );

  effect("the GM gives a hero to a seated guest by the guest's label", () =>
    atSampleTable(() =>
      Effect.gen(function* () {
        const guest = "guest:wrenWREN";
        yield* Effect.flatMap(Presence, (p) => p.enter(guest));
        yield* runLine("gm", "/hero wren");
        expect((yield* runLine("gm", "/play wren guest-wren")).kind).toBe("done");
        expect((yield* stateNow).ds.heroes[0]!.player).toBe(guest);
      }),
    ),
  );

  effect("/sheet answers the sender alone, at a seat or over exec, and writes nothing", () =>
    atSampleTable(() =>
      Effect.gen(function* () {
        yield* runLine("gm", "/hero brann");
        yield* runLine("gm", "/add bandit-chief");
        const seq = (yield* stateNow).seq;
        const hero = yield* runLine(vex, "/sheet brann");
        expect(hero.kind).toBe("message");
        expect(said(hero)).toStartWith("Brann: Censor 1\nStamina 24/24");
        expect(said(hero)).toContain("Driving Blow");
        const chief = yield* runLine(vex, "/sheet bandit-c", "exec");
        expect(chief.kind).toBe("message");
        expect(said(chief)).toStartWith("Bandit Chief: level 1 leader");
        expect(said(yield* runLine(vex, "/sheet nobody"))).toBe(
          "Nobody at the table is called 'nobody'.",
        );
        expect(said(yield* runLine(vex, "/sheet"))).toBe("Usage: /sheet <who>");
        expect((yield* stateNow).seq).toBe(seq);
        expect(said(yield* runLine(vex, "/help"))).toContain("/sheet <who>");
      }),
    ),
  );
});

describe("runLine with the map and undo", () => {
  effect("/map reads maps/<id>.txt from the campaign folder into the event", () =>
    atSampleTable(() =>
      Effect.gen(function* () {
        expect(said(yield* runLine("gm", "/map ford"))).toEqual([
          "The map is The Ford Road, 20 by 10.",
        ]);
        const [loaded] = yield* Effect.flatMap(TableRoom, (r) => r.recent.get);
        expect(loaded).toMatchObject({ type: "ds.map-loaded", payload: { id: "ford-road" } });
        const terrain = (loaded!.payload as { terrain: string[] }).terrain;
        expect(terrain.length).toBe(10);
        expect(terrain[1]).toBe(".##.###....~~.......");
        // The outside corners of the first row, padded out to the full width.
        expect(terrain[0]).toBe("  ................  ");
        expect(said(yield* runLine("gm", "/map off"))).toEqual(["The map is put away."]);
      }),
    ),
  );

  effect(
    "a map that's missing or wrong is refused naming the file; a player's /map reads none",
    () =>
      atSampleTable((dir) =>
        Effect.gen(function* () {
          expect(said(yield* runLine("gm", "/map cave"))).toBe(
            'no map "cave" in maps/ (there are: ford-road)',
          );
          yield* Effect.promise(() => writeFile(join(dir, "maps", "cave.txt"), "..\n.\t\n"));
          expect(said(yield* runLine("gm", "/map cave"))).toBe(
            "maps/cave.txt line 2, column 2 is a tab; draw maps with . floor, # wall, ~ difficult terrain and space for outside.",
          );
          expect(said(yield* runLine(vex, "/map cave"))).toBe("Only the GM can use /map.");
          expect((yield* stateNow).seq).toBe(0);
        }),
      ),
  );

  effect(
    "the host says what time it is, so a player takes back their own change for 30 seconds",
    () =>
      atSampleTable(() =>
        Effect.gen(function* () {
          yield* runLine(vex, "/name Vex");
          yield* runLine("gm", "/hero brann");
          yield* runLine(vex, "/play brann");
          yield* runLine("gm", "/map ford-road");
          yield* runLine(vex, "/place brann b5");
          expect(said(yield* runLine(vex, "/undo"))).toEqual([
            "↶ Vex (Brann) undid: Brann is placed at b5.",
          ]);
          expect((yield* stateNow).ds.map?.tokens).toEqual({});
          yield* runLine(vex, "/place brann c5");
          yield* TestClock.adjust("31 seconds");
          expect(said(yield* runLine(vex, "/undo"))).toBe(
            "Too late: you can take back your own change for 30 seconds. Ask the GM.",
          );
          expect((yield* runLine("gm", "/undo")).kind).toBe("done");
          expect((yield* stateNow).ds.map?.tokens).toEqual({});
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  effect(
    "the GM takes back one person's change by their name, and the host finds who that is",
    () =>
      atSampleTable(() =>
        Effect.gen(function* () {
          yield* runLine(vex, "/name Vex");
          yield* runLine("gm", "/hero brann");
          yield* runLine(vex, "/play brann");
          yield* runLine("gm", "/map ford-road");
          yield* runLine(vex, "/place brann b5");
          yield* runLine("gm", "/dmg brann 3");
          expect(said(yield* runLine("gm", "/undo nobody"))).toBe(
            "Nobody at the table is called 'nobody'.",
          );
          expect(said(yield* runLine("gm", "/undo vex"))).toEqual([
            "↶ GM undid: Brann is placed at b5.",
          ]);
          const state = yield* stateNow;
          expect(state.ds.map?.tokens).toEqual({});
          expect(state.ds.heroes[0]?.stamina).toBe(state.ds.heroes[0]!.sheet.stamina - 3);
          expect(said(yield* runLine("gm", "/redo"))).toEqual([
            "↷ GM redid: Brann is placed at b5.",
          ]);
        }),
      ),
  );

  effect("the state dump counts the undo stack instead of printing every snapshot", () =>
    atSampleTable(() =>
      Effect.gen(function* () {
        // Two quick submissions in one millisecond are still two batches: the room stamps each
        // later than the one before.
        yield* runLine("gm", "/hero brann");
        yield* runLine("gm", "/dmg brann 3");
        const state = yield* runLine("gm", "/state");
        expect(state.kind === "message" && state.text).toContain('"undo": "[2 batches]"');
      }),
    ),
  );
});

describe("plainText", () => {
  test("reads each core kind the way the table shows it", () => {
    const at = (kind: string, text: string) => plainText({ who: "Vex", kind, text });
    expect(at("chat", "hi")).toBe("Vex: hi");
    expect(at("emote", "waves")).toBe("Vex waves");
    expect(at("narration", "Rain falls.")).toBe("Rain falls.");
    expect(at("roll", "rolled d6: [4] = 4")).toBe("Vex rolled d6: [4] = 4");
    expect(at("name", "Vex is now Ash")).toBe("Vex is now Ash");
  });
});

describe("execLine", () => {
  test("a leading command name needs no slash over exec; anything else is as typed", () => {
    expect(execLine("roll 2d10")).toBe("/roll 2d10");
    expect(execLine("Roll 2d10")).toBe("/Roll 2d10");
    expect(execLine("help")).toBe("/help");
    // /sheet is read-only and answers the sender alone, so it's safe without its slash.
    expect(execLine("sheet kesh")).toBe("/sheet kesh");
    expect(execLine("undo")).toBe("/undo");
    expect(execLine("redo")).toBe("/redo");
    expect(execLine("dist kesh chief")).toBe("/dist kesh chief");
    expect(execLine("/name Vex")).toBe("/name Vex");
    expect(execLine("hello everyone")).toBe("hello everyone");
    expect(execLine("  rolling along")).toBe("  rolling along");
  });

  test("commands that take free text keep their slash, so chat that starts with one stays chat", () => {
    expect(execLine("name the dog")).toBe("name the dog");
    expect(execLine("me too")).toBe("me too");
    expect(execLine("say what")).toBe("say what");
    expect(execLine("quit")).toBe("quit");
    // /state is the GM's seat's alone, and exec never runs as the GM: a bare one is chat.
    expect(execLine("state of things")).toBe("state of things");
  });
});
