import { describe, expect, test } from "bun:test";
import {
  backspace,
  cancelCompletion,
  clearToStart,
  complete,
  deleteForward,
  deleteWordBack,
  emptyLine,
  historyDown,
  historyUp,
  insert,
  inputWindow,
  intentFor,
  keyAction,
  type KeyLike,
  type LineState,
  modeFor,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  NAME_PROMPT,
  restoreDraft,
  sanitize,
  submitLine,
} from "../../src/table/input.ts";

/** Types `text` into an empty line. */
const typed = (text: string, from: LineState = emptyLine) => insert(from, text);

/** Submits each line in turn, starting from an empty line. */
const sent = (...lines: string[]) =>
  lines.reduce((state, line) => submitLine(insert(state, line)).state, emptyLine);

describe("sanitize", () => {
  test("turns each line break into one space, so pasted words never glue", () => {
    expect(sanitize("roll\nfor\r\ninitiative\rnow")).toBe("roll for initiative now");
  });

  test("drops escape sequences whole: colours, cursor moves, titles and cut-off ones", () => {
    expect(sanitize("\x1b[31mred\x1b[0m \x1b[2Jclear")).toBe("red clear");
    expect(sanitize("a\x1b]0;evil title\x07b")).toBe("ab");
    expect(sanitize("a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
    expect(sanitize("end\x1b[")).toBe("end");
    expect(sanitize("\x9b31mc1\x1b")).toBe("c1");
    expect(sanitize("f\x1bOP1")).toBe("f1");
  });

  test("drops other control bytes, turns a tab into a space, keeps unicode", () => {
    expect(sanitize("be\x07ll\x00\x7f\x08\x85 x\ty")).toBe("bell x y");
    expect(sanitize("héllo 🐉 世界")).toBe("héllo 🐉 世界");
  });

  test("drops bidirectional overrides that would reorder what others see", () => {
    expect(sanitize("abc\u202edef\u2066g\u2069")).toBe("abcdefg");
  });
});

describe("editing", () => {
  test("inserts at the cursor and moves it past the insertion", () => {
    const s = insert(moveLeft(moveLeft(typed("helo"))), "l");
    expect(s.text).toBe("hello");
    expect(s.cursor).toBe(3);
  });

  test("inserts pasted text sanitised", () => {
    const s = typed("say ");
    expect(insert(s, "two\nlines\x1b[31m!").text).toBe("say two lines!");
  });

  test("backspace and delete remove one character either side of the cursor", () => {
    const s = moveLeft(moveLeft(typed("abcd")));
    expect(backspace(s).text).toBe("acd");
    expect(backspace(s).cursor).toBe(1);
    expect(deleteForward(s).text).toBe("abd");
    expect(deleteForward(s).cursor).toBe(2);
    expect(backspace(moveHome(s)).text).toBe("abcd");
    expect(deleteForward(moveEnd(s)).text).toBe("abcd");
  });

  test("moves by whole characters, so an emoji is one step", () => {
    const s = moveLeft(typed("a🐉"));
    expect(s.cursor).toBe(1);
    expect(backspace(moveRight(s)).text).toBe("a");
    expect(moveRight(moveRight(s)).cursor).toBe(2);
    expect(moveLeft(moveHome(s)).cursor).toBe(0);
  });

  test("Ctrl-W deletes the word before the cursor, Ctrl-U everything before it", () => {
    const s = moveLeft(moveLeft(typed("/dmg goblin 7")));
    expect(deleteWordBack(s).text).toBe("/dmg  7");
    expect(deleteWordBack(typed("/dmg goblin   ")).text).toBe("/dmg ");
    expect(clearToStart(s).text).toBe(" 7");
    expect(clearToStart(s).cursor).toBe(0);
  });
});

describe("refused lines", () => {
  test("a refused line comes back to an empty input, cursor at the end, history kept", () => {
    const { state } = submitLine(typed("/roll fireball"));
    const back = restoreDraft(state, "/roll fireball");
    expect(back.text).toBe("/roll fireball");
    expect(back.cursor).toBe(14);
    expect(back.history).toEqual(["/roll fireball"]);
  });

  test("but never over something typed since", () => {
    const { state } = submitLine(typed("/roll fireball"));
    expect(restoreDraft(insert(state, "hi"), "/roll fireball").text).toBe("hi");
  });
});

describe("draft length", () => {
  test("the line holds at most 2000 characters; the rest of a paste is dropped", () => {
    const full = insert(emptyLine, "x".repeat(2500));
    expect(full.text).toBe("x".repeat(2000));
    expect(full.cursor).toBe(2000);
    expect(insert(full, "y")).toBe(full);
  });
});

describe("submitLine", () => {
  test("returns the trimmed line, clears the input and records history", () => {
    const { state, line } = submitLine(typed("  hello there  "));
    expect(line).toBe("hello there");
    expect(state.text).toBe("");
    expect(state.cursor).toBe(0);
    expect(state.history).toEqual(["hello there"]);
  });

  test("an empty or blank line submits nothing", () => {
    expect(submitLine(typed("   ")).line).toBeUndefined();
    expect(submitLine(typed("   ")).state.history).toEqual([]);
  });

  test("does not record the same line twice in a row", () => {
    expect(sent("a", "a", "b", "a").history).toEqual(["a", "b", "a"]);
  });
});

describe("history", () => {
  test("Up walks back from the newest line, and stops at the oldest", () => {
    const s = sent("one", "two", "three");
    expect(historyUp(s).text).toBe("three");
    expect(historyUp(historyUp(s)).text).toBe("two");
    expect(historyUp(historyUp(historyUp(historyUp(s)))).text).toBe("one");
    expect(historyUp(s).cursor).toBe(5);
  });

  test("Down past the newest line restores the draft you were typing", () => {
    const draft = typed("half a thou", sent("one", "two"));
    const back = historyDown(historyDown(historyUp(historyUp(draft))));
    expect(historyDown(historyUp(historyUp(draft))).text).toBe("two");
    expect(back.text).toBe("half a thou");
    expect(back.cursor).toBe(11);
    expect(historyDown(back).text).toBe("half a thou");
  });

  test("Up with no history keeps the draft", () => {
    expect(historyUp(typed("draft")).text).toBe("draft");
  });

  test("editing a recalled line makes it the draft", () => {
    const edited = insert(historyUp(historyUp(sent("one", "two"))), "!");
    expect(edited.text).toBe("one!");
    expect(historyDown(edited).text).toBe("one!");
    expect(historyUp(edited).text).toBe("two");
    expect(historyDown(historyUp(edited)).text).toBe("one!");
  });

  test("submitting a recalled line sends it and starts a fresh draft", () => {
    const { state, line } = submitLine(historyUp(historyUp(sent("one", "two"))));
    expect(line).toBe("one");
    expect(state.history).toEqual(["one", "two", "one"]);
    expect(historyUp(state).text).toBe("one");
    expect(historyDown(historyUp(state)).text).toBe("");
  });
});

describe("complete", () => {
  /** A fake completer: command names for "/h", and arguments once a command is chosen. */
  const completer = (line: string): ReadonlyArray<string> => {
    if (line === "/h") return ["/help ", "/heal ", "/hide "];
    if (line === "/ro") return ["/roll "];
    if (line === "/help ") return ["/help roll ", "/help name "];
    return [];
  };

  test("a single candidate replaces the line, cursor at the end", () => {
    const s = complete(typed("/ro"), completer);
    expect(s.text).toBe("/roll ");
    expect(s.cursor).toBe(6);
    expect(s.completion).toBeUndefined();
  });

  test("no candidates types a space, so a tab pasted without bracketed paste still parts words", () => {
    expect(complete(typed("line"), completer)).toEqual(typed("line "));
  });

  test("with several candidates, each Tab puts the next one on the line, wrapping round", () => {
    const once = complete(typed("/h"), completer);
    expect(once.text).toBe("/help ");
    expect(once.completion).toEqual({
      candidates: ["/help ", "/heal ", "/hide "],
      index: 0,
      original: "/h",
    });
    const twice = complete(once, completer);
    expect(twice.text).toBe("/heal ");
    expect(twice.cursor).toBe(6);
    expect(complete(complete(twice, completer), completer).text).toBe("/help ");
  });

  test("Shift-Tab walks the candidates backwards", () => {
    expect(complete(typed("/h"), completer, -1).text).toBe("/hide ");
    expect(complete(complete(typed("/h"), completer), completer, -1).text).toBe("/hide ");
  });

  test("typing accepts the candidate, and the next Tab completes from the new line", () => {
    const typedOn = insert(complete(typed("/h"), completer), "r");
    expect(typedOn.text).toBe("/help r");
    expect(typedOn.completion).toBeUndefined();
    const fresh = complete(backspace(typedOn), completer);
    expect(fresh.text).toBe("/help roll ");
  });

  test("Esc while cycling puts back what you had typed", () => {
    const s = cancelCompletion(complete(complete(typed("/h"), completer), completer));
    expect(s.text).toBe("/h");
    expect(s.cursor).toBe(2);
    expect(s.completion).toBeUndefined();
    expect(cancelCompletion(typed("/x"))).toEqual(typed("/x"));
  });

  test("submitting a candidate sends it and ends the cycle", () => {
    const { state, line } = submitLine(complete(typed("/h"), completer));
    expect(line).toBe("/help");
    expect(state.completion).toBeUndefined();
  });
});

describe("name prompt (first ten seconds)", () => {
  test("a seat without a name is asked for one; the GM's seat never is", () => {
    expect(modeFor("key:SHA256:abc", undefined)).toBe("name");
    expect(modeFor("guest:3", undefined)).toBe("name");
    expect(modeFor("key:SHA256:abc", "Alice")).toBe("chat");
    expect(modeFor("gm", undefined)).toBe("chat");
    expect(NAME_PROMPT).toBe("what should the table call you?");
  });

  test("in name mode the line is sent as /name, but commands still work", () => {
    expect(intentFor("Alice Vex", "name")).toEqual({ kind: "send", line: "/name Alice Vex" });
    expect(intentFor("/help", "name")).toEqual({ kind: "send", line: "/help" });
    expect(intentFor("/quit", "name")).toEqual({ kind: "quit" });
  });
});

describe("intentFor", () => {
  test("plain text and other commands go to the host as typed", () => {
    expect(intentFor("hello all", "chat")).toEqual({ kind: "send", line: "hello all" });
    expect(intentFor("/roll 2d10+3", "chat")).toEqual({ kind: "send", line: "/roll 2d10+3" });
    expect(intentFor("/stat", "chat")).toEqual({ kind: "send", line: "/stat" });
  });

  test("/quit leaves and, on the GM's seat, /state toggles the state pane, in any case", () => {
    expect(intentFor("/quit", "chat")).toEqual({ kind: "quit" });
    expect(intentFor("/QUIT", "chat")).toEqual({ kind: "quit" });
    expect(intentFor("/state", "chat", "gm")).toEqual({ kind: "state" });
    expect(intentFor("/State", "chat", "gm")).toEqual({ kind: "state" });
  });

  test("a player's /state goes to the host, which refuses it", () => {
    expect(intentFor("/state", "chat", "key:SHA256:abc")).toEqual({ kind: "send", line: "/state" });
  });
});

describe("keyAction", () => {
  const key = (name: string, more: Partial<KeyLike> = {}): KeyLike => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: name.length === 1 ? name : "",
    ...more,
  });

  test("printable keys insert their text, including space and shifted letters", () => {
    expect(keyAction(key("a"))).toEqual({ kind: "insert", text: "a" });
    expect(keyAction(key("a", { shift: true, sequence: "A" }))).toEqual({
      kind: "insert",
      text: "A",
    });
    expect(keyAction(key("space", { sequence: " " }))).toEqual({ kind: "insert", text: " " });
    expect(keyAction(key("é"))).toEqual({ kind: "insert", text: "é" });
  });

  test("no single letter is a hotkey: every letter types, even q and /", () => {
    for (const letter of ["q", "s", "h", "j", "k", "/", "?"]) {
      expect(keyAction(key(letter))).toEqual({ kind: "insert", text: letter });
    }
  });

  test("named keys map to line actions", () => {
    expect(keyAction(key("return", { sequence: "\r" }))).toEqual({ kind: "submit" });
    expect(keyAction(key("linefeed", { sequence: "\n" }))).toEqual({ kind: "submit" });
    expect(keyAction(key("tab", { sequence: "\t" }))).toEqual({ kind: "complete", step: 1 });
    expect(keyAction(key("tab", { shift: true, sequence: "\x1b[Z" }))).toEqual({
      kind: "complete",
      step: -1,
    });
    expect(keyAction(key("up", { sequence: "\x1b[A" }))).toEqual({ kind: "historyUp" });
    expect(keyAction(key("down", { sequence: "\x1b[B" }))).toEqual({ kind: "historyDown" });
    expect(keyAction(key("pageup", { sequence: "\x1b[5~" }))).toEqual({
      kind: "scroll",
      direction: -1,
    });
    expect(keyAction(key("pagedown", { sequence: "\x1b[6~" }))).toEqual({
      kind: "scroll",
      direction: 1,
    });
    expect(keyAction(key("escape", { sequence: "\x1b" }))).toEqual({ kind: "escape" });
    expect(keyAction(key("c", { ctrl: true, sequence: "\x03" }))).toEqual({ kind: "leave" });
    expect(keyAction(key("backspace", { sequence: "\x7f" }))).toEqual({ kind: "backspace" });
    expect(keyAction(key("delete", { sequence: "\x1b[3~" }))).toEqual({ kind: "delete" });
    expect(keyAction(key("left", { sequence: "\x1b[D" }))).toEqual({ kind: "left" });
    expect(keyAction(key("right", { sequence: "\x1b[C" }))).toEqual({ kind: "right" });
    expect(keyAction(key("home", { sequence: "\x1b[H" }))).toEqual({ kind: "home" });
    expect(keyAction(key("end", { sequence: "\x1b[F" }))).toEqual({ kind: "end" });
    expect(keyAction(key("a", { ctrl: true, sequence: "\x01" }))).toEqual({ kind: "home" });
    expect(keyAction(key("e", { ctrl: true, sequence: "\x05" }))).toEqual({ kind: "end" });
    expect(keyAction(key("w", { ctrl: true, sequence: "\x17" }))).toEqual({ kind: "deleteWord" });
    expect(keyAction(key("backspace", { meta: true, sequence: "\x1b\x7f" }))).toEqual({
      kind: "deleteWord",
    });
    expect(keyAction(key("u", { ctrl: true, sequence: "\x15" }))).toEqual({ kind: "clearToStart" });
  });

  test("other control and escape keys never reach the line", () => {
    expect(keyAction(key("f1", { sequence: "\x1bOP" }))).toEqual({ kind: "none" });
    expect(keyAction(key("x", { ctrl: true, sequence: "\x18" }))).toEqual({ kind: "none" });
    expect(keyAction(key("x", { meta: true, sequence: "\x1bx" }))).toEqual({ kind: "none" });
    expect(keyAction(key("insert", { sequence: "\x1b[2~" }))).toEqual({ kind: "none" });
  });
});

describe("inputWindow", () => {
  test("a line that fits shows whole, with the cursor cell after the text", () => {
    expect(inputWindow("hello", 5, 10)).toEqual({ before: "hello", at: " ", after: "" });
    expect(inputWindow("hello", 1, 10)).toEqual({ before: "h", at: "e", after: "llo" });
  });

  test("a long line scrolls to keep the cursor in view, never wider than the room", () => {
    expect(inputWindow("abcdefghij", 10, 5)).toEqual({ before: "ghij", at: " ", after: "" });
    expect(inputWindow("abcdefghij", 0, 5)).toEqual({ before: "", at: "a", after: "bcde" });
    expect(inputWindow("abcdefghij", 7, 5)).toEqual({ before: "defg", at: "h", after: "" });
  });

  test("wide characters take two cells each, so fewer of them fit", () => {
    expect(inputWindow("漢字漢字漢字", 6, 5)).toEqual({ before: "漢字", at: " ", after: "" });
    expect(inputWindow("漢字漢字漢字", 0, 5)).toEqual({ before: "", at: "漢", after: "字" });
    expect(inputWindow("ab漢字", 4, 6)).toEqual({ before: "b漢字", at: " ", after: "" });
  });
});
