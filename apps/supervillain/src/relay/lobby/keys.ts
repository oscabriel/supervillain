import type { RawSession } from "@supervillain/ssh";
import { Effect } from "effect";

import { createKey } from "./create.ts";
import type { CreateAsk, CreateForm, CreateKey } from "./create.ts";

export type LobbyTab = "tables" | "try" | "create";

export const TABS: ReadonlyArray<LobbyTab> = ["tables", "try", "create"];

const CTRL_C = 0x03;

const CTRL_D = 0x04;

const BACKSPACE = 0x08;

const TAB = 0x09;

const LF = 0x0a;

const CR = 0x0d;

const ESC = 0x1b;

const SPACE = 0x20;

const TILDE = 0x7e;

const SS3 = 0x4f;

const CSI = 0x5b;

const DEL = 0x7f;

const ZERO = 0x30;

const ONE = 0x31;

const NINE = 0x39;

const HYPHEN = 0x2d;

const SLASH = 0x2f;

const DOT = 0x2e;

const UPPER_A = 0x41;

const UPPER_Z = 0x5a;

const LOWER_A = 0x61;

const LOWER_Z = 0x7a;

const NUMBER_DIGITS = 3;

const ADDRESS_LENGTH = 57;

const FINAL_LOW = 0x40;

const FINAL_HIGH = 0x7e;

export const SEQUENCE_CAP = 32;

const ARROWS: ReadonlyMap<string, 1 | -1> = new Map([
	["[A", -1],
	["OA", -1],
	["[B", 1],
	["OB", 1],
]);

const SIDEWAYS: ReadonlyMap<string, "left" | "right"> = new Map([
	["[C", "right"],
	["OC", "right"],
	["[D", "left"],
	["OD", "left"],
]);

const FUNCTION_TABS: ReadonlyMap<string, LobbyTab> = new Map([
	["OP", "tables"],
	["OQ", "try"],
	["OR", "create"],
	["[11~", "tables"],
	["[12~", "try"],
	["[13~", "create"],
]);

const BACK_TAB = "[Z";

export interface Lobbying {
	tab: LobbyTab;
	picked: number;
	typed: string;
	said: string | undefined;
	create: CreateForm;
	escape: "no" | "esc" | "body";
	sequence: string;
	afterCr: boolean;
}

export const lobbying = (
	create: CreateForm,
	from: { readonly picked: number; readonly said: string | undefined }
): Lobbying => ({
	tab: "tables",
	picked: from.picked,
	typed: "",
	said: from.said,
	create,
	escape: "no",
	sequence: "",
	afterCr: false,
});

export type Keyed =
	| { readonly kind: "more" }
	| { readonly kind: "left" }
	| { readonly kind: "chose"; readonly room: string; readonly skip: number }
	| { readonly kind: "named"; readonly name: string; readonly skip: number }
	| { readonly kind: "try"; readonly skip: number }
	| { readonly kind: "ask"; readonly ask: CreateAsk; readonly skip: number };

const MORE: Keyed = { kind: "more" };

const isDigit = (byte: number) => byte >= ZERO && byte <= NINE;

const isLetter = (byte: number) =>
	(byte >= LOWER_A && byte <= LOWER_Z) || (byte >= UPPER_A && byte <= UPPER_Z);

const isNumber = (typed: string) => /^\d+$/u.test(typed);

export const switchTab = (state: Lobbying, tab: LobbyTab) => {
	if (state.tab === tab) {
		return;
	}

	state.tab = tab;
	state.said = undefined;
	state.create = { ...state.create, said: undefined };
};

const stepTab = (state: Lobbying, by: 1 | -1) => {
	const at = TABS.indexOf(state.tab);
	const next = TABS[(at + by + TABS.length) % TABS.length];

	if (next !== undefined) {
		switchTab(state, next);
	}
};

const moveBy = (state: Lobbying, by: 1 | -1, count: number) => {
	if (count === 0) {
		return;
	}

	state.picked = (state.picked + by + count) % count;
	state.typed = "";
	state.said = undefined;
};

const createWith = (state: Lobbying, key: CreateKey): CreateAsk | undefined => {
	const stepped = createKey(state.create, key);
	state.create = stepped.form;

	return stepped.ask;
};

const sequenced = (state: Lobbying, sequence: string, count: number) => {
	const tab = FUNCTION_TABS.get(sequence);

	if (tab !== undefined) {
		switchTab(state, tab);

		return;
	}

	if (sequence === BACK_TAB) {
		stepTab(state, -1);

		return;
	}

	const by = ARROWS.get(sequence);

	if (by !== undefined && state.tab === "tables") {
		moveBy(state, by, count);

		return;
	}

	const side = SIDEWAYS.get(sequence);

	if (side !== undefined && state.tab === "create") {
		createWith(state, { kind: side });
	}
};

const escaped = (state: Lobbying, byte: number, count: number): boolean => {
	if (state.escape === "esc") {
		if (byte === CSI || byte === SS3) {
			state.escape = "body";
			state.sequence = String.fromCodePoint(byte);

			return true;
		}

		state.escape = "no";
		const alt = TABS[byte - ONE];

		if (alt !== undefined) {
			switchTab(state, alt);

			return true;
		}

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
		sequenced(state, state.sequence, count);
	}

	return true;
};

