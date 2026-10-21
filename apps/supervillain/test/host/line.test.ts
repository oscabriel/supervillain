import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { plainText } from "../../src/game/index.ts";
import { execLine, runLine } from "../../src/host/line.ts";
import { Presence } from "../../src/host/Presence.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const vex = "key:SHA256:vexVEXvexVEXkey";

const atTable = <A, E>(body: Effect.Effect<A, E, TableRoom | Presence | Scope.Scope>) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    return yield* body.pipe(Effect.provide(Presence.layer), Effect.provide(TableRoom.layer(dir)));
  });

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
          "Plain text is chat. Commands start with /; roll and help work without it here.",
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

describe("plainText", () => {
  test("reads each core kind the way the table shows it", () => {
    const at = (kind: string, text: string) => plainText({ who: "Vex", kind, text });
    expect(at("chat", "hi")).toBe("Vex: hi");
    expect(at("emote", "waves")).toBe("Vex waves");
    expect(at("narration", "Rain falls.")).toBe("Rain falls.");
    expect(at("roll", "rolled d6: [4] = 4")).toBe("Vex rolled d6: [4] = 4");
    expect(at("name", "guest-7f3a is now Vex")).toBe("guest-7f3a is now Vex");
  });
});

describe("execLine", () => {
  test("a leading command name needs no slash over exec; anything else is as typed", () => {
    expect(execLine("roll 2d10")).toBe("/roll 2d10");
    expect(execLine("Roll 2d10")).toBe("/Roll 2d10");
    expect(execLine("help")).toBe("/help");
    expect(execLine("/name Vex")).toBe("/name Vex");
    expect(execLine("hello everyone")).toBe("hello everyone");
    expect(execLine("  rolling along")).toBe("  rolling along");
  });

  test("commands that take free text keep their slash, so chat that starts with one stays chat", () => {
    expect(execLine("name the dog")).toBe("name the dog");
    expect(execLine("me too")).toBe("me too");
    expect(execLine("say what")).toBe("say what");
    expect(execLine("quit")).toBe("quit");
  });
});
