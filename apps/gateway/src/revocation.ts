/**
 * The SSH door's half of key revocation (ADR-0012, NQ-3; located in the gateway
 * store by ADR-0013).
 *
 * The Host pipe can refuse a retired key outright, because a pipe is a machine
 * talking to a machine. The door cannot: rejecting the publickey method would
 * drop an `ssh` client straight into the keyless guest path, so a retired key
 * would silently become a guest instead of being told anything. So the door
 * accepts the key and then says one honest line and closes — the ADR-0008 floor
 * for everything the lobby's notice vocabulary has no word for.
 */
import type { IdentityDirectory } from "@supervillain/identity";

import type { SessionIdentity } from "./guest.js";

/** What a retired key is told at the door. Distinguishable on purpose from a
 * key the gateway has simply never seen, which is welcome: an unknown key is a
 * perfectly good visitor (ADR-0008), a retired one is not. */
export const REVOKED_DOOR_MESSAGE =
	"this key has been retired. link this machine again with 'supervillain key link', or bring another key.";

/** The actor a session authenticates as, or undefined for the keyless guest
 * path — where there is no key yet, and so nothing to have retired. */
export const keyedActorOf = (identity: SessionIdentity): string | undefined =>
	identity.keyed ? identity.actor() : undefined;

/**
 * The door's whole revocation rule, as one readable answer: the line to say and
 * close on, or undefined to let the visitor in. A **local read** of the gateway's
 * own graph (ADR-0013) — no network, no backend, our servers unreachable.
 */
export const doorRefusal = (
	identity: SessionIdentity,
	keys: Pick<IdentityDirectory, "isRevoked">
): string | undefined => {
	const actor = keyedActorOf(identity);
	return actor !== undefined && keys.isRevoked(actor)
		? REVOKED_DOOR_MESSAGE
		: undefined;
};

/** What a seated player is told when the key they are sitting on is retired
 * out from under them. */
export const REVOKED_SESSION_MESSAGE =
	"this key was just retired. the table is closed to it.";

/**
 * The live keyed sessions, by actor. Memory only and counts only — nothing here
 * is durable and nothing here is game state (ADR-0012, NQ-11).
 *
 * It exists for one reason: revocation takes effect **immediately** rather than
 * at next authentication, so something has to know which terminals a retired
 * key is still holding.
 */
export interface KeyedSessions {
	/** Registers a live session for an actor; the returned call releases it. */
	readonly hold: (actor: string, drop: () => void) => () => void;
	/** Drops every live session held by an actor. Returns how many there were. */
	readonly drop: (actor: string) => number;
	readonly count: (actor: string) => number;
}

export const createKeyedSessions = (): KeyedSessions => {
	const held = new Map<string, Set<() => void>>();
	return {
		count: (actor: string): number => held.get(actor)?.size ?? 0,
		drop: (actor: string): number => {
			const sessions = held.get(actor);
			if (sessions === undefined) {
				return 0;
			}
			held.delete(actor);
			for (const stop of sessions) {
				stop();
			}
			return sessions.size;
		},
		hold: (actor: string, stop: () => void): (() => void) => {
			const sessions = held.get(actor) ?? new Set<() => void>();
			sessions.add(stop);
			held.set(actor, sessions);
			return (): void => {
				const current = held.get(actor);
				if (current === undefined) {
					return;
				}
				current.delete(stop);
				if (current.size === 0) {
					held.delete(actor);
				}
			};
		},
	};
};
