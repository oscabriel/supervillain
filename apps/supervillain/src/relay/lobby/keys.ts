import type { RawSession } from "@supervillain/ssh";
import type { Effect } from "effect";

import {
	CR,
	flushEscape as flushNavEscape,
	isEnter,
	isErase,
	LF,
	LOWER_E,
	LOWER_J,
	LOWER_K,
	movePick,
	navKeyed,
	SLASH,
	SPACE,
	TILDE,
} from "../../chrome/keys.ts";
import type { NavRules, NavState, Side } from "../../chrome/keys.ts";
import { readKeys } from "../../chrome/read.ts";
import type { NavTab } from "../../chrome/tabs.ts";
import { createKey } from "./create.ts";
import type { CreateAsk, CreateForm, CreateKey } from "./create.ts";

const ZERO = 0x30;

const NINE = 0x39;

const HYPHEN = 0x2d;

const DOT = 0x2e;

const UPPER_A = 0x41;

const UPPER_Z = 0x5a;

const LOWER_A = 0x61;

const LOWER_C = 0x63;

const LOWER_Z = 0x7a;

const ADDRESS_LENGTH = 57;

export interface Lobbying extends NavState {
	typed: string;
	create: CreateForm;
}

export const lobbying = (
	create: CreateForm,
	from: { readonly picked: number; readonly said: string | undefined }
): Lobbying => ({
	tab: "tables",
	picked: from.picked,
	editing: false,
	typed: "",
	said: from.said,
	create,
	escape: "no",
	sequence: "",
	afterCr: false,
});

export type CopyWhat = "commands" | "fingerprint";

export type Keyed =
	| { readonly kind: "more" }
	| { readonly kind: "left" }
	| { readonly kind: "chose"; readonly room: string; readonly skip: number }
	| { readonly kind: "named"; readonly name: string; readonly skip: number }
	| { readonly kind: "try"; readonly skip: number }
	| { readonly kind: "ask"; readonly ask: CreateAsk; readonly skip: number }
	| { readonly kind: "copy"; readonly what: CopyWhat; readonly skip: number };

const MORE: Keyed = { kind: "more" };

const LEFT: Keyed = { kind: "left" };

const isDigit = (byte: number) => byte >= ZERO && byte <= NINE;

const isLetter = (byte: number) =>
	(byte >= LOWER_A && byte <= LOWER_Z) || (byte >= UPPER_A && byte <= UPPER_Z);

const switchTab = (state: Lobbying, tab: NavTab) => {
	if (state.tab === tab) {
		return;
	}

	state.tab = tab;
	state.editing = false;
	state.said = undefined;
	state.create = { ...state.create, said: undefined };
};

const createWith = (state: Lobbying, key: CreateKey): CreateAsk | undefined => {
	const stepped = createKey(state.create, key);
	state.create = stepped.form;

	return stepped.ask;
};

const backOut = (state: Lobbying): boolean => {
	if (state.editing) {
		state.editing = false;

		if (state.tab === "tables") {
			state.typed = "";
		}

		state.said = undefined;
		state.create = { ...state.create, said: undefined };

		return true;
	}

	if (state.said !== undefined || state.create.said !== undefined) {
		state.said = undefined;
		state.create = { ...state.create, said: undefined };

		return true;
	}

	return false;
};

const sideways = (state: Lobbying, side: Side): boolean => {
	if (
		state.tab !== "create" ||
		state.create.guest ||
		state.create.step !== "table"
	) {
		return false;
	}

	createWith(state, { kind: side });

	return true;
};

const LOBBY_NAV: NavRules<Lobbying> = { switchTab, backOut, sideways };

export const flushEscape = (state: Lobbying): boolean =>
	flushNavEscape(LOBBY_NAV, state);

const typedName = (state: Lobbying, byte: number) => {
	const starts = state.typed === "" && isLetter(byte);

	const goesOn =
		state.typed !== "" &&
		(isLetter(byte) ||
			isDigit(byte) ||
			byte === HYPHEN ||
			byte === SLASH ||
			byte === DOT);

	if ((starts || goesOn) && state.typed.length < ADDRESS_LENGTH) {
		state.typed += String.fromCodePoint(byte).toLowerCase();
		state.said = undefined;
	}
};

const startTableEdit = (state: Lobbying) => {
	state.editing = true;
	state.typed = "";
	state.said = undefined;
};

const onTablesEdit = (state: Lobbying, byte: number, skip: number): Keyed => {
	if (isEnter(byte)) {
		if (state.typed === "") {
			state.said = "Type your table's name, then Enter.";

			return MORE;
		}

		return { kind: "named", name: state.typed, skip };
	}

	if (isErase(byte)) {
		state.typed = state.typed.slice(0, -1);
		state.said = undefined;
	} else {
		typedName(state, byte);
	}

	return MORE;
};

