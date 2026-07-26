import { actorFromSshEd25519Blob } from "@supervillain/identity";

/** The offered public key, as the Door needs to read it — structural, so the
 * admission policy stays untyped to the SSH implementation behind it. */
export interface DoorPublicKey {
	readonly blob: Buffer;
}

/** The authenticated facts the Door decides an actor from. `publicKey` is
 * present only on the keyed variant, and only after the library has verified
 * the signature over the session blob. */
export interface DoorIdentity {
	readonly method: string;
	/** Client-supplied, never a principal: at the Door it is the room name. */
	readonly username: string;
	readonly publicKey?: DoorPublicKey;
}

/** The Door's public-key admission policy. `@opentui/ssh` calls this only once
 * the signature verifies, so an admitted key is a *proven* key. Any ed25519 key
 * is admitted: an unknown key still becomes an identity on first contact
 * (ADR-0012, NQ-8) — the key is the account, and there is nothing to enroll in.
 * Other algorithms are refused here so the client falls back to the keyless
 * guest door rather than sitting down under an actor we cannot derive. */
export const admitsPublicKey = (context: {
	readonly publicKey: DoorPublicKey;
}): boolean => actorFromSshEd25519Blob(context.publicKey.blob) !== undefined;

/** The actor a verified identity stamps envelopes with, or undefined for the
 * keyless door — whose guest actor is minted lazily, at first room entry
 * (ADR-0008), not here. */
export const actorFromIdentity = (
	identity: DoorIdentity
): string | undefined => {
	if (identity.method !== "publickey" || identity.publicKey === undefined) {
		return undefined;
	}
	return actorFromSshEd25519Blob(identity.publicKey.blob);
};

/** The room a session asked for. `ssh <room>@gateway` puts the room name in
 * the SSH username; it is client-supplied and carries no authority. */
export const roomNameFromIdentity = (identity: DoorIdentity): string =>
	identity.username;
