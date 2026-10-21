/**
 * The input line, as pure data: editing, history with a kept draft, Tab-completion cycling,
 * paste sanitising and the first-run name prompt. The App maps keys to these functions and
 * renders the result; nothing here touches OpenTUI.
 */

// ECMA-48 sequences in ESC and C1 form: a control sequence through its final byte, a control
// string (OSC, DCS, SOS, PM, APC) through BEL or ST, a single shift (SS3, as F1 sends) with its
// character, and any other escape through its final byte.
// A cut-off sequence ends at the first byte that cannot continue it, so it goes too.
const ESCAPE_SEQUENCE =
  // oxlint-disable-next-line no-control-regex -- matching control bytes is the point
  /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|(?:\x1b[P\]X^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1bO|\x8f)[\x20-\x7e]?|\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
const LINE_BREAK = /\r\n|\r|\n/g;
const CONTROL = /\p{Cc}/gu;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Makes raw keyboard or paste text safe for the line: escape sequences go whole, each line
 * break and tab becomes a space (pasted words never glue), and other control characters go.
 */
export function sanitize(raw: string): string {
  return raw
    .replace(ESCAPE_SEQUENCE, "")
    .replace(LINE_BREAK, " ")
    .replaceAll("\t", " ")
    .replace(CONTROL, "")
    .replace(BIDI_CONTROL, "");
}

const HISTORY_LIMIT = 200;
/** A little over the longest chat line the rules take, so an overlong one is refused, not cut. */
export const DRAFT_MAX = 2000;

/** The GM's actor id: the seat that is never asked its name and alone opens the state pane. */
const GM = "gm";

/** The input line: its text, the cursor (in characters), and the history walk. */
export interface LineState {
  readonly text: string;
  /** Cursor position in characters (code points), 0..length. */
  readonly cursor: number;
  /** Submitted lines, oldest first. */
  readonly history: ReadonlyArray<string>;
  /** The history entry on the line while walking it; undefined while editing the draft. */
  readonly recall: number | undefined;
  /** What was being typed when the history walk began; Down past the newest restores it. */
  readonly draft: string;
  /** The Tab cycle in progress, if the line still shows one of its candidates. */
  readonly completion: Completion | undefined;
}

/** A Tab cycle: the candidates for `original`, and which one is on the line. */
export interface Completion {
  readonly original: string;
  readonly candidates: ReadonlyArray<string>;
  readonly index: number;
}

export const emptyLine: LineState = {
  text: "",
  cursor: 0,
  history: [],
  recall: undefined,
  draft: "",
  completion: undefined,
};

const chars = (text: string) => Array.from(text);

/** Every edit makes the line the draft: walking history again starts from the newest entry. */
const edited = (s: LineState, text: string, cursor: number): LineState => ({
  ...s,
  text,
  cursor,
  recall: undefined,
  completion: undefined,
});

/** Shows `text` with the cursor at its end, keeping the history walk. */
const showing = (s: LineState, text: string, recall: number | undefined): LineState => ({
  ...s,
  text,
  cursor: chars(text).length,
  recall,
  completion: undefined,
});

/** Replaces the whole line as an edit, cursor at the end. */
const replaced = (s: LineState, text: string): LineState => edited(s, text, chars(text).length);

/** Inserts raw text (typed or pasted) at the cursor, sanitised first, up to DRAFT_MAX characters. */
export function insert(s: LineState, raw: string): LineState {
  const cs = chars(s.text);
  const add = chars(sanitize(raw)).slice(0, Math.max(0, DRAFT_MAX - cs.length));
  if (add.length === 0) return s;
  cs.splice(s.cursor, 0, ...add);
  return edited(s, cs.join(""), s.cursor + add.length);
}

export function backspace(s: LineState): LineState {
  if (s.cursor === 0) return s;
  const cs = chars(s.text);
  cs.splice(s.cursor - 1, 1);
  return edited(s, cs.join(""), s.cursor - 1);
}

export function deleteForward(s: LineState): LineState {
  const cs = chars(s.text);
  if (s.cursor >= cs.length) return s;
  cs.splice(s.cursor, 1);
  return edited(s, cs.join(""), s.cursor);
}

/** Ctrl-W: deletes back over spaces, then over the word before them. */
export function deleteWordBack(s: LineState): LineState {
  const cs = chars(s.text);
  let start = s.cursor;
  while (start > 0 && cs[start - 1] === " ") start--;
  while (start > 0 && cs[start - 1] !== " ") start--;
  if (start === s.cursor) return s;
  cs.splice(start, s.cursor - start);
  return edited(s, cs.join(""), start);
}

