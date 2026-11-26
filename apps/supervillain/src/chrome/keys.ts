import { NAV_TABS } from "./tabs.ts";
import type { NavTab } from "./tabs.ts";

const CTRL_C = 0x03;

const CTRL_D = 0x04;

const BACKSPACE = 0x08;

const TAB = 0x09;

export const LF = 0x0a;

export const CR = 0x0d;

const ESC = 0x1b;

export const SPACE = 0x20;

export const SLASH = 0x2f;

const ONE = 0x31;

const SS3 = 0x4f;

const CSI = 0x5b;

export const LOWER_E = 0x65;

export const LOWER_J = 0x6a;

export const LOWER_K = 0x6b;

const LOWER_Q = 0x71;

export const TILDE = 0x7e;

const DEL = 0x7f;

const FINAL_LOW = 0x40;

const FINAL_HIGH = 0x7e;

const SEQUENCE_CAP = 32;

export type Side = "left" | "right";

const ARROWS: ReadonlyMap<string, 1 | -1> = new Map([
	["[A", -1],
	["OA", -1],
	["[B", 1],
	["OB", 1],
]);

const SIDEWAYS: ReadonlyMap<string, Side> = new Map([
	["[C", "right"],
	["OC", "right"],
	["[D", "left"],
	["OD", "left"],
]);

const FUNCTION_TABS: ReadonlyMap<string, NavTab> = new Map([
	["OP", "tables"],
	["OQ", "try"],
	["OR", "create"],
	["OS", "session"],
	["[11~", "tables"],
	["[12~", "try"],
	["[13~", "create"],
	["[14~", "session"],
]);

const BACK_TAB = "[Z";

export interface NavState {
	tab: NavTab;
	picked: number;
	editing: boolean;
	said: string | undefined;
	escape: "no" | "esc" | "body";
	sequence: string;
	afterCr: boolean;
}

export interface NavRules<State extends NavState> {
	readonly switchTab: (state: State, tab: NavTab) => void;
	readonly backOut: (state: State) => boolean;
	readonly sideways: (state: State, side: Side) => boolean;
}

export type NavStep = "quit" | "handled" | "typed";

export const isEnter = (byte: number): boolean => byte === CR || byte === LF;

export const isErase = (byte: number): boolean =>
	byte === DEL || byte === BACKSPACE;

export const movePick = (state: NavState, by: 1 | -1, count: number) => {
	if (count === 0) {
		return;
	}

	const total = count + 1;
	state.picked = (state.picked + by + total) % total;
	state.said = undefined;
};

const stepTab = <State extends NavState>(
	rules: NavRules<State>,
	state: State,
	by: 1 | -1
) => {
	const at = NAV_TABS.indexOf(state.tab);
	const next = NAV_TABS[(at + by + NAV_TABS.length) % NAV_TABS.length];

	if (next !== undefined) {
		rules.switchTab(state, next);
	}
};

export const flushEscape = <State extends NavState>(
	rules: NavRules<State>,
	state: State
): boolean => {
	if (state.escape !== "esc") {
		return false;
	}

	state.escape = "no";

	return rules.backOut(state);
};

const sequenced = <State extends NavState>(
	rules: NavRules<State>,
	state: State,
	count: number
) => {
	const { sequence } = state;
	const tab = FUNCTION_TABS.get(sequence);

	if (tab !== undefined) {
		rules.switchTab(state, tab);

		return;
	}

	if (sequence === BACK_TAB) {
		stepTab(rules, state, -1);

		return;
	}

	const by = ARROWS.get(sequence);

	if (by !== undefined && state.tab === "tables" && !state.editing) {
		movePick(state, by, count);

		return;
	}

	const side = SIDEWAYS.get(sequence);

	if (side === undefined || rules.sideways(state, side) || state.editing) {
		return;
	}

	stepTab(rules, state, side === "right" ? 1 : -1);
};

const escaped = <State extends NavState>(
	rules: NavRules<State>,
	state: State,
	byte: number,
	count: number
): boolean => {
	if (state.escape === "esc") {
		if (byte === CSI || byte === SS3) {
			state.escape = "body";
			state.sequence = String.fromCodePoint(byte);

			return true;
		}

		const alt = NAV_TABS[byte - ONE];

		if (alt !== undefined) {
			state.escape = "no";
			rules.switchTab(state, alt);

			return true;
		}

		flushEscape(rules, state);

		return false;
	}

	if (state.escape === "no") {
		return false;
	}

	if (state.sequence.length >= SEQUENCE_CAP) {
		state.escape = "no";
		state.sequence = "";

		return true;
	}

	state.sequence += String.fromCodePoint(byte);

	if (byte >= FINAL_LOW && byte <= FINAL_HIGH) {
		state.escape = "no";
		sequenced(rules, state, count);
	}

	return true;
};

export const navKeyed = <State extends NavState>(
	rules: NavRules<State>,
	state: State,
	byte: number,
	count: number
): NavStep => {
	const lfOfCrLf = byte === LF && state.afterCr;
	state.afterCr = byte === CR;

	if (byte === CTRL_C || byte === CTRL_D) {
		return "quit";
	}

	if (escaped(rules, state, byte, count) || lfOfCrLf) {
		return "handled";
	}

	if (byte === ESC) {
		state.escape = "esc";

		return "handled";
	}

	if (byte === TAB) {
		stepTab(rules, state, 1);

		return "handled";
	}

	if (state.editing) {
		return "typed";
	}

	if (byte === LOWER_Q) {
		return "quit";
	}

	const tab = NAV_TABS[byte - ONE];

	if (tab === undefined) {
		return "typed";
	}

	rules.switchTab(state, tab);

	return "handled";
};
