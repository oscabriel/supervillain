import {
	BoxRenderable,
	CliRenderEvents,
	InputRenderable,
	InputRenderableEvents,
	TextRenderable,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import type { TerminalConnection } from "@supervillain/session";

import {
	initialLobbyState,
	LOBBY_HINTS,
	LOBBY_TITLES,
	menuActionAt,
	moveMenuIndex,
	noticeLines,
	screenBodyLines,
	WORDMARK_TEXT,
} from "./lobby-screens.js";
import type {
	LobbyChromeContext,
	LobbyNotice,
	LobbyState,
	WhoAmIFacts,
} from "./lobby-screens.js";
import {
	PIXEL_WORDMARK_ROWS,
	PixelWordmarkRenderable,
	wordmarkTierForWidth,
} from "./pixel-wordmark.js";
import { resolveThemeToken } from "./theme.js";

export type {
	LobbyChromeContext,
	LobbyMenuAction,
	LobbyNotice,
	LobbyState,
	WhoAmIFacts,
} from "./lobby-screens.js";
export {
	LOBBY_MENU,
	OFFLINE_TAGLINE,
	SPLASH_TAGLINE,
	WORDMARK_TEXT,
} from "./lobby-screens.js";

/* Sequencing (recorded per #67): this landed before #62 replaces the Door's
 * hand-rolled ssh2 wiring with `@opentui/ssh`. The lobby is deliberately free
 * of any ssh2 coupling — it takes a `TerminalConnection` and a borrowed
 * renderer and knows nothing else about the transport — so that port is
 * mechanical: swap what constructs the connection and the renderer, not this
 * file. */

/** How one visit to the lobby ended. `join` hands a room name back to the
 * caller — the lobby resolves no rooms itself and imports no game package
 * (ADR-0008). `leave` is a quit, a Ctrl+C, or a closed connection. */
export type LobbyOutcome =
	| { readonly kind: "join"; readonly roomName: string }
	| { readonly kind: "leave" };

export interface LobbyOptions extends LobbyChromeContext {
	/** The terminal the lobby holds. No actor: a keyless visitor has none yet. */
	readonly connection: TerminalConnection;
	/** The surface's renderer, borrowed for this visit (ADR-0016). The lobby
	 * adds its renderables, detaches them on the way out, and never destroys
	 * the renderer — its lifetime is the surface's. */
	readonly renderer: CliRenderer;
	/** The inline notice the lobby opens with, if the visitor asked for a room
	 * that is unregistered or not live. */
	readonly notice?: LobbyNotice;
	/** Redeems a device-link code for the key SSH matched. This is deliberately
	 * injected by the gateway: Table renders, while the gateway owns the graph. */
	readonly linkMatchedKey?: (
		code: string
	) => Promise<
		| { readonly accepted: true; readonly whoami: WhoAmIFacts }
		| { readonly rejected: true; readonly message: string }
	>;
	/** An outside deadline that asks this visit to release the borrowed renderer
	 * without closing the underlying terminal. */
	readonly until?: Promise<unknown>;
}

const LOBBY_LEFT_PADDING = 2;
const WORDMARK_GAP_ROWS = 1;

const NOTICE_TOKEN = {
	"dropped-behind": "danger",
	"full-room": "muted",
	"offline-room": "muted",
	"unknown-room": "danger",
} satisfies Readonly<Record<LobbyNotice["kind"], "danger" | "muted">>;

/** Holds the lobby on the connection's terminal and resolves once the visitor
 * picks a room or leaves. One visit per call: the caller drives the loop, so a
 * guest can hop rooms on one minted actor (ADR-0008) without the lobby knowing
 * what a room is. The lobby's renderables are detached before this resolves,
 * so the next screen finds the borrowed renderer clean (ADR-0016). */
export const runLobby = async (
	options: LobbyOptions
): Promise<LobbyOutcome> => {
	const { renderer } = options;
	let finish: (() => void) | undefined;
	// oxlint-disable-next-line promise/avoid-new -- a screen's exit is an event, not a promise-returning API.
	const exited = new Promise<void>((resolve) => {
		finish = resolve;
	});
	// The backstop for exits the lobby does not decide: the surface tearing the
	// session down (or Ctrl+C, which destroys the renderer) must still resolve
	// this visit.
	const onRendererDestroy = (): void => finish?.();
	renderer.on(CliRenderEvents.DESTROY, onRendererDestroy);
	const leaveOnUntil = async (until: Promise<unknown>): Promise<void> => {
		await until;
		finish?.();
	};
	if (options.until !== undefined) {
		void leaveOnUntil(options.until);
	}

	let state: LobbyState = initialLobbyState(options.notice);
	let { whoami } = options;
	let linkNotice = "";
	let linking = false;
	let outcome: LobbyOutcome = { kind: "leave" };

	const root = new BoxRenderable(renderer, {
		flexDirection: "column",
		height: "100%",
		paddingLeft: LOBBY_LEFT_PADDING,
		paddingTop: 1,
		width: "100%",
	});
	const wordmark = new BoxRenderable(renderer, {
		flexDirection: "column",
		height: PIXEL_WORDMARK_ROWS + WORDMARK_GAP_ROWS,
		width: "100%",
	});
	const pixelWordmark = new PixelWordmarkRenderable(renderer);
	const textWordmark = new TextRenderable(renderer, {
		content: WORDMARK_TEXT,
		fg: resolveThemeToken("accent"),
		height: 1 + WORDMARK_GAP_ROWS,
		visible: false,
	});
	wordmark.add(pixelWordmark);
	wordmark.add(textWordmark);
	const notice = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("danger"),
		width: "100%",
	});
	const title = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		height: 2,
	});
	const body = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		flexGrow: 1,
		width: "100%",
	});
	const input = new InputRenderable(renderer, {
		cursorColor: resolveThemeToken("accent"),
		maxLength: 64,
		placeholder: "room name",
		placeholderColor: resolveThemeToken("muted"),
		textColor: resolveThemeToken("primary"),
	});
	const hint = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
	});
	root.add(wordmark);
	root.add(notice);
	root.add(title);
	root.add(body);
	root.add(input);
	root.add(hint);
	renderer.root.add(root);

	const draw = (): void => {
		const wordmarkTier = wordmarkTierForWidth(
			renderer.terminalWidth - LOBBY_LEFT_PADDING
		);
		pixelWordmark.visible = wordmarkTier === "pixel";
		textWordmark.visible = wordmarkTier === "text";
		wordmark.height =
			(wordmarkTier === "pixel" ? PIXEL_WORDMARK_ROWS : 1) + WORDMARK_GAP_ROWS;
		const lines = noticeLines(state.notice, options);
		notice.visible = lines.length > 0;
		notice.height = Math.max(lines.length + 1, 1);
		notice.content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
		notice.fg = resolveThemeToken(
			state.notice === undefined ? "muted" : NOTICE_TOKEN[state.notice.kind]
		);
		title.content = LOBBY_TITLES[state.screen];
		const bodyLines = screenBodyLines(state, { ...options, whoami });
		body.content =
			state.screen === "whoami" && linkNotice !== ""
				? [...bodyLines, "", linkNotice].join("\n")
				: bodyLines.join("\n");
		hint.content = LOBBY_HINTS[state.screen];
		const joining = state.screen === "join";
		const linkingKey =
			state.screen === "whoami" &&
			whoami?.matchedFingerprint !== undefined &&
			options.linkMatchedKey !== undefined;
		input.visible = joining || linkingKey;
		input.placeholder = linkingKey ? "link code" : "room name";
		if (joining || linkingKey) {
			input.focus();
		} else {
			input.blur();
		}
	};

	const leaveWith = (next: LobbyOutcome): void => {
		outcome = next;
		finish?.();
	};
	const goTo = (screen: LobbyState["screen"]): void => {
		state = { ...state, screen };
		draw();
	};

	const activate = (): void => {
		const action = menuActionAt(state.menuIndex);
		if (action === "leave") {
			leaveWith({ kind: "leave" });
			return;
		}
		goTo(action);
	};

	input.on(InputRenderableEvents.ENTER, (value: unknown) => {
		const entered = typeof value === "string" ? value.trim() : "";
		if (entered === "") {
			return;
		}
		input.value = "";
		if (state.screen === "join") {
			leaveWith({ kind: "join", roomName: entered });
			return;
		}
		if (state.screen !== "whoami" || options.linkMatchedKey === undefined) {
			return;
		}
		if (linking) {
			return;
		}
		const { linkMatchedKey } = options;
		linking = true;
		linkNotice = "linking matched key…";
		draw();
		void (async (): Promise<void> => {
			const result = await linkMatchedKey(entered);
			if (result === undefined) {
				return;
			}
			if ("accepted" in result) {
				const { whoami: updated } = result;
				whoami = updated;
				linkNotice = "matched key linked. whoami is updated.";
			} else {
				linkNotice = result.message;
			}
			linking = false;
			draw();
		})();
	});

	const moveMenu = (delta: number): void => {
		state = { ...state, menuIndex: moveMenuIndex(state.menuIndex, delta) };
		draw();
	};

	const handleSplashKey = (name: string): void => {
		if (name === "up" || name === "k") {
			moveMenu(-1);
			return;
		}
		if (name === "down" || name === "j") {
			moveMenu(1);
			return;
		}
		if (name === "return" || name === "enter") {
			activate();
			return;
		}
		if (name === "q") {
			leaveWith({ kind: "leave" });
		}
	};

	const onKeypress = (key: KeyEvent): void => {
		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			goTo("splash");
			return;
		}
		if (
			state.screen === "join" ||
			(state.screen === "whoami" && input.visible)
		) {
			// The input owns every other key while a typed action is up.
			return;
		}
		key.preventDefault();
		key.stopPropagation();
		if (state.screen === "splash") {
			handleSplashKey(key.name);
		}
	};
	renderer.keyInput.on("keypress", onKeypress);

	const unsubscribeResize = options.connection.onResize(({ columns, rows }) => {
		renderer.resize(columns, rows);
		draw();
	});
	const unsubscribeClose = options.connection.onClose(() =>
		leaveWith({ kind: "leave" })
	);
	draw();

	await exited;
	unsubscribeResize();
	unsubscribeClose();
	renderer.keyInput.off("keypress", onKeypress);
	renderer.off(CliRenderEvents.DESTROY, onRendererDestroy);
	// Borrowed, not owned: detach this visit's renderables and hand the
	// renderer back intact. Destroy is idempotent, so a surface that already
	// tore the renderer down costs nothing here.
	root.destroyRecursively();
	return outcome;
};
