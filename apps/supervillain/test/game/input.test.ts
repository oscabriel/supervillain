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
    const draw = ["/play ", "/unplay ", "/turn ", "/done", "/pr ", "/dmg ", "/heal ", "/temp "];
    const steel = ["/recover ", "/cond ", "/save ", "/res ", "/surge ", "/token "];
    const map = ["/place ", "/move ", "/dist ", "/push ", "/pull ", "/slide "];
    expect(completeLine(state, ALICE, "/")).toEqual([
      "/say ",
      "/me ",
      "/name ",
      "/roll ",
      ...draw,
      ...steel,
      ...map,
      "/undo ",
      "/redo",
      "/help ",
      "/sheet ",
      "/view ",
      "/quit",
    ]);
    expect(completeLine(state, GM, "/")).toEqual([
      "/say ",
      "/me ",
      "/narrate ",
      "/name ",
      "/roll ",
      "/hero ",
      "/play ",
      "/unplay ",
      "/add ",
      "/start",
      "/first ",
      "/turn ",
      "/done",
      "/round",
      "/end",
      "/rest",
      "/pr ",
      "/dmg ",
      "/heal ",
      "/temp ",
      "/recover ",
      "/cond ",
      "/save ",
      "/res ",
      "/surge ",
      "/malice ",
      "/token ",
      "/victory ",
      "/fs ",
      "/map ",
      "/place ",
      "/move ",
      "/dist ",
      "/push ",
      "/pull ",
      "/slide ",
      "/undo ",
      "/redo",
      "/help ",
      "/sheet ",
      "/state",
      "/view ",
      "/quit",
    ]);
  });

  test("a partial name narrows the list, whatever its case or leading space", () => {
    expect(completeLine(state, ALICE, "/r")).toEqual(["/roll ", "/recover ", "/res ", "/redo"]);
    expect(completeLine(state, ALICE, "  /RO")).toEqual(["/roll "]);
    expect(completeLine(state, ALICE, "/n")).toEqual(["/name "]);
    expect(completeLine(state, GM, "/n")).toEqual(["/narrate ", "/name "]);
    expect(completeLine(state, ALICE, "/zz")).toEqual([]);
    expect(completeLine(state, ALICE, "/u")).toEqual(["/unplay ", "/undo "]);
  });

  test("then the command's arguments", () => {
    expect(completeLine(state, ALICE, "/roll 2")).toEqual(["/roll 2d10"]);
    expect(completeLine(state, ALICE, "/roll d1")).toEqual(["/roll d10", "/roll d100"]);
    expect(completeLine(state, ALICE, "/help ro")).toEqual(["/help roll"]);
    expect(completeLine(state, ALICE, "/help na")).toEqual(["/help name"]);
    expect(completeLine(state, ALICE, "/view f")).toEqual(["/view feed"]);
    expect(completeLine(state, GM, "/help na")).toEqual(["/help narrate", "/help name"]);
  });

  test("nothing for plain text, unknown commands, or commands without a completer", () => {
    expect(completeLine(state, ALICE, "hello")).toEqual([]);
    expect(completeLine(state, ALICE, "/zap x")).toEqual([]);
    expect(completeLine(state, ALICE, "/name V")).toEqual([]);
  });
});

/** The Draw Steel commands a player sees in /help, in registry order. */
const PLAYER_DRAW_STEEL = [
  "/play <hero> [player]",
  "                 Play a hero. The GM names a player to give them one.",
  "/unplay [hero]   Stop playing your hero. The GM names any hero to free it.",
  "/turn [who]      Start a turn (your hero's, by default); the turn before ends.",
  "/done            End the current turn: EoT conditions end, save-ends roll a save.",
  "/pr <who> <ability|+N> [edge|bane|edge2|bane2]",
  "                 Power roll: 2d10 + characteristic, with the tier's result.",
  "/dmg <who> <n> [type]",
  "                 Deal damage: temporary Stamina first, after weakness and immunity.",
  "/heal <who> <n>  Regain Stamina, up to max.",
  "/temp <who> <n>  Gain temporary Stamina; it doesn't stack, the larger stays.",
  "/recover <hero> [ally]",
  "                 Spend a Recovery to regain a third of max Stamina; 'ally' while dying.",
  "/cond <who> [-]<condition> [eot|save|end]",
  "                 Set a condition (to end of encounter unless EoT or save ends), or remove it with -.",
  "/save <who> [condition]",
  "                 Roll a save (d10, 6+) against save-ends conditions.",
  "/res <hero> <+N|-N>",
  "                 Gain or spend heroic resource.",
  "/surge <hero> <+N|-N>",
  "                 Gain or spend surges.",
  "/token <+N|-N|reset>",
  "                 Spend hero tokens. The GM adds them, or resets to one per hero.",
  "/place <who> <square>",
  "                 Put a token on the map at a square like c5.",
  "/move <who> <square> [main]",
  "                 Move by the shortest path, up to speed a turn; main to move again with the main action.",
  "/dist <who|square> <who|square>",
  "                 Count the squares between tokens or squares.",
  "/push <who> <n> [from <who>] [to <square>]",
  "                 Push straight away from the source, less stability.",
  "/pull <who> <n> [from <who>] [to <square>]",
  "                 Pull straight toward the source, less stability.",
  "/slide <who> <n> to <square> [from <who>]",
  "                 Slide any way to a square, less stability.",
  "/undo [who]      Take back your latest change within 30 s, unless it rolled; the GM, anyone's.",
  "/redo            Put back what the latest /undo took, with the same dice.",
];

