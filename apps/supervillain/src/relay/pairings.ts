import { addressBucket, tokenBuckets } from "@supervillain/ssh";
import type { Rate } from "@supervillain/ssh";

import {
	crockford,
	PAIRING_CHARS,
	PAIRING_PREFIX,
	provesClaim,
} from "./protocol.ts";

export interface PairingLimits {
	readonly ttlMs: number;
	readonly live: number;
	readonly perKey: number;
	readonly badCodes: Rate;
	readonly claims: Rate;
}

export const PAIRING_LIMITS: PairingLimits = {
	ttlMs: 15 * 60_000,
	live: 256,
	perKey: 3,
	badCodes: { burst: 5, perSecond: 1 / 60 },
	claims: { burst: 10, perSecond: 1 / 60 },
};

export const PAIRING_BYTES = 13;

interface Pairing {
	readonly handle: string;
	readonly by: string;
	readonly until: number;
}

export type Minted =
	| { readonly kind: "minted"; readonly code: string; readonly until: number }
	| { readonly kind: "refused"; readonly reason: string };

export type Checked = "ok" | "bad" | "slow";

export interface Pairings {
	readonly mint: (
		handle: string,
		by: string,
		bytes: Uint8Array,
		now: number
	) => Minted;
	readonly check: (
		proof: string,
		handle: string,
		fingerprint: string,
		address: string,
		now: number
	) => Checked;
	readonly find: (
		proof: string,
		handle: string,
		fingerprint: string,
		now: number
	) => string | undefined;
	readonly spend: (code: string) => void;
	readonly live: (now: number) => number;
}

export const codeOf = (bytes: Uint8Array): string =>
	`${PAIRING_PREFIX}${crockford(bytes, PAIRING_CHARS)}`;

export const pairingCodes = (
	limits: PairingLimits = PAIRING_LIMITS
): Pairings => {
	const codes = new Map<string, Pairing>();
	const bad = tokenBuckets(limits.badCodes);
	const tries = tokenBuckets(limits.claims);

	const sweep = (now: number) => {
		for (const [code, pairing] of codes) {
			if (pairing.until <= now) {
				codes.delete(code);
			}
		}
	};

	const find = (
		proof: string,
		handle: string,
		fingerprint: string,
		now: number
	): string | undefined => {
		let found: string | undefined;

		for (const [code, pairing] of codes) {
			const live = pairing.handle === handle && pairing.until > now;

			if (live && provesClaim(code, fingerprint, proof)) {
				found ??= code;
			}
		}

		return found;
	};

	return {
		mint: (handle, by, bytes, now) => {
			sweep(now);

			if (codes.size >= limits.live) {
				return {
					kind: "refused",
					reason: "the relay holds its most pairing codes; try again later",
				};
			}

			const mine = [...codes.values()].filter((p) => p.by === by).length;

			if (mine >= limits.perKey) {
				return {
					kind: "refused",
					reason: `that key holds ${limits.perKey} live pairing codes already; use one or wait for them to run out`,
				};
			}

			const code = codeOf(bytes);
			const until = now + limits.ttlMs;
			codes.set(code, { handle, by, until });

			return { kind: "minted", code, until };
		},
		check: (proof, handle, fingerprint, address, now) => {
			const bucket = addressBucket(address);

			if (!bad.has(bucket, now) || !tries.take(bucket, now)) {
				return "slow";
			}

			if (find(proof, handle, fingerprint, now) !== undefined) {
				return "ok";
			}

			bad.take(bucket, now);

			return "bad";
		},
		find,
		spend: (code) => {
			codes.delete(code);
		},
		live: (now) => {
			sweep(now);

			return codes.size;
		},
	};
};
