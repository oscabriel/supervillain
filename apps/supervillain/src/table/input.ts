import { charsOf, isControl } from "@supervillain/domain";

import { panelOf } from "./panels.ts";
import type { Panel } from "./panels.ts";

const ESC = 0x1b;

const BEL = 0x07;

const CSI = 0x9b;

const ST = 0x9c;

const SS3 = 0x8f;

const STRING_STARTS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

const ESCAPED_STRING_STARTS = new Set(["P", "]", "X", "^", "_"]);

const BIDI_CONTROLS = new Set([0x06_1c, 0x20_0e, 0x20_0f]);

const within = (cp: number, low: number, high: number) =>
	cp >= low && cp <= high;

const codeAt = (cps: ReadonlyArray<string>, at: number) =>
	cps[at]?.codePointAt(0) ?? -1;

const skipWhile = (
	cps: ReadonlyArray<string>,
	start: number,
	low: number,
	high: number
) => {
	let at = start;

	while (within(codeAt(cps, at), low, high)) {
		at += 1;
	}

	return at;
};

const skipOne = (
	cps: ReadonlyArray<string>,
	at: number,
	low: number,
	high: number
) => (within(codeAt(cps, at), low, high) ? at + 1 : at);

const controlSequenceEnd = (cps: ReadonlyArray<string>, at: number) =>
	skipOne(
		cps,
		skipWhile(cps, skipWhile(cps, at, 0x30, 0x3f), 0x20, 0x2f),
		0x40,
		0x7e
	);

const controlStringEnd = (cps: ReadonlyArray<string>, start: number) => {
	let at = start;

	while (at < cps.length && ![BEL, ESC, ST].includes(codeAt(cps, at))) {
		at += 1;
	}

	const end = codeAt(cps, at);

	if (end === BEL || end === ST) {
		return at + 1;
	}

	return end === ESC && cps[at + 1] === "\\" ? at + 2 : at;
};

const singleShiftEnd = (cps: ReadonlyArray<string>, at: number) =>
	skipOne(cps, at, 0x20, 0x7e);

const escapedEnd = (cps: ReadonlyArray<string>, at: number) => {
	const next = cps[at + 1] ?? "";

	if (next === "[") {
		return controlSequenceEnd(cps, at + 2);
	}

	if (ESCAPED_STRING_STARTS.has(next)) {
		return controlStringEnd(cps, at + 2);
	}

	if (next === "O") {
		return singleShiftEnd(cps, at + 2);
	}

	return skipOne(cps, skipWhile(cps, at + 1, 0x20, 0x2f), 0x30, 0x7e);
};

const sequenceEnd = (cps: ReadonlyArray<string>, at: number) => {
	const cp = codeAt(cps, at);

	if (cp === ESC) {
		return escapedEnd(cps, at);
	}

	if (cp === CSI) {
		return controlSequenceEnd(cps, at + 1);
	}

	if (STRING_STARTS.has(cp)) {
		return controlStringEnd(cps, at + 1);
	}

	return cp === SS3 ? singleShiftEnd(cps, at + 1) : at;
};

const withoutSequences = (raw: string) => {
	const cps = charsOf(raw);
	let out = "";
	let at = 0;

	while (at < cps.length) {
		const end = sequenceEnd(cps, at);

		if (end === at) {
			out += cps[at] ?? "";
			at += 1;
		} else {
			at = end;
		}
	}

	return out;
};

const shown = (char: string) => {
	const cp = char.codePointAt(0) ?? -1;

	return (
		!isControl(cp) &&
		!BIDI_CONTROLS.has(cp) &&
		!within(cp, 0x20_2a, 0x20_2e) &&
		!within(cp, 0x20_66, 0x20_69)
	);
};

export const sanitize = (raw: string): string =>
	charsOf(
		withoutSequences(raw)
			.replaceAll("\r\n", " ")
			.replaceAll("\r", " ")
			.replaceAll("\n", " ")
			.replaceAll("\t", " ")
	)
		.filter(shown)
		.join("");

const HISTORY_LIMIT = 200;

const DRAFT_MAX = 2000;

const GM = "gm";

export interface LineState {
	readonly text: string;
	readonly cursor: number;
	readonly history: ReadonlyArray<string>;
	readonly recall: number | undefined;
	readonly draft: string;
	readonly completion: Completion | undefined;
}

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

const chars = charsOf;

const edited = (s: LineState, text: string, cursor: number): LineState => ({
	...s,
	text,
	cursor,
	recall: undefined,
	completion: undefined,
});

