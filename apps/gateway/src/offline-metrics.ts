/**
 * The offline tripwire's instrumentation (ADR-0012, NQ-15). The sleeping laptop
 * is the accepted launch gap; these counters are what make reopening hosted
 * authority a decision with data behind it rather than a mood.
 *
 * Counts only, per the logging policy (NQ-11). Nothing here holds a room name,
 * an actor, a payload, or anything else a person typed — four integers is the
 * entire data model, deliberately.
 */

/** More than 1 in 5 join attempts to registered rooms landing on an offline
 * host, over any rolling 30 days, opens option D with data. The line is a
 * deliberate, ADR-adjustable stake — crossing it never auto-builds anything. */
export const OFFLINE_JOIN_TRIPWIRE = 0.2;

export interface OfflineCounts {
	/** Join attempts at names the durable registry knows — the denominator. */
	readonly registeredJoinAttempts: number;
	/** …of those, the ones that found no live Host pipe. */
	readonly offlineJoinAttempts: number;
	/** Hosts that died under a seated player. */
	readonly hostDrops: number;
	/** Held seats the grace window ran out on. */
	readonly graceExpiries: number;
}

export interface OfflineMetrics {
	/** One attempt to sit down at a registered name. */
	readonly recordJoinAttempt: (live: boolean) => void;
	readonly recordHostDrop: () => void;
	readonly recordGraceExpiry: () => void;
	readonly counts: () => OfflineCounts;
	/** The tripwire's ratio; 0 when nobody has tried to join yet. */
	readonly offlineJoinRate: () => number;
}

export const createOfflineMetrics = (): OfflineMetrics => {
	const counts = {
		graceExpiries: 0,
		hostDrops: 0,
		offlineJoinAttempts: 0,
		registeredJoinAttempts: 0,
	};
	return {
		counts: () => ({ ...counts }),
		offlineJoinRate: () =>
			counts.registeredJoinAttempts === 0
				? 0
				: counts.offlineJoinAttempts / counts.registeredJoinAttempts,
		recordGraceExpiry() {
			counts.graceExpiries += 1;
		},
		recordHostDrop() {
			counts.hostDrops += 1;
		},
		recordJoinAttempt(live) {
			counts.registeredJoinAttempts += 1;
			if (!live) {
				counts.offlineJoinAttempts += 1;
			}
		},
	};
};
