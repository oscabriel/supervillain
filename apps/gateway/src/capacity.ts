/**
 * The gateway's protective caps (ADR-0012, NQ-10) and the production PTY cap
 * (NQ-14). Every number here is **cost ceiling and abuse protection, not
 * monetization** — outgrowing a cap has a free, first-class exit (run the same
 * binary as your own gateway, posture 2).
 *
 * Two rules the shapes below exist to keep:
 *
 * - **Ops-tunable, never a constant.** An operator sets every one of these from
 *   the environment, so a self-hosted box on different hardware is not stuck
 *   with the numbers our one-box measurement produced.
 * - **Refuse at the lobby, never degrade a live table.** A cap that is reached
 *   turns the *next* arrival away honestly; nothing about the seats already at
 *   the table changes.
 *
 * The defaults are the R9 benchmark's chosen numbers — the measurement, the
 * environment, and the reasoning are in
 * `.agents/benchmarks/2026-07-25-r9-capacity.md`, and `apps/gateway/bench` is
 * the harness that produced them. Re-run it before moving a default.
 */

import type { LobbyLimits } from "./hardening.js";
import { DEFAULT_LOBBY_LIMITS } from "./hardening.js";

/** The size ceiling `@opentui/ssh` itself enforces (NQ-14). The production cap
 * is set *below* this; nothing here may raise it. */
export const PTY_LIBRARY_CEILING = { columns: 500, rows: 200 } as const;

export interface PtySize {
	readonly columns: number;
	readonly rows: number;
}

/** The caps the R9 benchmark gates. Counts and cells; no money anywhere. */
export interface CapacityLimits {
	/** Rooms one identity may have **attached at once**. Durable ownership is
	 * uncapped — a name you claimed stays yours; what is rationed is how many of
	 * your rooms the gateway carries live at the same time. */
	readonly roomsPerIdentity: number;
	/** Sessions one Room may carry at once. The next arrival is refused at the
	 * lobby; the seats already at the table are untouched. */
	readonly sessionsPerRoom: number;
	/** Envelopes one session may fall behind before the fold drops its view —
	 * the per-session output budget of NQ-5. It catches a seat whose *consumer*
	 * is slow. */
	readonly sessionBudget: number;
	/** Bytes one session may leave unread on its own channel before the gateway
	 * closes it. The other half of the same promise: a seat whose *socket* is
	 * slow never lags a fold cursor, it grows a write buffer, and the R9
	 * benchmark measured that growth as unbounded without this. */
	readonly sessionOutputBytes: number;
	/** How long one session's write may sit unflushed before the gateway gives
	 * that seat up. A client that reads *nothing* never grows a buffer — the
	 * renderer's feed waits on each write — so time, not bytes, is what catches
	 * it. */
	readonly sessionStallMs: number;
	/** The rendered PTY size ceiling. A larger terminal gets the capped render
	 * plus an honest notice, never a refusal. */
	readonly pty: PtySize;
}

export const DEFAULT_CAPACITY_LIMITS: CapacityLimits = {
	pty: { columns: 300, rows: 100 },
	roomsPerIdentity: 8,
	sessionBudget: 512,
	sessionOutputBytes: 4 * 1024 * 1024,
	sessionStallMs: 30_000,
	sessionsPerRoom: 32,
};

/** Everything one operator can turn: the capacity caps and the lobby's
 * squatting floors, read from one environment. */
export interface GatewayCapacity {
	readonly limits: CapacityLimits;
	readonly lobby: LobbyLimits;
}

export const DEFAULT_GATEWAY_CAPACITY: GatewayCapacity = {
	limits: DEFAULT_CAPACITY_LIMITS,
	lobby: DEFAULT_LOBBY_LIMITS,
};

/** Every environment variable this module reads, so the usage text and the
 * parser cannot drift apart. */
export const CAPACITY_ENVIRONMENT = [
	"SUPERVILLAIN_GATEWAY_ROOMS_PER_IDENTITY",
	"SUPERVILLAIN_GATEWAY_SESSIONS_PER_ROOM",
	"SUPERVILLAIN_GATEWAY_SESSION_BUDGET",
	"SUPERVILLAIN_GATEWAY_SESSION_OUTPUT_BYTES",
	"SUPERVILLAIN_GATEWAY_SESSION_STALL_MS",
	"SUPERVILLAIN_GATEWAY_PTY_COLUMNS",
	"SUPERVILLAIN_GATEWAY_PTY_ROWS",
	"SUPERVILLAIN_GATEWAY_LOBBY_IDLE_MS",
	"SUPERVILLAIN_GATEWAY_LOBBY_MAX_MS",
	"SUPERVILLAIN_GATEWAY_LOBBY_CONNECTIONS_PER_WINDOW",
	"SUPERVILLAIN_GATEWAY_LOBBY_WINDOW_MS",
] as const;