const showing = (
	s: LineState,
	text: string,
	recall: number | undefined
): LineState => ({
	...s,
	text,
	cursor: chars(text).length,
	recall,
	completion: undefined,
});

const replaced = (s: LineState, text: string): LineState =>
	edited(s, text, chars(text).length);

export const insert = (s: LineState, raw: string): LineState => {
	const cs = chars(s.text);
	const add = chars(sanitize(raw)).slice(0, Math.max(0, DRAFT_MAX - cs.length));

	if (add.length === 0) {
		return s;
	}

	cs.splice(s.cursor, 0, ...add);

	return edited(s, cs.join(""), s.cursor + add.length);
};

export const insertWord = (s: LineState, word: string): LineState => {
	const before = chars(s.text)[s.cursor - 1];
	const lead = before === undefined || before === " " ? "" : " ";

	return insert(s, `${lead}${word} `);
};

export const backspace = (s: LineState): LineState => {
	if (s.cursor === 0) {
		return s;
	}

	const cs = chars(s.text);
	cs.splice(s.cursor - 1, 1);

	return edited(s, cs.join(""), s.cursor - 1);
};

export const deleteForward = (s: LineState): LineState => {
	const cs = chars(s.text);

	if (s.cursor >= cs.length) {
		return s;
	}

	cs.splice(s.cursor, 1);

	return edited(s, cs.join(""), s.cursor);
};

export const deleteWordBack = (s: LineState): LineState => {
	const cs = chars(s.text);
	let start = s.cursor;

	while (start > 0 && cs[start - 1] === " ") {
		start -= 1;
	}

	while (start > 0 && cs[start - 1] !== " ") {
		start -= 1;
	}

	if (start === s.cursor) {
		return s;
	}

	cs.splice(start, s.cursor - start);

	return edited(s, cs.join(""), start);
};

export const clearToStart = (s: LineState): LineState => {
	if (s.cursor === 0) {
		return s;
	}

	return edited(s, chars(s.text).slice(s.cursor).join(""), 0);
};

export const moveLeft = (s: LineState): LineState => ({
	...s,
	cursor: Math.max(0, s.cursor - 1),
});

export const moveRight = (s: LineState): LineState => ({
	...s,
	cursor: Math.min(chars(s.text).length, s.cursor + 1),
});

export const moveHome = (s: LineState): LineState => ({ ...s, cursor: 0 });

export const moveEnd = (s: LineState): LineState => ({
	...s,
	cursor: chars(s.text).length,
});

export const historyUp = (s: LineState): LineState => {
	if (s.history.length === 0) {
		return s;
	}

	if (s.recall === undefined) {
		const recall = s.history.length - 1;

		return { ...showing(s, s.history[recall] ?? "", recall), draft: s.text };
	}

	const recall = Math.max(0, s.recall - 1);

	return showing(s, s.history[recall] ?? "", recall);
};

export const historyDown = (s: LineState): LineState => {
	if (s.recall === undefined) {
		return s;
	}

	if (s.recall < s.history.length - 1) {
		return showing(s, s.history[s.recall + 1] ?? "", s.recall + 1);
	}

	return showing(s, s.draft, undefined);
};

export const complete = (
	s: LineState,
	completer: (line: string) => ReadonlyArray<string>,
	step: 1 | -1 = 1
): LineState => {
	const cycle = s.completion;

	if (cycle && cycle.candidates[cycle.index] === s.text) {
		const n = cycle.candidates.length;
		const index = (cycle.index + step + n) % n;

		return {
			...replaced(s, cycle.candidates[index] ?? s.text),
			completion: { ...cycle, index },
		};
	}

	const candidates = completer(s.text);

	if (candidates.length === 0) {
		return insert(s, " ");
	}

	const [only] = candidates;

	if (candidates.length === 1 && only !== undefined) {
		return replaced(s, only);
	}

	const index = step === 1 ? 0 : candidates.length - 1;

	return {
		...replaced(s, candidates[index] ?? s.text),
		completion: { original: s.text, candidates, index },
	};
};

export const cancelCompletion = (s: LineState): LineState => {
	if (!s.completion) {
		return s;
	}

	return replaced(s, s.completion.original);
};

export interface Submitted {
	readonly state: LineState;
	readonly line: string | undefined;
}

export const submitLine = (s: LineState): Submitted => {
	const line = s.text.trim();

	if (line === "") {
		return { state: s, line: undefined };
	}

	const history =
		s.history.at(-1) === line
			? s.history
			: [...s.history, line].slice(-HISTORY_LIMIT);

	return { state: { ...emptyLine, history }, line };
};