/** Ctrl-U: deletes everything before the cursor. */
export function clearToStart(s: LineState): LineState {
  if (s.cursor === 0) return s;
  return edited(s, chars(s.text).slice(s.cursor).join(""), 0);
}

export const moveLeft = (s: LineState): LineState => ({ ...s, cursor: Math.max(0, s.cursor - 1) });

export const moveRight = (s: LineState): LineState => ({
  ...s,
  cursor: Math.min(chars(s.text).length, s.cursor + 1),
});

export const moveHome = (s: LineState): LineState => ({ ...s, cursor: 0 });

export const moveEnd = (s: LineState): LineState => ({ ...s, cursor: chars(s.text).length });

/** Up: the previous history entry. The first step keeps what you were typing as the draft. */
export function historyUp(s: LineState): LineState {
  if (s.history.length === 0) return s;
  if (s.recall === undefined) {
    const recall = s.history.length - 1;
    return { ...showing(s, s.history[recall]!, recall), draft: s.text };
  }
  const recall = Math.max(0, s.recall - 1);
  return showing(s, s.history[recall]!, recall);
}

/** Down: the next history entry, and past the newest, the draft. */
export function historyDown(s: LineState): LineState {
  if (s.recall === undefined) return s;
  if (s.recall < s.history.length - 1) return showing(s, s.history[s.recall + 1]!, s.recall + 1);
  return showing(s, s.draft, undefined);
}

/**
 * Tab (step 1) or Shift-Tab (step -1). A single candidate replaces the line; with several,
 * each press puts the next one on the line, from the list made for what you had typed. With
 * none, Tab types a space: a terminal without bracketed paste sends a pasted tab as Tab.
 */
export function complete(
  s: LineState,
  completer: (line: string) => ReadonlyArray<string>,
  step: 1 | -1 = 1,
): LineState {
  const cycle = s.completion;
  if (cycle && cycle.candidates[cycle.index] === s.text) {
    const n = cycle.candidates.length;
    const index = (cycle.index + step + n) % n;
    return { ...replaced(s, cycle.candidates[index]!), completion: { ...cycle, index } };
  }
  const candidates = completer(s.text);
  if (candidates.length === 0) return insert(s, " ");
  if (candidates.length === 1) return replaced(s, candidates[0]!);
  const index = step === 1 ? 0 : candidates.length - 1;
  return {
    ...replaced(s, candidates[index]!),
    completion: { original: s.text, candidates, index },
  };
}

/** Esc during a Tab cycle: back to what you had typed. */
export function cancelCompletion(s: LineState): LineState {
  if (!s.completion) return s;
  return replaced(s, s.completion.original);
}

/** Enter: the trimmed line to send (undefined when blank), and a fresh line with it in history. */
export function submitLine(s: LineState): {
  readonly state: LineState;
  readonly line: string | undefined;
} {
  const line = s.text.trim();
  if (line === "") return { state: s, line: undefined };
  const history =
    s.history.at(-1) === line ? s.history : [...s.history, line].slice(-HISTORY_LIMIT);
  return { state: { ...emptyLine, history }, line };
}

/**
 * After a refusal, puts the sent line back so it can be fixed, unless something has been typed
 * since. History keeps it too.
 */
export function restoreDraft(s: LineState, line: string): LineState {
  return s.text === "" ? replaced(s, line) : s;
}

/** "name" until a player's seat has a display name (ASSESSMENT Q2); the GM's seat is never asked. */
export type Mode = "name" | "chat";

export const NAME_PROMPT = "what should the table call you?";

export const modeFor = (me: string, myName: string | undefined): Mode =>
  myName === undefined && me !== GM ? "name" : "chat";

/** How a seat with a map shares the screen: map and feed both, the map first, or the feed alone. */
export type Layout = "both" | "map" | "feed";

const LAYOUTS: ReadonlyArray<Layout> = ["map", "feed", "both"];

/**
 * What a submitted line does: leave, toggle the debug pane, change the layout, centre the map on a
 * square or token (`/view <square|who>`, as typed), or go to the host.
 */
export type Intent =
  | { readonly kind: "quit" }
  | { readonly kind: "state" }
  /** `toggle` shows or hides the map. */
  | { readonly kind: "view"; readonly layout: Layout | "toggle" }
  | { readonly kind: "focus"; readonly at: string }
  | { readonly kind: "send"; readonly line: string };

