import { describe, expect, test } from "bun:test";
import { completeLine, helpText, parseInputLine, rules } from "../../src/game/index.ts";
import { ALICE, GM } from "./table.ts";

const state = rules.initial;

describe("parseInputLine", () => {
  test("plain text is chat, kept as typed for decide to clean", () => {
    expect(parseInputLine("hello there")).toEqual({
      kind: "command",
      command: { type: "say", text: "hello there" },
    });
  });

  test("a line with nothing visible is empty, so the table can ignore it quietly", () => {
    expect(parseInputLine("")).toEqual({ kind: "empty" });
    expect(parseInputLine("   \t ")).toEqual({ kind: "empty" });
    expect(parseInputLine("\x1b[A")).toEqual({ kind: "empty" });
  });

  test("/x looks x up in the registry, case-insensitively", () => {
    expect(parseInputLine("  /roll 2d10+3")).toEqual({
      kind: "command",
      command: { type: "roll", notation: "2d10+3" },
    });
    expect(parseInputLine("/ROLL D6")).toEqual({
      kind: "command",
      command: { type: "roll", notation: "1d6" },
    });
    expect(parseInputLine("/me waves")).toEqual({
      kind: "command",
      command: { type: "me", text: "waves" },
    });
    expect(parseInputLine("/name  Vex the Bold")).toEqual({
      kind: "command",
      command: { type: "name", name: " Vex the Bold" },
    });
  });

  test("a spec's parse refuses early with its usage", () => {
    expect(parseInputLine("/roll")).toEqual({
      kind: "refusal",
      message: "Usage: /roll <dice>, e.g. 2d10+3",
    });
    expect(parseInputLine("/roll lots")).toEqual({
      kind: "refusal",
      message: '"lots" isn\'t dice; try 2d10+3, d20 or 3d6-1.',
    });
    expect(parseInputLine("/me   ")).toEqual({ kind: "refusal", message: "Usage: /me <action>" });
  });

  test("GM-only commands parse for anyone; decide refuses players", () => {
    expect(parseInputLine("/narrate Rain falls.")).toEqual({
      kind: "command",
      command: { type: "narrate", text: "Rain falls." },
    });
  });

  test("an unknown command is refused with a hint", () => {
    expect(parseInputLine("/rol 2d6")).toEqual({
      kind: "refusal",
      message: "Unknown command /rol. Did you mean /roll?",
    });
    expect(parseInputLine("/n Vex")).toEqual({
      kind: "refusal",
      message: "Unknown command /n. Did you mean /narrate or /name?",
    });
    expect(parseInputLine("/stat")).toEqual({
      kind: "refusal",
      message: "Unknown command /stat. Did you mean /state?",
    });
    expect(parseInputLine("/sya hi")).toEqual({
      kind: "refusal",
      message: "Unknown command /sya. Did you mean /say?",
    });
    expect(parseInputLine("/xyzzy")).toEqual({
      kind: "refusal",
      message: "Unknown command /xyzzy. /help lists the commands.",
    });
  });

  test("/help and /state are local to the seat", () => {
    expect(parseInputLine("/help")).toEqual({ kind: "help" });
    expect(parseInputLine("/")).toEqual({ kind: "help" });
    expect(parseInputLine("/help /roll")).toEqual({ kind: "help", topic: "roll" });
    expect(parseInputLine("/state")).toEqual({ kind: "state" });
  });

  test("a doubled slash says a line that starts with a slash", () => {
    expect(parseInputLine("//shrug")).toEqual({
      kind: "command",
      command: { type: "say", text: "/shrug" },
    });
  });

  test("in name mode a plain line is a name; commands still work", () => {
    expect(parseInputLine("  Vex ", "name")).toEqual({
      kind: "command",
      command: { type: "name", name: "  Vex " },
    });
    expect(parseInputLine("/help", "name")).toEqual({ kind: "help" });
    expect(parseInputLine("/quit", "name")).toEqual({ kind: "quit" });
    expect(parseInputLine("", "name")).toEqual({ kind: "empty" });
  });
});