export const remember = (s: LineState, line: string): LineState => {
	if (s.history.at(-1) === line) {
		return s;
	}

	return { ...s, history: [...s.history, line].slice(-HISTORY_LIMIT) };
};

export const fillLine = (s: LineState, line: string): LineState => {
	const kept = s.text.trim() === "" ? s : remember(s, s.text.trim());

	return replaced(kept, line);
};

export const restoreDraft = (s: LineState, line: string): LineState =>
	s.text === "" ? replaced(s, line) : s;

type Mode = "name" | "chat";

export const NAME_PROMPT = "what should the table call you?";

export const modeFor = (me: string, myName: string | undefined): Mode =>
	myName === undefined && me !== GM ? "name" : "chat";

export type Layout = "both" | "map" | "feed";

const LAYOUTS: ReadonlyArray<Layout> = ["map", "feed", "both"];

export type Look = "text" | "pictures";

const LOOKS: ReadonlyArray<Look> = ["pictures", "text"];

type Intent =
	| { readonly kind: "quit" }
	| { readonly kind: "state" }
	| { readonly kind: "view"; readonly layout: Layout | "toggle" }
	| { readonly kind: "look"; readonly look: Look }
	| { readonly kind: "focus"; readonly at: string }
	| { readonly kind: "mouse"; readonly on: boolean | "toggle" }
	| { readonly kind: "prep" }
	| { readonly kind: "hint"; readonly text: string; readonly again: boolean }
	| { readonly kind: "send"; readonly line: string };

const SLIPS = new Map([
	["help", "/help"],
	["exit", "/quit"],
	["quit", "/quit"],
]);

const slipHint = (line: string, mode: Mode): Intent | undefined => {
	const command = SLIPS.get(line.trim().toLowerCase());

	if (command === undefined) {
		return undefined;
	}

	if (mode === "name") {
		return command === "/help"
			? {
					kind: "hint",
					text: "Type the name the table should call you, then Enter. /help lists the commands; Ctrl-C leaves.",
					again: false,
				}
			: {
					kind: "hint",
					text: `To leave, press Ctrl-C. To be called "${line}", press Enter again.`,
					again: true,
				};
	}

	return {
		kind: "hint",
		text: `Did you mean ${command}? Enter again to say "${line}" to the table.`,
		again: true,
	};
};

export const PREP_IS_GMS =
	"Only the GM prepares the game; /prep opens the GM's prep panel.";

export const intentFor = (
	line: string,
	mode: Mode,
	me = "",
	asked?: string
): Intent => {
	const word = (line.split(" ", 1)[0] ?? "").toLowerCase();
	const slip = line === asked ? undefined : slipHint(line, mode);

	if (slip !== undefined) {
		return slip;
	}

	if (word === "/quit") {
		return { kind: "quit" };
	}

	if (word === "/state" && me === GM) {
		return { kind: "state" };
	}

	if (word === "/prep") {
		return me === GM
			? { kind: "prep" }
			: { kind: "hint", text: PREP_IS_GMS, again: false };
	}

	if (word === "/view") {
		const arg = line.slice(word.length).trim();

		if (arg === "") {
			return { kind: "view", layout: "toggle" };
		}

		const look = LOOKS.find((l) => l === arg.toLowerCase());

		if (look !== undefined) {
			return { kind: "look", look };
		}

		const layout = LAYOUTS.find((l) => l === arg.toLowerCase());

		return layout === undefined
			? { kind: "focus", at: arg }
			: { kind: "view", layout };
	}

	if (word === "/mouse") {
		const arg = line.slice(word.length).trim().toLowerCase();

		if (arg === "") {
			return { kind: "mouse", on: "toggle" };
		}

		if (arg === "on" || arg === "off") {
			return { kind: "mouse", on: arg === "on" };
		}

		return { kind: "hint", text: "Usage: /mouse [on|off]", again: false };
	}

	if (mode === "name" && !line.startsWith("/")) {
		return { kind: "send", line: `/name ${line}` };
	}

	return { kind: "send", line };
};

export const tableCompletions = (line: string): ReadonlyArray<string> => {
	const start = line.trimStart().toLowerCase();

	if (!start.startsWith("/")) {
		return [];
	}

	const space = start.indexOf(" ");

	if (space === -1) {
		return "/view".startsWith(start) ? ["/view "] : [];
	}

	if (start.slice(0, space) !== "/view") {
		return [];
	}

	const arg = start.slice(space + 1).trimStart();

	return [...LAYOUTS, ...LOOKS].flatMap((l) =>
		l.startsWith(arg) ? [`/view ${l}`] : []
	);
};