/**
 * The table runs /quit and /view itself, and /state on the GM's seat (anyone else's goes to the
 * host, which refuses it). In name mode, a plain line is sent as `/name <line>`.
 */
export function intentFor(line: string, mode: Mode, me = ""): Intent {
  const word = line.split(" ", 1)[0]!.toLowerCase();
  if (word === "/quit") return { kind: "quit" };
  if (word === "/state" && me === GM) return { kind: "state" };
  if (word === "/view") {
    const arg = line.slice(word.length).trim();
    if (arg === "") return { kind: "view", layout: "toggle" };
    const layout = LAYOUTS.find((l) => l === arg.toLowerCase());
    return layout === undefined ? { kind: "focus", at: arg } : { kind: "view", layout };
  }
  if (mode === "name" && !line.startsWith("/")) return { kind: "send", line: `/name ${line}` };
  return { kind: "send", line };
}

/** Completions for the table's own commands, as whole replacement lines like the host's. */
export function tableCompletions(line: string): ReadonlyArray<string> {
  const start = line.trimStart().toLowerCase();
  if (!start.startsWith("/")) return [];
  const space = start.indexOf(" ");
  if (space < 0) return "/view".startsWith(start) ? ["/view "] : [];
  if (start.slice(0, space) !== "/view") return [];
  const arg = start.slice(space + 1).trimStart();
  return LAYOUTS.filter((l) => l.startsWith(arg)).map((l) => `/view ${l}`);
}

/** The parts of an OpenTUI KeyEvent the line reads. */
export interface KeyLike {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly sequence: string;
}

export type KeyAction =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "complete"; readonly step: 1 | -1 }
  | { readonly kind: "scroll"; readonly direction: 1 | -1 }
  | {
      readonly kind:
        | "submit"
        | "historyUp"
        | "historyDown"
        | "escape"
        | "leave"
        | "backspace"
        | "delete"
        | "deleteWord"
        | "clearToStart"
        | "left"
        | "right"
        | "home"
        | "end"
        | "none";
    };

/**
 * Maps a key to what the line does with it. The line always owns the keyboard (Q3): there are
 * no single-letter hotkeys, and only sanitised printable text is ever inserted.
 */
export function keyAction(key: KeyLike): KeyAction {
  if (key.ctrl && !key.meta) {
    switch (key.name) {
      case "c":
        return { kind: "leave" };
      case "a":
        return { kind: "home" };
      case "e":
        return { kind: "end" };
      case "w":
        return { kind: "deleteWord" };
      case "u":
        return { kind: "clearToStart" };
    }
  }
  switch (key.name) {
    case "return":
    case "linefeed":
    case "enter":
      return { kind: "submit" };
    case "tab":
      return { kind: "complete", step: key.shift ? -1 : 1 };
    case "pageup":
      return { kind: "scroll", direction: -1 };
    case "pagedown":
      return { kind: "scroll", direction: 1 };
    case "escape":
      return { kind: "escape" };
    case "backspace":
      return { kind: key.meta || key.ctrl ? "deleteWord" : "backspace" };
  }
  if (key.ctrl || key.meta) return { kind: "none" };
  switch (key.name) {
    case "up":
      return { kind: "historyUp" };
    case "down":
      return { kind: "historyDown" };
    case "delete":
      return { kind: "delete" };
    case "left":
      return { kind: "left" };
    case "right":
      return { kind: "right" };
    case "home":
      return { kind: "home" };
    case "end":
      return { kind: "end" };
  }
  const text = sanitize(key.sequence);
  return text === "" ? { kind: "none" } : { kind: "insert", text };
}

/** Terminal cells a character takes: two for wide ones (CJK, most emoji), as OpenTUI measures. */
const cells = (char: string) => Bun.stringWidth(char);

/**
 * The slice of the line that fits in `width` terminal cells, split around the cursor cell. A long
 * line scrolls so the cursor stays in view.
 */
export function inputWindow(
  text: string,
  cursor: number,
  width: number,
): { readonly before: string; readonly at: string; readonly after: string } {
  const cs = chars(text);
  const room = Math.max(1, width);
  const at = cs[cursor] ?? " ";
  let used = cells(at);
  let start = cursor;
  while (start > 0 && used + cells(cs[start - 1]!) <= room) used += cells(cs[--start]!);
  let end = cursor + 1;
  while (end < cs.length && used + cells(cs[end]!) <= room) used += cells(cs[end++]!);
  return {
    before: cs.slice(start, cursor).join(""),
    at,
    after: cs.slice(cursor + 1, Math.max(cursor + 1, end)).join(""),
  };
}
