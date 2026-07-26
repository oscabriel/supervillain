/** The lobby's copy and screen model, with no renderer anywhere near it.
 * Everything here is a pure function of lobby state, so the screens can be
 * asserted line by line — including the ADR-0008 rule that every screen must
 * still read correctly with its tagline deleted. */

/** The lobby's four screens (ADR-0008): splash, interactive join, the
 * become-a-GM install pitch, and session-local settings. */
export type LobbyScreenId = "splash" | "join" | "become-gm" | "settings";

export type LobbyMenuAction = "join" | "become-gm" | "settings" | "leave";

/** Why the visitor is looking at the lobby instead of a table. The room name is
 * carried verbatim: ADR-0008 requires the typed name preserved in the notice.
 * The kinds are deliberately distinct copy — the name-enumeration
 * disclosure is accepted knowingly (ADR-0008); names were never capability
 * secrets.
 *
 * `full-room` is the at-capacity refusal ADR-0012 (NQ-10) requires: when a Room
 * is carrying as many sessions as the gateway's cap allows, the *next* arrival
 * is turned away here, honestly, and the seats already at that table are never
 * degraded to make space. */
export interface LobbyNotice {
	readonly kind:
		| "unknown-room"
		| "offline-room"
		| "full-room"
		| "dropped-behind";
	readonly roomName: string;
}

export interface LobbyState {
	readonly screen: LobbyScreenId;
	readonly menuIndex: number;
	readonly notice: LobbyNotice | undefined;
}

export interface LobbyChromeContext {
	/** The hostname players are told to ssh to — the summon line, not the bind. */
	readonly sshHost: string;
	/** Whether the visitor arrived with a key. A keyless visitor has no actor at
	 * all in the lobby (ADR-0008: guests are pre-identity), so this is a fact
	 * about the connection, never an identity. */
	readonly keyed: boolean;
	/** Set false to prove the ADR-0008 rule that every screen works with its
	 * tagline deleted. */
	readonly taglines?: boolean;
}

export interface LobbyMenuItem {
	readonly action: LobbyMenuAction;
	readonly label: string;
}

export const LOBBY_MENU: readonly LobbyMenuItem[] = [
	{ action: "join", label: "join a room" },
	{ action: "become-gm", label: "become a GM" },
	{ action: "settings", label: "settings" },
	{ action: "leave", label: "leave" },
];

/** The wordmark, text tier. ADR-0007 pins pixel-glyph as the default render tier
 * with text as a lossless fallback, and the *text tier is the source format* —
 * so the splash ships the text wordmark now and gains the pixel one for free
 * when the glyph atlas lands. ADR-0007 is documentation-only as of this
 * writing: there is no atlas, no rasterizer, and nothing to fall back from. */
export const WORDMARK_TEXT = "S U P E R V I L L A I N";

/** Deadpan beat one of two (ADR-0008). The splash reads fine without it. */
export const SPLASH_TAGLINE =
	"no accounts, no downloads, no browser. we're as surprised as you are.";

/** Deadpan beat two of two (ADR-0008): the offline-table empty state. */
export const OFFLINE_TAGLINE = "GMs sleep. allegedly.";

export const LOBBY_TITLES: Readonly<Record<LobbyScreenId, string>> = {
	"become-gm": "become a GM",
	join: "join a room",
	settings: "settings",
	splash: "the lobby",
};

export const LOBBY_HINTS: Readonly<Record<LobbyScreenId, string>> = {
	"become-gm": "esc to go back",
	join: "enter to join · esc to go back",
	settings: "esc to go back",
	splash: "up/down to move · enter to choose · ctrl-c to leave",
};

export const initialLobbyState = (notice?: LobbyNotice): LobbyState => ({
	menuIndex: 0,
	notice,
	screen: "splash",
});

/** Wraps within the menu so a held arrow key never dead-ends. */
export const moveMenuIndex = (index: number, delta: number): number => {
	const count = LOBBY_MENU.length;
	return (((index + delta) % count) + count) % count;
};

export const menuActionAt = (index: number): LobbyMenuAction =>
	LOBBY_MENU[index]?.action ?? "join";

/** The inline notice, rendered above the full lobby rather than in place of it
 * (ADR-0008: unknown and offline rooms are never a disconnect). */
export const noticeLines = (
	notice: LobbyNotice | undefined,
	context: LobbyChromeContext
): readonly string[] => {
	if (notice === undefined) {
		return [];
	}
	if (notice.kind === "unknown-room") {
		return [`no table named '${notice.roomName}' is registered here.`];
	}
	if (notice.kind === "full-room") {
		return [
			`'${notice.roomName}' is live, but it is carrying as many terminals as`,
			"this gateway will hold. nobody at that table was disturbed to tell you",
			"so. try again in a minute — or run your own gateway, which is free.",
		];
	}
	if (notice.kind === "dropped-behind") {
		return [
			`your terminal fell too far behind '${notice.roomName}' to keep up.`,
			"you are back in the lobby; join again when the connection is ready.",
		];
	}
	const beat = context.taglines === false ? [] : [`  ${OFFLINE_TAGLINE}`];
	return [
		`'${notice.roomName}' is registered here, but its table isn't live right now.`,
		...beat,
	];
};

const splashLines = (
	state: LobbyState,
	context: LobbyChromeContext
): readonly string[] => {
	const menu = LOBBY_MENU.map(
		(item, index) => `  ${index === state.menuIndex ? ">" : " "} ${item.label}`
	);
	const tagline = context.taglines === false ? [] : [SPLASH_TAGLINE, ""];
	return [...tagline, ...menu];
};

const joinLines = (): readonly string[] => [
	"rooms live on the GM's machine, not here.",
	"type the name your GM gave you.",
];

const becomeGmLines = (context: LobbyChromeContext): readonly string[] => [
	"this gateway cannot create a room. room authority lives on the",
	"GM's machine, and that is the whole design: your machine, your",
	"files, free forever.",
	"",
	"  1. install the CLI     github.com/oscabriel/supervillain",
	"  2. create your table   supervillain create <name>",
	`  3. tell your players   ssh <name>@${context.sshHost}`,
	"",
	"the campaign folder is plain text on your disk. moving the folder",
	"is the whole of portability.",
];

const settingsLines = (context: LobbyChromeContext): readonly string[] => [
	`  identity   ${context.keyed ? "key recognized" : "no key — keyless guest"}`,
];

/** The body of one screen: everything between the wordmark and the hint line. */
export const screenBodyLines = (
	state: LobbyState,
	context: LobbyChromeContext
): readonly string[] => {
	if (state.screen === "join") {
		return joinLines();
	}
	if (state.screen === "become-gm") {
		return becomeGmLines(context);
	}
	if (state.screen === "settings") {
		return settingsLines(context);
	}
	return splashLines(state, context);
};
