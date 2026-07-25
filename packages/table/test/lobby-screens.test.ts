/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import {
	initialLobbyState,
	LOBBY_MENU,
	menuActionAt,
	moveMenuIndex,
	noticeLines,
	OFFLINE_TAGLINE,
	screenBodyLines,
	SPLASH_TAGLINE,
	toggleRenderTier,
} from "../src/lobby-screens.js";
import type {
	LobbyChromeContext,
	LobbyScreenId,
	LobbyState,
} from "../src/lobby-screens.js";

const context: LobbyChromeContext = {
	keyed: false,
	sshHost: "supervillain.app",
};

const screens: readonly LobbyScreenId[] = [
	"splash",
	"join",
	"become-gm",
	"settings",
];

const stateOn = (screen: LobbyScreenId): LobbyState => ({
	...initialLobbyState(),
	screen,
});

describe("lobby menu", () => {
	test("offers join, become a GM, settings and leave", () => {
		expect(LOBBY_MENU.map((item) => item.action)).toEqual([
			"join",
			"become-gm",
			"settings",
			"leave",
		]);
	});

	test("wraps at both ends so a held arrow never dead-ends", () => {
		expect(moveMenuIndex(0, -1)).toBe(LOBBY_MENU.length - 1);
		expect(moveMenuIndex(LOBBY_MENU.length - 1, 1)).toBe(0);
		expect(menuActionAt(0)).toBe("join");
	});

	test("the render tier is a two-state toggle", () => {
		expect(toggleRenderTier("text")).toBe("pixel-glyph");
		expect(toggleRenderTier("pixel-glyph")).toBe("text");
	});
});

describe("inline notices", () => {
	test("preserves the typed name and distinguishes unknown from offline", () => {
		const unknown = noticeLines(
			{ kind: "unknown-room", roomName: "Blood-Moon" },
			context
		).join("\n");
		const offline = noticeLines(
			{ kind: "offline-room", roomName: "Blood-Moon" },
			context
		).join("\n");
		expect(unknown).toContain("Blood-Moon");
		expect(offline).toContain("Blood-Moon");
		expect(unknown).not.toBe(offline);
		expect(unknown).toContain("no table named");
		expect(offline).toContain("isn't live right now");
	});

	test("no notice renders no lines at all", () => {
		expect(noticeLines(undefined, context)).toEqual([]);
	});

	test("the offline beat is the only tagline on the notice", () => {
		expect(
			noticeLines({ kind: "offline-room", roomName: "x" }, context).join("\n")
		).toContain(OFFLINE_TAGLINE);
		const bare = noticeLines(
			{ kind: "offline-room", roomName: "x" },
			{ ...context, taglines: false }
		);
		expect(bare.join("\n")).not.toContain(OFFLINE_TAGLINE);
		expect(bare.join("\n")).toContain("isn't live right now");
	});
});

describe("lobby screens", () => {
	test("the splash marks the selected menu item", () => {
		const lines = screenBodyLines(
			{ ...initialLobbyState(), menuIndex: 2 },
			context
		);
		expect(lines.some((line) => line.startsWith("  > settings"))).toBe(true);
		expect(lines.some((line) => line.startsWith("    join a room"))).toBe(true);
	});

	test("become a GM says the gateway cannot create rooms and names the door", () => {
		const body = screenBodyLines(stateOn("become-gm"), context).join("\n");
		expect(body).toContain("cannot create a room");
		expect(body).toContain("supervillain create");
		expect(body).toContain("ssh <name>@supervillain.app");
		expect(body).toContain("free forever");
	});

	test("settings report the session-local tier and whether a key was seen", () => {
		expect(screenBodyLines(stateOn("settings"), context).join("\n")).toContain(
			"no key"
		);
		expect(
			screenBodyLines(stateOn("settings"), {
				...context,
				keyed: true,
			}).join("\n")
		).toContain("key recognized");
		expect(screenBodyLines(stateOn("settings"), context).join("\n")).toContain(
			"this session only"
		);
	});

	test("every screen still renders with its tagline deleted", () => {
		for (const screen of screens) {
			const withTagline = screenBodyLines(stateOn(screen), context);
			const without = screenBodyLines(stateOn(screen), {
				...context,
				taglines: false,
			});
			expect(without.length).toBeGreaterThan(0);
			expect(without.join("\n").trim()).not.toBe("");
			expect(without.join("\n")).not.toContain(SPLASH_TAGLINE);
			expect(withTagline.length).toBeGreaterThanOrEqual(without.length);
		}
	});

	test("the splash tagline is present by default", () => {
		expect(screenBodyLines(stateOn("splash"), context).join("\n")).toContain(
			SPLASH_TAGLINE
		);
	});
});