const entered = (
	state: Lobbying,
	rooms: ReadonlyArray<string>,
	skip: number
): Keyed => {
	if (state.typed !== "" && !isNumber(state.typed)) {
		return { kind: "named", name: state.typed, skip };
	}

	const n = state.typed === "" ? state.picked + 1 : Number(state.typed);
	const room = Number.isInteger(n) && n >= 1 ? rooms[n - 1] : undefined;

	if (room !== undefined) {
		return { kind: "chose", room, skip };
	}

	state.said =
		state.typed === ""
			? "Type your table's name, then Enter."
			: `There's no ${state.typed} on the list.`;
	state.typed = "";

	return MORE;
};

const typedDigit = (state: Lobbying, byte: number, count: number) => {
	state.typed += String.fromCodePoint(byte);
	state.said = undefined;
	const n = Number(state.typed);

	if (n >= 1 && n <= count) {
		state.picked = n - 1;
	}
};

const typedName = (state: Lobbying, byte: number) => {
	state.typed += String.fromCodePoint(byte).toLowerCase();
	state.said = undefined;
};

const typed = (state: Lobbying, byte: number, count: number) => {
	const numbering = state.typed === "" ? count > 0 : isNumber(state.typed);

	if (isDigit(byte) && numbering) {
		if (state.typed.length < NUMBER_DIGITS) {
			typedDigit(state, byte, count);
		}

		return;
	}

	const naming = state.typed !== "" && !isNumber(state.typed);
	const starts = state.typed === "" && isLetter(byte);

	const goesOn =
		naming &&
		(isLetter(byte) ||
			isDigit(byte) ||
			byte === HYPHEN ||
			byte === SLASH ||
			byte === DOT);

	if ((starts || goesOn) && state.typed.length < ADDRESS_LENGTH) {
		typedName(state, byte);
	}
};

const onTables = (
	state: Lobbying,
	rooms: ReadonlyArray<string>,
	byte: number,
	skip: number
): Keyed => {
	if (byte === CR || byte === LF) {
		return entered(state, rooms, skip);
	}

	if (byte === DEL || byte === BACKSPACE) {
		state.typed = state.typed.slice(0, -1);
	} else {
		typed(state, byte, rooms.length);
	}

	return MORE;
};

const onCreate = (state: Lobbying, byte: number, skip: number): Keyed => {
	if (byte === CR || byte === LF) {
		const ask = createWith(state, { kind: "enter" });

		return ask === undefined ? MORE : { kind: "ask", ask, skip };
	}

	if (byte === DEL || byte === BACKSPACE) {
		createWith(state, { kind: "back" });
	} else if (byte > SPACE && byte < TILDE) {
		createWith(state, { kind: "char", char: String.fromCodePoint(byte) });
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
	const lfOfCrLf = byte === LF && state.afterCr;
	state.afterCr = byte === CR;

	if (byte === CTRL_C || byte === CTRL_D) {
		return { kind: "left" };
	}

	if (escaped(state, byte, rooms.length) || lfOfCrLf) {
		return MORE;
	}

	if (byte === ESC) {
		state.escape = "esc";

		return MORE;
	}

	if (byte === TAB) {
		stepTab(state, 1);

		return MORE;
	}

	const skip = byte === CR && chunk[at + 1] === LF ? at + 2 : at + 1;

	if (state.tab === "tables") {
		return onTables(state, rooms, byte, skip);
	}

	if (state.tab === "create") {
		return onCreate(state, byte, skip);
	}

	return byte === CR || byte === LF ? { kind: "try", skip } : MORE;
};

export type Picked =
	| { readonly kind: "listed"; readonly room: string }
	| { readonly kind: "named"; readonly name: string }
	| { readonly kind: "try" }
	| { readonly kind: "ask"; readonly ask: CreateAsk }
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
): Effect.Effect<Picked> => {
	const show = () => {
		draw(state);
	};

	return Effect.callback((resume) => {
		const { stream } = session;

		const stop = () => {
			clearTimeout(idle);
			redraw(undefined);
			stream.removeListener("data", onData);
			stream.removeListener("end", onEnd);
		};

		const finish = (result: Picked, rest?: Buffer) => {
			stop();
			stream.pause();

			if (rest !== undefined && rest.length > 0) {
				stream.unshift(rest);
			}

			resume(Effect.succeed(result));
		};

		const idleTimer = () =>
			setTimeout(() => {
				finish({ kind: "idle" });
			}, idleMs);

		let idle = idleTimer();

		const onData = (chunk: Buffer) => {
			clearTimeout(idle);
			idle = idleTimer();

			for (const [at, byte] of chunk.entries()) {
				const step = keyed(state, rooms, chunk, at, byte);
				const picked = pickedOf(step);

				if (picked !== undefined) {
					const skip = skipOf(step);

					finish(picked, skip === undefined ? undefined : chunk.subarray(skip));

					return;
				}
			}

			show();
		};

		const onEnd = () => {
			finish({ kind: "left" });
		};

		show();
		redraw(show);
		stream.on("data", onData);
		stream.once("end", onEnd);
		stream.resume();

		return Effect.sync(stop);
	});
};