describe("completeLine", () => {
  test("after a slash: the command names this actor can use", () => {
    expect(completeLine(state, ALICE, "/")).toEqual([
      "/say ",
      "/me ",
      "/name ",
      "/roll ",
      "/help ",
      "/quit",
    ]);
    expect(completeLine(state, GM, "/")).toEqual([
      "/say ",
      "/me ",
      "/narrate ",
      "/name ",
      "/roll ",
      "/help ",
      "/state",
      "/quit",
    ]);
  });

  test("a partial name narrows the list, whatever its case or leading space", () => {
    expect(completeLine(state, ALICE, "/r")).toEqual(["/roll "]);
    expect(completeLine(state, ALICE, "  /RO")).toEqual(["/roll "]);
    expect(completeLine(state, ALICE, "/n")).toEqual(["/name "]);
    expect(completeLine(state, GM, "/n")).toEqual(["/narrate ", "/name "]);
    expect(completeLine(state, ALICE, "/zz")).toEqual([]);
  });

  test("then the command's arguments", () => {
    expect(completeLine(state, ALICE, "/roll 2")).toEqual(["/roll 2d10"]);
    expect(completeLine(state, ALICE, "/roll d1")).toEqual(["/roll d10", "/roll d100"]);
    expect(completeLine(state, ALICE, "/help ro")).toEqual(["/help roll"]);
    expect(completeLine(state, ALICE, "/help na")).toEqual(["/help name"]);
    expect(completeLine(state, GM, "/help na")).toEqual(["/help narrate", "/help name"]);
  });

  test("nothing for plain text, unknown commands, or commands without a completer", () => {
    expect(completeLine(state, ALICE, "hello")).toEqual([]);
    expect(completeLine(state, ALICE, "/zap x")).toEqual([]);
    expect(completeLine(state, ALICE, "/name V")).toEqual([]);
  });
});

describe("helpText", () => {
  test("a player at a seat sees the commands they can use", () => {
    expect(helpText(ALICE)).toBe(
      [
        "Plain text is chat. Commands start with /, and Tab completes them.",
        "/say <text>      Say something to the table (plain text does the same).",
        "/me <action>     Act something out: /me waves.",
        "/name <name>     Set the name the table calls you.",
        "/roll <dice>     Roll dice: 2d10+3, d20, 3d6-1.",
        "/help [command]  List the commands, or explain one.",
        "/quit            Leave the table.",
      ].join("\n"),
    );
  });

  test("over a one-off ssh command there is no Tab and no seat to leave", () => {
    expect(helpText(ALICE, undefined, "exec")).toBe(
      [
        "Plain text is chat. Commands start with /; roll and help work without it here.",
        "/say <text>      Say something to the table (plain text does the same).",
        "/me <action>     Act something out: /me waves.",
        "/name <name>     Set the name the table calls you.",
        "/roll <dice>     Roll dice: 2d10+3, d20, 3d6-1.",
        "/help [command]  List the commands, or explain one.",
      ].join("\n"),
    );
  });

  test("the GM also sees GM-only commands, marked", () => {
    const lines = helpText(GM).split("\n");
    expect(lines).toContain("/narrate <text>  Describe the scene, with no speaker. (GM)");
    expect(lines).toContain("/state           Show or hide the state pane. (GM)");
  });

  test("one command, by name", () => {
    expect(helpText(ALICE, "roll")).toBe("/roll <dice>  Roll dice: 2d10+3, d20, 3d6-1.");
    expect(helpText(ALICE, "quit")).toBe("/quit  Leave the table.");
    expect(helpText(ALICE, "narrate")).toBe(
      "/narrate <text>  Describe the scene, with no speaker. (GM only)",
    );
    expect(helpText(ALICE, "zap")).toBe("Unknown command /zap. /help lists the commands.");
  });
});

describe("messages that quote what was typed", () => {
  test("are cleaned and cut short", () => {
    expect(parseInputLine("/\x1b[31mzap")).toEqual({
      kind: "refusal",
      message: "Unknown command /zap. /help lists the commands.",
    });
    expect(parseInputLine(`/roll ${"x".repeat(40)}`)).toEqual({
      kind: "refusal",
      message: `"${"x".repeat(23)}…" isn't dice; try 2d10+3, d20 or 3d6-1.`,
    });
  });
});
