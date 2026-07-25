/** The gateway hardening the lobby inherits immediately rather than eventually
 * (ADR-0008): the lobby is an unauthenticated held session, so idle and max
 * timeouts and a per-IP connection limit apply from the first commit that
 * serves it.
 *
 * The numbers below are floors against squatting, not capacity policy.
 * ADR-0012 pins that no *capacity* cap number and no public capacity claim
 * precedes the R9 benchmark; these are deliberately generous and are
 * configurable per gateway so nothing here reads as a measured limit. */

export interface LobbyLimits {
	/** Close a lobby session that has seen no keystroke for this long. */
	readonly idleMs: number;
	/** Hard ceiling on how long one connection may sit in the lobby, however
	 * busily it types. */
	readonly maxHoldMs: number;
	/** New SSH connections one IP may open per window. */
	readonly connectionsPerWindow: number;
	readonly windowMs: number;
}

export const DEFAULT_LOBBY_LIMITS: LobbyLimits = {
	connectionsPerWindow: 30,
	idleMs: 5 * 60_000,
	maxHoldMs: 30 * 60_000,
	windowMs: 60_000,
};

export type LobbyExpiry = "idle" | "max";

export const LOBBY_EXPIRY_MESSAGE: Readonly<Record<LobbyExpiry, string>> = {
	idle: "the lobby went quiet, so we closed it. ssh back any time.",
	max: "the lobby has a time limit. ssh back any time.",
};

export interface ConnectionRateLimiter {
	/** True when this IP may open another connection right now; recording the
	 * connection is part of admitting it. */
	readonly admit: (ip: string) => boolean;
}

/** A sliding window per IP. Entries are pruned on every call, so an IP that
 * stops connecting stops costing memory. */
export const createConnectionRateLimiter = (options: {
	readonly limits: Pick<LobbyLimits, "connectionsPerWindow" | "windowMs">;
	readonly now?: () => number;
}): ConnectionRateLimiter => {
	const now = options.now ?? (() => Date.now());
	const seen = new Map<string, number[]>();
	const prune = (cutoff: number): void => {
		for (const [ip, stamps] of seen) {
			const kept = stamps.filter((stamp) => stamp > cutoff);
			if (kept.length === 0) {
				seen.delete(ip);
			} else {
				seen.set(ip, kept);
			}
		}
	};
	return {
		admit: (ip) => {
			const at = now();
			prune(at - options.limits.windowMs);
			const stamps = seen.get(ip) ?? [];
			if (stamps.length >= options.limits.connectionsPerWindow) {
				return false;
			}
			stamps.push(at);
			seen.set(ip, stamps);
			return true;
		},
	};
};

export interface LobbyDeadlines {
	/** Arms both timers. Called every time the lobby takes the terminal back. */
	readonly hold: () => void;
	/** Disarms. Called when a room entry takes the terminal — a player sitting at
	 * a table is not squatting in the lobby, and a long game is not an idle one. */
	readonly release: () => void;
	/** Resets the idle timer. Wire this to every byte the client sends. */
	readonly touch: () => void;
}

/** Idle and max deadlines for one connection's time in the lobby. The max
 * deadline is anchored when the connection starts, so hopping in and out of
 * rooms cannot extend it. */
export const createLobbyDeadlines = (options: {
	readonly limits: Pick<LobbyLimits, "idleMs" | "maxHoldMs">;
	readonly onExpire: (reason: LobbyExpiry) => void;
	readonly now?: () => number;
}): LobbyDeadlines => {
	const now = options.now ?? (() => Date.now());
	const expiresAt = now() + options.limits.maxHoldMs;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let maxTimer: ReturnType<typeof setTimeout> | undefined;
	let held = false;
	let fired = false;
	const expire = (reason: LobbyExpiry): void => {
		if (fired) {
			return;
		}
		fired = true;
		clearTimeout(idleTimer);
		clearTimeout(maxTimer);
		held = false;
		options.onExpire(reason);
	};
	const armIdle = (): void => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => expire("idle"), options.limits.idleMs);
		idleTimer.unref?.();
	};
	return {
		hold: () => {
			if (fired) {
				return;
			}
			held = true;
			armIdle();
			clearTimeout(maxTimer);
			maxTimer = setTimeout(
				() => expire("max"),
				Math.max(expiresAt - now(), 0)
			);
			maxTimer.unref?.();
		},
		release: () => {
			held = false;
			clearTimeout(idleTimer);
			clearTimeout(maxTimer);
			idleTimer = undefined;
			maxTimer = undefined;
		},
		touch: () => {
			if (held && !fired) {
				armIdle();
			}
		},
	};
};
