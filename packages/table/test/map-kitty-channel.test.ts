/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane suite. */
import { describe, expect, test } from "bun:test";

import {
	bitmapSupportedFor,
	environmentIsMultiplexed,
	rawWriteChannelFor,
} from "../src/map-kitty-channel.js";
import type { MultiplexerEnvironment } from "../src/map-kitty-channel.js";

/** The renderer surface the gate reads, narrowed to just what it touches. */
type CapabilitySource = Parameters<typeof bitmapSupportedFor>[0];

interface FakeChannel {
	isDestroyed?: boolean;
	writeOut?: (chunk: string) => boolean;
}

const rendererWith = (
	kittyGraphics: boolean | null,
	terminalName = "ghostty"
): CapabilitySource =>
	({
		capabilities:
			kittyGraphics === null
				? null
				: {
						kitty_graphics: kittyGraphics,
						terminal: {
							from_xtversion: true,
							name: terminalName,
							version: "1.0.0",
						},
					},
	}) as CapabilitySource;

/** Wraps a plain fake as the channel's renderer: FakeChannel's shape is a subset of CliRenderer's, so one explicit step suffices. */
const asChannel = (
	fake: FakeChannel
): Parameters<typeof rawWriteChannelFor>[0] =>
	fake as Parameters<typeof rawWriteChannelFor>[0];

describe("the multiplexer guard", () => {
	test("tmux and screen environments gate, whatever the terminal", () => {
		const tmux: MultiplexerEnvironment = {
			TMUX: "/tmp/tmux-0/default,1,0",
		};
		const screenTerm: MultiplexerEnvironment = { TERM: "screen-256color" };
		const tmuxProgram: MultiplexerEnvironment = { TERM_PROGRAM: "tmux" };
		expect(environmentIsMultiplexed(tmux)).toBe(true);
		expect(environmentIsMultiplexed(screenTerm)).toBe(true);
		expect(environmentIsMultiplexed(tmuxProgram)).toBe(true);
	});

	test("ordinary terminals and zellij pass", () => {
		const ghostty: MultiplexerEnvironment = { TERM: "xterm-ghostty" };
		const apple: MultiplexerEnvironment = {
			TERM: "xterm-256color",
			TERM_PROGRAM: "Apple_Terminal",
		};
		const zellij: MultiplexerEnvironment = { TERM_PROGRAM: "zellij" };
		expect(environmentIsMultiplexed(ghostty)).toBe(false);
		expect(environmentIsMultiplexed(apple)).toBe(false);
		expect(environmentIsMultiplexed(zellij)).toBe(false);
		expect(environmentIsMultiplexed({})).toBe(false);
	});
});

describe("the capability verdict", () => {
	test("renderer-reported kitty graphics wins, and is required", () => {
		expect(bitmapSupportedFor(rendererWith(true), {})).toBe(true);
		expect(bitmapSupportedFor(rendererWith(false), {})).toBe(false);
		// Capabilities not yet known: silently unsupported — no nag (ADR-0032).
		expect(bitmapSupportedFor(rendererWith(null), {})).toBe(false);
	});

	test("graphics without placeholder support is still a no (ADR-0032's shrunk list)", () => {
		// Konsole speaks classic placements but not Unicode placeholders;
		// iTerm2 is unverified. Both answer XTVERSION, so the renderer-reported
		// name is the gate — no env sniffing.
		expect(bitmapSupportedFor(rendererWith(true, "Konsole"), {})).toBe(false);
		expect(bitmapSupportedFor(rendererWith(true, "iTerm2"), {})).toBe(false);
		expect(bitmapSupportedFor(rendererWith(true, ""), {})).toBe(false);
		expect(bitmapSupportedFor(rendererWith(true, "kitty(0.40.1)"), {})).toBe(
			true
		);
		expect(bitmapSupportedFor(rendererWith(true, "WezTerm"), {})).toBe(true);
		expect(bitmapSupportedFor(rendererWith(true, "ghostty"), {})).toBe(true);
	});

	test("the environment guard overrides even a reported yes", () => {
		const tmux: MultiplexerEnvironment = { TMUX: "/tmp/tmux-0/default" };
		const screen: MultiplexerEnvironment = { TERM: "screen" };
		expect(bitmapSupportedFor(rendererWith(true), tmux)).toBe(false);
		expect(bitmapSupportedFor(rendererWith(true), screen)).toBe(false);
	});
});

describe("the raw-write channel", () => {
	test("routes through the renderer's writeOut while alive, then goes silent", () => {
		const seen: string[] = [];
		let destroyed = false;
		const channel = asChannel({
			get isDestroyed() {
				return destroyed;
			},
			writeOut: (chunk: string) => {
				seen.push(chunk);
				return true;
			},
		});
		rawWriteChannelFor(channel)("apc-bytes");
		destroyed = true;
		rawWriteChannelFor(channel)("leak");
		expect(seen).toEqual(["apc-bytes"]);
	});

	test("a renderer already reporting destroyed never writes", () => {
		const seen: string[] = [];
		const channel = asChannel({
			isDestroyed: true,
			writeOut: (chunk: string) => {
				seen.push(chunk);
				return true;
			},
		});
		rawWriteChannelFor(channel)("leak");
		expect(seen).toEqual([]);
	});

	test("an object without writeOut yields a harmless no-op", () => {
		const bare = asChannel({});
		expect(() => rawWriteChannelFor(bare)("ignored")).not.toThrow();
	});
});
