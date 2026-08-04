/**
 * Every battle-map manipulation, as pure functions from an input to an
 * intention. Keyboard-first is the whole point: cursor keys and Enter drive
 * selection and movement, and the typed command line carries the arguments a
 * key cannot (a glyph, a label, a map name). Mouse click reaches the same
 * `moveCursorTo` the arrow keys reach and nothing else — it is additive, and
 * removing it would cost no capability.
 */
import { tokenAt } from "@supervillain/core";
import type {
	BattleMap,
	CoreCommand,
	MapToken,
	PanelKey,
} from "@supervillain/core";

import type { ParsedInput } from "./input.js";
import { moveMapCursor } from "./map.js";
import type { MapCursor } from "./map.js";

/** What a keystroke on the focused map region means. */
export type MapAction =
	| { readonly kind: "cursor"; readonly cursor: MapCursor }
	| { readonly kind: "select"; readonly tokenId: string | null }
	| { readonly kind: "command"; readonly command: CoreCommand }
	| { readonly kind: "toggle-render-mode" }
	| { readonly kind: "notice"; readonly message: string };

export interface MapInteraction {
	readonly map: BattleMap;
	readonly tokens: readonly MapToken[];
	readonly cursor: MapCursor;
	readonly selectedTokenId: string | null;
}

const REMOVE_KEYS: ReadonlySet<string> = new Set(["delete", "x"]);
const SELECT_KEYS: ReadonlySet<string> = new Set(["return", "enter", "space"]);

const selected = (state: MapInteraction): MapToken | undefined =>
	state.tokens.find((token) => token.id === state.selectedTokenId);

/**
 * Enter is the whole verb: with nothing held it picks up the token under the
 * cursor, and with something held it drops it on the cursor. One key, both
 * halves of a move, and no drag anywhere near it.
 */
const enterAction = (state: MapInteraction): MapAction => {
	const held = selected(state);
	if (held !== undefined) {
		return {
			command: {
				id: held.id,
				type: "core.move-token",
				x: state.cursor.x,
				y: state.cursor.y,
			},
			kind: "command",
		};
	}
	const under = tokenAt(state.tokens, state.cursor.x, state.cursor.y);
	return under === null
		? { kind: "notice", message: "No token here to pick up." }
		: { kind: "select", tokenId: under.id };
};

/** What a keystroke means while the map region holds focus, or `null` when the
 * region does not claim the key. */
export const mapKeyAction = (
	state: MapInteraction,
	key: PanelKey
): MapAction | null => {
	const moved = moveMapCursor(state.map, state.cursor, key.name);
	if (moved !== null) {
		return { cursor: moved, kind: "cursor" };
	}
	// Esc only deselects. With nothing held the Map claims no Esc: ADR-0030's
	// key table grants no Esc→Message row (#126) — Tab and click are the paths
	// into Message.
	if (key.name === "escape") {
		return state.selectedTokenId === null
			? null
			: { kind: "select", tokenId: null };
	}
	if (SELECT_KEYS.has(key.name)) {
		return enterAction(state);
	}
	// The pixel↔text toggle (ADR-0007/0021): per-session, keyboard-only, no
	// capability detection — tofu costs exactly this keystroke.
	if (key.name === "t") {
		return { kind: "toggle-render-mode" };
	}
	if (REMOVE_KEYS.has(key.name)) {
		const target =
			selected(state) ?? tokenAt(state.tokens, state.cursor.x, state.cursor.y);
		return target === null || target === undefined
			? { kind: "notice", message: "No token here to remove." }
			: {
					command: { id: target.id, type: "core.remove-token" },
					kind: "command",
				};
	}
	return null;
};

/** The command a parsed map or token line means, or the reason it means none.
 * The cursor supplies the position, so the line never carries coordinates. */
export const mapCommandFor = (
	parsed: Extract<
		ParsedInput,
		{
			kind:
				| "clear-map"
				| "load-map"
				| "place-token"
				| "reglyph-token"
				| "remove-token";
		}
	>,
	state: MapInteraction | null
): { readonly command: CoreCommand } | { readonly message: string } => {
	if (parsed.kind === "load-map") {
		return { command: { name: parsed.name, type: "core.load-map" } };
	}
	if (parsed.kind === "clear-map") {
		return { command: { type: "core.clear-map" } };
	}
	if (state === null) {
		return { message: "No battle map is loaded." };
	}
	if (parsed.kind === "place-token") {
		return {
			command: {
				glyph: parsed.glyph,
				label: parsed.label,
				seatId: parsed.seatId,
				type: "core.place-token",
				x: state.cursor.x,
				y: state.cursor.y,
			},
		};
	}
	const target =
		selected(state) ?? tokenAt(state.tokens, state.cursor.x, state.cursor.y);
	if (target === null || target === undefined) {
		return { message: "Select a token first, or put the cursor on one." };
	}
	if (parsed.kind === "remove-token") {
		return { command: { id: target.id, type: "core.remove-token" } };
	}
	// A re-glyph is a place onto an id already on the surface — ADR-0006 pins
	// the token vocabulary at placed/moved/removed, and this is how the fourth
	// verb rides the three.
	return {
		command: {
			glyph: parsed.glyph,
			id: target.id,
			label: target.label,
			seatId: target.seatId,
			type: "core.place-token",
			x: target.x,
			y: target.y,
		},
	};
};