export type CapacityEnvironment = Readonly<Record<string, string | undefined>>;

/** A cap read from the environment. Anything unparseable is a refusal rather
 * than a silent fall back to the default: an operator who mistyped a ceiling
 * needs to hear about it before the box is carrying tables, and a gateway that
 * quietly ran on a number nobody set is not auditable. */
const readCount = (
	env: CapacityEnvironment,
	name: string,
	fallback: number,
	ceiling?: number
): number => {
	const raw = env[name];
	if (raw === undefined || raw.length === 0) {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name}='${raw}' must be a whole number of 1 or more.`);
	}
	if (ceiling !== undefined && value > ceiling) {
		throw new Error(
			`${name}='${raw}' is above this gateway's ceiling of ${ceiling}.`
		);
	}
	return value;
};

/**
 * Reads the caps an operator set. Throws one honest line naming the variable
 * when a value cannot be used; the caller turns that into an exit, exactly as
 * it does for the TLS posture.
 */
export const capacityFromEnvironment = (
	env: CapacityEnvironment
): GatewayCapacity => ({
	limits: {
		pty: {
			columns: readCount(
				env,
				"SUPERVILLAIN_GATEWAY_PTY_COLUMNS",
				DEFAULT_CAPACITY_LIMITS.pty.columns,
				PTY_LIBRARY_CEILING.columns
			),
			rows: readCount(
				env,
				"SUPERVILLAIN_GATEWAY_PTY_ROWS",
				DEFAULT_CAPACITY_LIMITS.pty.rows,
				PTY_LIBRARY_CEILING.rows
			),
		},
		roomsPerIdentity: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_ROOMS_PER_IDENTITY",
			DEFAULT_CAPACITY_LIMITS.roomsPerIdentity
		),
		sessionBudget: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_SESSION_BUDGET",
			DEFAULT_CAPACITY_LIMITS.sessionBudget
		),
		sessionOutputBytes: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_SESSION_OUTPUT_BYTES",
			DEFAULT_CAPACITY_LIMITS.sessionOutputBytes
		),
		sessionStallMs: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_SESSION_STALL_MS",
			DEFAULT_CAPACITY_LIMITS.sessionStallMs
		),
		sessionsPerRoom: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_SESSIONS_PER_ROOM",
			DEFAULT_CAPACITY_LIMITS.sessionsPerRoom
		),
	},
	lobby: {
		connectionsPerWindow: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_LOBBY_CONNECTIONS_PER_WINDOW",
			DEFAULT_LOBBY_LIMITS.connectionsPerWindow
		),
		idleMs: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_LOBBY_IDLE_MS",
			DEFAULT_LOBBY_LIMITS.idleMs
		),
		maxHoldMs: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_LOBBY_MAX_MS",
			DEFAULT_LOBBY_LIMITS.maxHoldMs
		),
		windowMs: readCount(
			env,
			"SUPERVILLAIN_GATEWAY_LOBBY_WINDOW_MS",
			DEFAULT_LOBBY_LIMITS.windowMs
		),
	},
});

/** The size the gateway will actually render at. Never a refusal: an oversized
 * terminal is a person with a big window, not an attack. */
export const clampPtySize = (size: PtySize, cap: PtySize): PtySize => ({
	columns: Math.min(size.columns, cap.columns),
	rows: Math.min(size.rows, cap.rows),
});

export const isOversizedPty = (size: PtySize, cap: PtySize): boolean =>
	size.columns > cap.columns || size.rows > cap.rows;

/** What an oversized terminal is told, once, before anything is drawn on it.
 * The honesty NQ-14 asks for: the number we render at, said out loud, rather
 * than a window that silently stops at column 300. */
export const oversizedTerminalNotice = (size: PtySize, cap: PtySize): string =>
	[
		"",
		`  your terminal is ${size.columns}x${size.rows}; this gateway renders at most ${cap.columns}x${cap.rows}.`,
		"  you are getting the capped picture — the rest of the window stays blank.",
		"  a smaller window loses nothing.",
		"",
		"  press any key to continue.",
		"",
	].join("\r\n");
