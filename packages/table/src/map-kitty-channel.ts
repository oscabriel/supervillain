/**
 * The bitmap tier's renderer-facing half (ADR-0032): the capability verdict,
 * the multiplexer guard, and the guarded raw-write channel. Split from
 * `map-kitty.ts` so the protocol core stays bytes-and-arithmetic only.
 *
 * The verdict is never hand-rolled: OpenTUI at pin `a0b9064` already probes
 * and exposes `capabilities.kitty_graphics`, and its reported multiplexer
 * wins over environment guessing. The multiplexer hard-off is dated policy:
 * a terminal that swallows the probe would print image payloads as literal
 * base64 into the pane — worse than tofu. Reopen when a released tmux
 * carrying kitty graphics reaches mainstream distros.
 */
import type { CliRenderer } from "@opentui/core";

/** The environment signals a non-renderer-reported multiplexer leaves behind. */
export interface MultiplexerEnvironment {
	readonly TERM?: string | undefined;
	readonly TERM_PROGRAM?: string | undefined;
	readonly TMUX?: string | undefined;
}

const MULTIPLEXER_TERM = /\b(?:tmux|screen)\b/u;

/**
 * True when the environment alone betrays an unreleased multiplexer.
 * Gloomberb's `isMultiplexedTerminal` pattern: renderer-reported wins, these
 * variables are consulted only otherwise. Zellij deliberately does not gate
 * here (it passes the protocol through as of 2026-07).
 */
export const environmentIsMultiplexed = (
	env: MultiplexerEnvironment
): boolean =>
	env.TMUX !== undefined ||
	MULTIPLEXER_TERM.test(env.TERM ?? "") ||
	MULTIPLEXER_TERM.test(env.TERM_PROGRAM ?? "");

const neverWrite = (): void => undefined;

/**
 * Whether this session may emit kitty graphics at all: the renderer's own
 * detection says yes, and no multiplexer stands in the way. A failed or
 * absent check is silently false — no nag, no error (ADR-0032).
 */
export const bitmapSupportedFor = (
	renderer: Pick<CliRenderer, "capabilities">,
	env: MultiplexerEnvironment
): boolean =>
	environmentIsMultiplexed(env)
		? false
		: renderer.capabilities?.kitty_graphics === true;

/** What the guarded channel needs of the renderer, cast surface included. */
interface RawWriteSurface {
	isDestroyed?: boolean;
	writeOut?: (chunk: string) => boolean;
}

/**
 * The raw-write channel. OpenTUI ships no public escape hatch for bytes that
 * bypass its frame encoder; its private `writeOut` routes through the same
 * stdout it owns, so we reach it through a structural cast and gate every
 * call on the destroyed flag — the gloomberb pattern, and ADR-0032's
 * recorded plan until OpenTUI ships a public raw-write channel (the delete-
 * the-cast revisit trigger).
 */
export const rawWriteChannelFor = (
	renderer: CliRenderer
): ((data: string) => void) => {
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the double cast IS the recorded plan: OpenTUI's writeOut is private and untyped, so there is no nearer type to preserve. Delete the cast when OpenTUI ships a public raw-write channel.
	const channel = renderer as unknown as RawWriteSurface;
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- duck-typing an unexported private is the whole point of the guard: no method, no channel, no crash.
	if (typeof channel.writeOut !== "function") {
		return neverWrite;
	}
	return (data: string): void => {
		if (channel.isDestroyed === true) {
			return;
		}
		channel.writeOut?.(data);
	};
};
