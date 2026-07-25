import { randomBytes } from "node:crypto";

/** Guest actors are `guest:` plus 12 hex chars — structurally disjoint from
 * the 64-hex key actors, so a guest can never collide with a key identity and
 * a later linking event can adopt the string as-is (v1). */
export const mintGuestActor = (): string =>
	`guest:${randomBytes(6).toString("hex")}`;

export const isGuestActor = (actor: string): boolean =>
	actor.startsWith("guest:");

const BOX_WIDTH = 50;

const boxLine = (text: string): string => `  │${text.padEnd(BOX_WIDTH, " ")}│`;

/**
 * The can't-miss upgrade box, shown to guests at the minting threshold —
 * before they sit down (ADR-0003, placement re-pinned by ADR-0008).
 *
 * `adoptionCode` is ADR-0005's guest adoption handle: minted during the live
 * session, because only the gateway knows a session is `guest:X` and guests
 * have no reconnect continuity. It lives seven days, so there is no
 * install-the-CLI-right-now pressure — and redemption takes exactly one line of
 * instruction, since `key link` accepts either code kind.
 */
export const guestUpgradeBox = (adoptionCode?: string): string => {
	const adoption =
		adoptionCode === undefined
			? [
					boxLine("  to be remembered, bring an ed25519 key:"),
					boxLine(""),
					boxLine("      ssh-keygen -t ed25519"),
				]
			: [
					boxLine("  to keep tonight's history, install the CLI"),
					boxLine("  and claim this session within 7 days:"),
					boxLine(""),
					boxLine(`      supervillain key link ${adoptionCode}`),
				];
	return [
		"",
		`  ┌${"─".repeat(BOX_WIDTH)}┐`,
		boxLine("  you arrive without a key."),
		boxLine("  your seat is temporary; your deeds, forgotten."),
		boxLine(""),
		...adoption,
		boxLine(""),
		boxLine("  press any key to sit down anyway."),
		`  └${"─".repeat(BOX_WIDTH)}┘`,
		"",
	].join("\r\n");
};

export interface AssumedActor {
	readonly actor: string;
	/** True exactly once per session, on the call that minted the guest actor.
	 * The upgrade box rides this edge — the minting threshold is its placement. */
	readonly minted: boolean;
}

/** One SSH session's identity state. ADR-0008 gives the lobby session two of
 * them: no-actor (a keyless visitor who has entered no room — actors exist to
 * stamp envelopes and the lobby writes to no log) and actor-minted. A keyed
 * connection resolves its identity at connect and never mints anything. */
export interface SessionIdentity {
	readonly keyed: boolean;
	/** The actor, if one exists yet. Undefined is the pre-identity state, not an
	 * error: a session that never enters a room never gets an actor. */
	readonly actor: () => string | undefined;
	/** The actor to stamp a room entry with, minting on first use for guests.
	 * Idempotent: one `guest:` actor per SSH session, reused across room hops. */
	readonly assume: () => AssumedActor;
}

export const keyedIdentity = (actor: string): SessionIdentity => ({
	actor: () => actor,
	assume: () => ({ actor, minted: false }),
	keyed: true,
});

export const guestIdentity = (
	mint: () => string = mintGuestActor
): SessionIdentity => {
	let actor: string | undefined;
	return {
		actor: () => actor,
		assume: () => {
			if (actor !== undefined) {
				return { actor, minted: false };
			}
			actor = mint();
			return { actor, minted: true };
		},
		keyed: false,
	};
};