describe("helpText", () => {
  test("a player at a seat sees the commands they can use", () => {
    expect(helpText(ALICE)).toBe(
      [
        "Plain text is chat. Commands start with /, and Tab completes them.",
        "/say <text>      Say something to the table (plain text does the same).",
        "/me <action>     Act something out: /me waves.",
        "/name <name>     Set the name the table calls you.",
        "/roll <dice>     Roll dice: 2d10+3, d20, 3d6-1.",
        ...PLAYER_DRAW_STEEL,
        "/help [command]  List the commands, or explain one.",
        "/sheet <who>     Show a hero's or creature's sheet, to you alone.",
        "/view [map|feed|both|<square|who>]",
        "                 Show the map, the feed or both; alone, show or hide the map; or centre it somewhere.",
        "/quit            Leave the table.",
      ].join("\n"),
    );
  });

  test("over a one-off ssh command there is no Tab and no seat to leave", () => {
    expect(helpText(ALICE, undefined, "exec")).toBe(
      [
        "Plain text is chat. Commands start with /; roll, dist, undo, redo, help and sheet work without it here.",
        "/say <text>      Say something to the table (plain text does the same).",
        "/me <action>     Act something out: /me waves.",
        "/name <name>     Set the name the table calls you.",
        "/roll <dice>     Roll dice: 2d10+3, d20, 3d6-1.",
        ...PLAYER_DRAW_STEEL,
        "/help [command]  List the commands, or explain one.",
        "/sheet <who>     Show a hero's or creature's sheet, to you alone.",
      ].join("\n"),
    );
  });

  test("the GM also sees GM-only commands, marked", () => {
    const lines = helpText(GM).split("\n");
    expect(lines).toContain("/narrate <text>  Describe the scene, with no speaker. (GM)");
    expect(lines).toContain("/state           Show or hide the state pane. (GM)");
    expect(lines).toContain(
      "/start           Start a combat: who picks first, then resources and Malice. (GM)",
    );
    // A usage too long for the column puts its summary on the next line, in the column.
    expect(lines).toContain("/add <monster id> [xN] [as <name>]");
    expect(lines).toContain(
      "                 Add creatures from a stat block; minions form squads of up to 8. (GM)",
    );
  });

  test("one command, by name", () => {
    expect(helpText(ALICE, "roll")).toBe("/roll <dice>  Roll dice: 2d10+3, d20, 3d6-1.");
    expect(helpText(ALICE, "quit")).toBe("/quit  Leave the table.");
    expect(helpText(ALICE, "view", "exec")).toBe("/view works only at a seat.");
    expect(helpText(ALICE, "narrate")).toBe(
      "/narrate <text>  Describe the scene, with no speaker. (GM only)",
    );
    expect(helpText(ALICE, "xyzzy")).toBe("Unknown command /xyzzy. /help lists the commands.");
    expect(helpText(ALICE, "undo")).toBe(
      "/undo [who]  Take back your latest change within 30 s, unless it rolled; the GM, anyone's.",
    );
  });
});

describe("/undo", () => {
  test("goes to the room as a command; the host adds the time", () => {
    expect(parseInputLine("/undo")).toEqual({ kind: "command", command: { type: "undo" } });
    expect(parseInputLine("  /UNDO  ")).toEqual({ kind: "command", command: { type: "undo" } });
    expect(parseInputLine("/undo", "name")).toEqual({ kind: "command", command: { type: "undo" } });
  });

  test("takes at most whose change, as one word; /redo takes nothing", () => {
    expect(parseInputLine("/undo bob")).toEqual({
      kind: "command",
      command: { type: "undo", who: "bob" },
    });
    expect(parseInputLine("/undo bob smith")).toEqual({
      kind: "refusal",
      message: "Usage: /undo [who]",
    });
    expect(parseInputLine("/redo")).toEqual({ kind: "command", command: { type: "redo" } });
    expect(parseInputLine("/redo 2")).toEqual({ kind: "refusal", message: "Usage: /redo" });
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