export interface KeyLike {
	readonly name: string;
	readonly ctrl: boolean;
	readonly meta: boolean;
	readonly shift: boolean;
	readonly sequence: string;
	readonly baseCode?: number | undefined;
}

export type LineEditKind =
	| "historyUp"
	| "historyDown"
	| "backspace"
	| "delete"
	| "deleteWord"
	| "clearToStart"
	| "left"
	| "right"
	| "home"
	| "end";

export type KeyAction =
	| { readonly kind: "insert"; readonly text: string }
	| { readonly kind: "panel"; readonly panel: Panel }
	| { readonly kind: "complete"; readonly step: 1 | -1 }
	| { readonly kind: "scroll"; readonly direction: 1 | -1 }
	| { readonly kind: LineEditKind }
	| { readonly kind: "submit" | "escape" | "leave" | "eof" }
	| { readonly kind: "none" };

const digitOf = (key: KeyLike) => {
	if (/^[1-9]$/u.test(key.name)) {
		return Number(key.name);
	}

	const code = key.baseCode;

	return code !== undefined && code >= 0x31 && code <= 0x39
		? code - 0x30
		: undefined;
};

const panelKey = (key: KeyLike): Panel | undefined => {
	if (!key.meta || key.ctrl) {
		return undefined;
	}

	const digit = digitOf(key);

	return digit === undefined ? undefined : panelOf(digit);
};

const CTRL_ACTIONS = new Map<string, KeyAction>([
	["c", { kind: "leave" }],
	["a", { kind: "home" }],
	["e", { kind: "end" }],
	["w", { kind: "deleteWord" }],
	["u", { kind: "clearToStart" }],
	["d", { kind: "eof" }],
]);

const NAMED_ACTIONS = new Map<string, KeyAction>([
	["return", { kind: "submit" }],
	["linefeed", { kind: "submit" }],
	["enter", { kind: "submit" }],
	["pageup", { kind: "scroll", direction: -1 }],
	["pagedown", { kind: "scroll", direction: 1 }],
	["escape", { kind: "escape" }],
]);

const PLAIN_ACTIONS = new Map<string, KeyAction>([
	["up", { kind: "historyUp" }],
	["down", { kind: "historyDown" }],
	["delete", { kind: "delete" }],
	["left", { kind: "left" }],
	["right", { kind: "right" }],
	["home", { kind: "home" }],
	["end", { kind: "end" }],
]);

const namedAction = (key: KeyLike): KeyAction | undefined => {
	if (key.name === "tab") {
		return { kind: "complete", step: key.shift ? -1 : 1 };
	}

	if (key.name === "backspace") {
		return { kind: key.meta || key.ctrl ? "deleteWord" : "backspace" };
	}

	return NAMED_ACTIONS.get(key.name);
};

const typed = (key: KeyLike): KeyAction => {
	const text = sanitize(key.sequence);

	return text === "" ? { kind: "none" } : { kind: "insert", text };
};

export const keyAction = (key: KeyLike): KeyAction => {
	const ctrl = key.ctrl && !key.meta ? CTRL_ACTIONS.get(key.name) : undefined;

	if (ctrl !== undefined) {
		return ctrl;
	}

	const named = namedAction(key);

	if (named !== undefined) {
		return named;
	}

	const panel = panelKey(key);

	if (panel !== undefined) {
		return { kind: "panel", panel };
	}

	if (key.ctrl || key.meta) {
		return { kind: "none" };
	}

	return PLAIN_ACTIONS.get(key.name) ?? typed(key);
};

const cells = (char: string) => Bun.stringWidth(char);

export interface InputWindow {
	readonly before: string;
	readonly at: string;
	readonly after: string;
}

export const inputWindow = (
	text: string,
	cursor: number,
	width: number
): InputWindow => {
	const cs = chars(text);
	const room = Math.max(1, width);
	const at = cs[cursor] ?? " ";
	const widthAt = (i: number) => cells(cs[i] ?? "");
	let used = cells(at);
	let start = cursor;

	while (start > 0 && used + widthAt(start - 1) <= room) {
		start -= 1;
		used += widthAt(start);
	}

	let end = cursor + 1;

	while (end < cs.length && used + widthAt(end) <= room) {
		used += widthAt(end);
		end += 1;
	}

	return {
		before: cs.slice(start, cursor).join(""),
		at,
		after: cs.slice(cursor + 1, Math.max(cursor + 1, end)).join(""),
	};
};
