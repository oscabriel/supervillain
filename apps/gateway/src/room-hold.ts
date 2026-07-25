/**
 * The grace window (ADR-0012, NQ-4 and NQ-6). When the Host pipe dies under a
 * seated player, the session is not dropped and it is not lied to: it holds
 * with an honest notice while the Host redials, and after the window it goes
 * back to the lobby, which owns the offline copy (ADR-0008).
 *
 * Nothing here re-dials anything. The Host redials itself; this only watches
 * which pipe carries the name, because that is the whole live half of
 * registration.
 */

/** ~5 minutes, per NQ-4. A tunable default: the shape is the decision. */
export const GRACE_WINDOW_MS = 5 * 60_000;

/** How often the hold looks at the live half. */
export const GRACE_POLL_MS = 1000;

export const HOST_OFFLINE_NOTICE =
	"The host went offline. Your seat is held while it reconnects.";

/** Why a hold ended. `closed` never appears — a table that simply exited has no
 * end at all, which is how the caller tells a quit from a drop. */
export type RoomHoldEnd = "dropped" | "grace-expired" | "host-returned";

export interface RoomHoldOptions {
	/** The live registration this session sat down on, and a probe for whichever
	 * one carries the name now. Identity comparison is the whole test: a new
	 * object means a new pipe took the name over. */
	readonly attached: unknown;
	readonly live: () => unknown;
	/** Resolves if the fold dropped this seat's view for falling behind. */
	readonly dropped?: Promise<void>;
	readonly graceMs?: number;
	readonly pollMs?: number;
	/** Metadata-only instrumentation (NQ-15): counts, never names or content. */
	readonly onHostDrop?: () => void;
	readonly onGraceExpiry?: () => void;
}

export interface RoomHold {
	readonly onNotice: (listener: (message: string) => void) => () => void;
	readonly until: Promise<void>;
	/** Why the table was ended, or undefined when it ended on its own. */
	readonly end: () => RoomHoldEnd | undefined;
	/** Stops watching. Called when the table exits for any reason. */
	readonly stop: () => void;
}

const unref = (timer: ReturnType<typeof setTimeout>): void => {
	// A watch on a seat should never be the reason a process refuses to exit.
	(timer as { unref?: () => void }).unref?.();
};

export const holdRoom = (options: RoomHoldOptions): RoomHold => {
	const listeners = new Set<(message: string) => void>();
	let release: (() => void) | undefined;
	// oxlint-disable-next-line promise/avoid-new -- the end of a hold is an event, not a promise-returning API.
	const until = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ended: RoomHoldEnd | undefined;
	let offline = false;
	let poll: ReturnType<typeof setInterval> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;

	const stop = (): void => {
		if (poll !== undefined) {
			clearInterval(poll);
			poll = undefined;
		}
		if (deadline !== undefined) {
			clearTimeout(deadline);
			deadline = undefined;
		}
	};

	const finish = (end: RoomHoldEnd): void => {
		if (ended !== undefined) {
			return;
		}
		ended = end;
		stop();
		release?.();
	};

	const notify = (message: string): void => {
		for (const listener of listeners) {
			listener(message);
		}
	};

	const goOffline = (): void => {
		if (offline) {
			return;
		}
		offline = true;
		notify(HOST_OFFLINE_NOTICE);
		options.onHostDrop?.();
		deadline = setTimeout(() => {
			options.onGraceExpiry?.();
			finish("grace-expired");
		}, options.graceMs ?? GRACE_WINDOW_MS);
		unref(deadline);
	};

	const tick = (): void => {
		const current = options.live();
		if (current === options.attached) {
			return;
		}
		if (current === undefined) {
			goOffline();
			return;
		}
		// Another pipe carries the name now: the Host came back (or moved
		// machines). The seat is re-taken from the top, on the new fold.
		finish("host-returned");
	};

	poll = setInterval(tick, options.pollMs ?? GRACE_POLL_MS);
	unref(poll);
	// A view the fold dropped for falling behind ends this seat and nobody
	// else's — the isolation is the point (ADR-0012, NQ-5).
	const watchDropped = async (dropped: Promise<void>): Promise<void> => {
		try {
			await dropped;
		} catch {
			// The signal is the fact; how it arrived changes nothing.
		}
		finish("dropped");
	};
	if (options.dropped !== undefined) {
		void watchDropped(options.dropped);
	}

	return {
		end: () => ended,
		onNotice(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop,
		until,
	};
};