const onTables = (
	state: Lobbying,
	rooms: ReadonlyArray<string>,
	byte: number,
	skip: number
): Keyed => {
	if (state.editing) {
		return onTablesEdit(state, byte, skip);
	}

	if (byte === SLASH) {
		startTableEdit(state);

		return MORE;
	}

	if (byte === LOWER_J) {
		movePick(state, 1, rooms.length);

		return MORE;
	}

	if (byte === LOWER_K) {
		movePick(state, -1, rooms.length);

		return MORE;
	}

	if (isEnter(byte)) {
		const room = rooms[state.picked];

		if (room !== undefined) {
			return { kind: "chose", room, skip };
		}

		startTableEdit(state);
	}

	return MORE;
};

const onCreateEdit = (state: Lobbying, byte: number, skip: number): Keyed => {
	if (isEnter(byte)) {
		const ask = createWith(state, { kind: "enter" });

		return ask === undefined ? MORE : { kind: "ask", ask, skip };
	}

	if (isErase(byte)) {
		createWith(state, { kind: "back" });
	} else if (byte > SPACE && byte < TILDE) {
		createWith(state, { kind: "char", char: String.fromCodePoint(byte) });
	}

	return MORE;
};

const onCreate = (state: Lobbying, byte: number, skip: number): Keyed => {
	const form = state.create;

	if (form.guest) {
		return MORE;
	}

	if (form.step === "ready") {
		return byte === LOWER_C ? { kind: "copy", what: "commands", skip } : MORE;
	}

	if (state.editing) {
		return onCreateEdit(state, byte, skip);
	}

	if (form.step === "handle") {
		if (form.held !== undefined) {
			if (isEnter(byte)) {
				createWith(state, { kind: "enter" });
				state.editing = true;
			}

			return MORE;
		}

		if (isEnter(byte) || byte === SLASH || byte === LOWER_E) {
			state.editing = true;
			state.create = { ...form, said: undefined };
		}

		return MORE;
	}

	if (byte === SLASH || byte === LOWER_E) {
		state.editing = true;
		state.create = { ...form, said: undefined };

		return MORE;
	}

	if (isEnter(byte)) {
		if (form.table === "") {
			state.editing = true;
			state.create = { ...form, said: undefined };

			return MORE;
		}

		const ask = createWith(state, { kind: "enter" });

		return ask === undefined ? MORE : { kind: "ask", ask, skip };
	}

	return MORE;
};

export const keyed = (
	state: Lobbying,
	rooms: ReadonlyArray<string>,
	chunk: Uint8Array,
	at: number,
	byte: number
): Keyed => {
	const nav = navKeyed(LOBBY_NAV, state, byte, rooms.length);

	if (nav === "quit") {
		return LEFT;
	}

	if (nav === "handled") {
		return MORE;
	}

	const skip = byte === CR && chunk[at + 1] === LF ? at + 2 : at + 1;

	if (state.tab === "tables") {
		return onTables(state, rooms, byte, skip);
	}

	if (state.tab === "create") {
		return onCreate(state, byte, skip);
	}

	if (state.tab === "session") {
		return byte === LOWER_C
			? { kind: "copy", what: "fingerprint", skip }
			: MORE;
	}

	return isEnter(byte) ? { kind: "try", skip } : MORE;
};

export type Picked =
	| { readonly kind: "listed"; readonly room: string }
	| { readonly kind: "named"; readonly name: string }
	| { readonly kind: "try" }
	| { readonly kind: "ask"; readonly ask: CreateAsk }
	| { readonly kind: "copy"; readonly what: CopyWhat }
	| { readonly kind: "left" }
	| { readonly kind: "idle" };

const pickedOf = (step: Keyed): Picked | undefined => {
	if (step.kind === "left") {
		return { kind: "left" };
	}

	if (step.kind === "chose") {
		return { kind: "listed", room: step.room };
	}

	if (step.kind === "named") {
		return { kind: "named", name: step.name };
	}

	if (step.kind === "try") {
		return { kind: "try" };
	}

	if (step.kind === "copy") {
		return { kind: "copy", what: step.what };
	}

	return step.kind === "ask" ? { kind: "ask", ask: step.ask } : undefined;
};

const skipOf = (step: Keyed): number | undefined =>
	step.kind === "more" || step.kind === "left" ? undefined : step.skip;

export const readLobby = (
	session: RawSession,
	rooms: ReadonlyArray<string>,
	idleMs: number,
	state: Lobbying,
	draw: (state: Lobbying) => void,
	redraw: (again: (() => void) | undefined) => void
): Effect.Effect<Picked> =>
	readKeys({
		stream: session.stream,
		state,
		rules: LOBBY_NAV,
		keyed: (chunk, at, byte) => {
			const step = keyed(state, rooms, chunk, at, byte);
			const result = pickedOf(step);

			return result === undefined ? undefined : { result, rest: skipOf(step) };
		},
		ended: { kind: "left" },
		idle: { ms: idleMs, result: { kind: "idle" } },
		draw: () => {
			draw(state);
		},
		redraw,
	});
