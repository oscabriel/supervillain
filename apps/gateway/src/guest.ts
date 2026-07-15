import { randomBytes } from "node:crypto";

/** Guest actors are `guest:` plus 12 hex chars — structurally disjoint from
 * the 64-hex key actors, so a guest can never collide with a key identity and
 * a later linking event can adopt the string as-is (v1). */
export const mintGuestActor = (): string =>
	`guest:${randomBytes(6).toString("hex")}`;

export const isGuestActor = (actor: string): boolean =>
	actor.startsWith("guest:");

/** The can't-miss upgrade box, shown to keyless players before they sit down. */
export const guestUpgradeBox = (): string =>
	[
		"",
		"  ┌──────────────────────────────────────────────────┐",
		"  │  you arrive without a key.                       │",
		"  │  your seat is temporary; your deeds, forgotten.  │",
		"  │                                                  │",
		"  │  to be remembered, bring an ed25519 key:         │",
		"  │                                                  │",
		"  │      ssh-keygen -t ed25519                       │",
		"  │                                                  │",
		"  │  press any key to sit down anyway.               │",
		"  └──────────────────────────────────────────────────┘",
		"",
	].join("\r\n");
