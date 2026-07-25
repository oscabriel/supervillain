import {
	BoxRenderable,
	CliRenderEvents,
	InputRenderable,
	InputRenderableEvents,
	TextRenderable,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import type { TerminalConnection } from "@supervillain/session";

import {
	initialLobbyState,
	LOBBY_HINTS,
	LOBBY_TITLES,
	menuActionAt,
	moveMenuIndex,
	noticeLines,
	screenBodyLines,
	toggleRenderTier,
	WORDMARK_TEXT,
} from "./lobby-screens.js";
import type {
	LobbyChromeContext,
	LobbyNotice,
	LobbyState,
} from "./lobby-screens.js";
import type { TableRendererFactory } from "./renderer.js";
import { resolveThemeToken } from "./theme.js";

export type {
	LobbyChromeContext,
	LobbyMenuAction,
	LobbyNotice,
	LobbySettings,
	LobbyState,
} from "./lobby-screens.js";
export {
	LOBBY_MENU,
	OFFLINE_TAGLINE,
	SPLASH_TAGLINE,
	WORDMARK_TEXT,
} from "./lobby-screens.js";

/* Sequencing (recorded per #67): this landed before #62 replaces the Door's
 * hand-rolled ssh2 wiring with `@opentui/ssh`. The lobby is deliberately free
 * of any ssh2 coupling — it takes a `TerminalConnection` and a renderer
 * factory and knows nothing else about the transport — so that port is
 * mechanical: swap what constructs the connection and the factory, not this
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
	/** Supplies the renderer this surface draws on — and with it the decision of
	 * whether a render loop runs at all. */
	readonly createRenderer: TableRendererFactory;
	/** The inline notice the lobby opens with, if the visitor asked for a room
	 * that is unregistered or not live. */
	readonly notice?: LobbyNotice;
}

const NOTICE_TOKEN = {
	"full-room": "muted",
	"offline-room": "muted",
	"unknown-room": "danger",
} as const;

/** Holds the lobby on the connection's terminal and resolves once the visitor
 * picks a room or leaves. One visit per call: the caller drives the loop, so a
 * guest can hop rooms on one minted actor (ADR-0008) without the lobby knowing
 * what a room is. The renderer is released before this resolves, so whatever
 * takes the terminal next can mint its own. */
export const runLobby = async (
	options: LobbyOptions
): Promise<LobbyOutcome> => {
	let finish: (() => void) | undefined;
	// oxlint-disable-next-line promise/avoid-new -- OpenTUI announces teardown through a destroy event.
	const exited = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const renderer = await options.createRenderer(options.connection);
	renderer.on(CliRenderEvents.DESTROY, () => finish?.());

	let state: LobbyState = initialLobbyState(options.notice);
	let outcome: LobbyOutcome = { kind: "leave" };

	const root = new BoxRenderable(renderer, {
		flexDirection: "column",
		height: "100%",
		paddingLeft: 2,
		paddingTop: 1,
		width: "100%",
	});
	const wordmark = new TextRenderable(renderer, {
		content: WORDMARK_TEXT,
		fg: resolveThemeToken("accent"),
		height: 2,
	});
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
		const lines = noticeLines(state.notice, options);
		notice.visible = lines.length > 0;
		notice.height = Math.max(lines.length + 1, 1);
		notice.content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
		notice.fg = resolveThemeToken(
			state.notice === undefined ? "muted" : NOTICE_TOKEN[state.notice.kind]
		);
		title.content = LOBBY_TITLES[state.screen];
		body.content = screenBodyLines(state, options).join("\n");
		hint.content = LOBBY_HINTS[state.screen];
		const joining = state.screen === "join";
		input.visible = joining;
		if (joining) {
			input.focus();
		} else {
			input.blur();
		}
	};

	const teardown = (): void => {
		if (!renderer.isDestroyed) {
			renderer.destroy();
		}
	};
	const leaveWith = (next: LobbyOutcome): void => {
		outcome = next;
		teardown();
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
		const roomName = typeof value === "string" ? value.trim() : "";
		if (roomName === "") {
			return;
		}
		input.value = "";
		leaveWith({ kind: "join", roomName });
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

	renderer.keyInput.on("keypress", (key: KeyEvent) => {
		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			goTo("splash");
			return;
		}
		if (state.screen === "join") {
			// The input owns every other key while the join screen is up.
			return;
		}
		key.preventDefault();
		key.stopPropagation();
		if (state.screen === "splash") {
			handleSplashKey(key.name);
			return;
		}
		if (key.name === "t" && state.screen === "settings") {
			state = {
				...state,
				settings: { renderTier: toggleRenderTier(state.settings.renderTier) },
			};
			draw();
		}
	});

	const unsubscribeResize = options.connection.onResize(({ columns, rows }) =>
		renderer.resize(columns, rows)
	);
	const unsubscribeClose = options.connection.onClose(teardown);
	draw();

	await exited;
	unsubscribeResize();
	unsubscribeClose();
	return outcome;
};
