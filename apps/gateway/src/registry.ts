import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";

import { fingerprintFromActor } from "@supervillain/identity";
import type { IdentityDirectory } from "@supervillain/identity";
import type {
	ActorLink,
	ClaimOutcome,
	KeyGraph,
	LinkCodeOutcome,
	LinkRedemptionOutcome,
	RevocationOutcome,
	RoomOwnership,
	WhoAmIResult,
} from "@supervillain/room-wire";

import { isGuestActor } from "./guest.js";
import { migrate } from "./migrate.js";

/**
 * Migrations only ever grow. Steps 1–8 retired the iroh-era `rooms.address`
 * column (ADR-0012 killed the dial it held) and put an **indirection** where
 * the bare owner key used to be: a name belongs to an identity row, and keys
 * point at identity rows.
 *
 * Steps 9–14 make that indirection do the work it was shaped for (ADR-0005 as
 * relocated by ADR-0013): `identity_keys` *is* the key-equivalence graph, it
 * gains the revoked flag NQ-3 requires, and `link_codes` holds the one-time
 * codes `key link` mints and redeems. Device codes record their minting key so
 * revoking it can retire them in the same transaction. Note what is **not**
 * here and never will
 * be: a queue of pending linking events per room. The graph is the complete
 * truth and a room's missing links are derived from it on demand, so a queue
 * would be a staler second copy of a computable fact (ADR-0013).
 *
 * Row shapes are hand-written beside the SQL that creates them, which is the
 * accepted mitigation for raw statements returning untyped rows (ADR-0013).
 */
const MIGRATIONS: readonly string[] = [
	`CREATE TABLE rooms (
		name TEXT PRIMARY KEY,
		address TEXT NOT NULL,
		owner TEXT NOT NULL,
		updated_at TEXT NOT NULL
	) STRICT`,
	`CREATE TABLE identities (
		id TEXT PRIMARY KEY,
		created_at TEXT NOT NULL
	) STRICT`,
	`CREATE TABLE identity_keys (
		key TEXT PRIMARY KEY,
		identity_id TEXT NOT NULL REFERENCES identities(id),
		created_at TEXT NOT NULL
	) STRICT`,
	"INSERT INTO identities (id, created_at) SELECT DISTINCT owner, updated_at FROM rooms",
	"INSERT INTO identity_keys (key, identity_id, created_at) SELECT DISTINCT owner, owner, updated_at FROM rooms",
	`CREATE TABLE rooms_owned (
		name TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL REFERENCES identities(id),
		updated_at TEXT NOT NULL
	) STRICT`,
	"INSERT INTO rooms_owned (name, owner_id, updated_at) SELECT name, owner, updated_at FROM rooms",
	"DROP TABLE rooms",
	"ALTER TABLE rooms_owned RENAME TO rooms",
	// Revocation is a column, not a service call: refusal stays a local read
	// with our servers unreachable (ADR-0013). It is a **state on the key, not a
	// deletion** — the row stays, so history stays legible and a retired key can
	// never quietly become adoptable again (#59).
	"ALTER TABLE identity_keys ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0",
	// `identity_keys.key` holds an *actor* string, not strictly a key: an
	// adopted `guest:X` is one row here too, which is what lets one
	// `core.actor-linked` event serve device linking and guest adoption alike.
	//
	// `subject` is the code's target: a device code names the minting identity,
	// an adoption code names the `guest:X` actor it would absorb.
	`CREATE TABLE link_codes (
		code TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		subject TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		redeemed_at TEXT
	) STRICT`,
	"CREATE INDEX link_codes_expires_at ON link_codes (expires_at)",
	"ALTER TABLE link_codes ADD COLUMN minted_by TEXT",
	"ALTER TABLE link_codes ADD COLUMN retired_at TEXT",
	// Pre-hardening device-code rows cannot identify their minting key. Retire
	// that at-most-15-minute legacy set rather than leave an unverifiable code
	// live across the migration.
	"UPDATE link_codes SET retired_at = created_at WHERE kind = 'device' AND minted_by IS NULL",
	// A lone key may own backend artifacts even when it owns no gateway rooms.
	// Preserve the former owner id when ADR-0005 permits moving that key, so the
	// web cold path can still list/revoke both sides of the link (#104).
	`CREATE TABLE identity_aliases (
		former_identity_id TEXT PRIMARY KEY,
		current_identity_id TEXT NOT NULL REFERENCES identities(id)
	) STRICT`,
	`CREATE TABLE presentation_preferences (
		identity_id TEXT PRIMARY KEY REFERENCES identities(id),
		focus_marker INTEGER CHECK (focus_marker IN (0, 1)),
		feed_rail INTEGER CHECK (feed_rail IN (0, 1)),
		sidebar_rail INTEGER CHECK (sidebar_rail IN (0, 1))
	) STRICT`,
	// Before #127, `joinIdentity` deleted the folded identity but left its prefs
	// row behind, referencing a dead identities.id. Purge that litter — prefs are
	// re-creatable trivia, so deletion beats archaeology through identity_aliases
	// (ADR-0008, amended 2026-08-05) — so foreign-key enforcement can turn on.
	`DELETE FROM presentation_preferences
	 WHERE identity_id NOT IN (SELECT id FROM identities)`,
];

/** Both machines are at hand, so a device code lives only as long as it takes
 * to type it (ADR-0005). */
export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
/** Guest-first means no mid-session install pressure: a guest has a week to
 * install the CLI and keep tonight's history (ADR-0005). */
export const ADOPTION_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a spent code's row is kept after it dies. Long enough that a
 * person who waited too long is told "expired" rather than "not valid", short
 * enough that the table stays litter-free. */
const LINK_CODE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

const DEVICE_CODE_LENGTH = 8;
const ADOPTION_CODE_LENGTH = 10;
const CODE_MINT_ATTEMPTS = 8;

/** Crockford base32: no I, L, O, or U, so a code read off a terminal and typed
 * into another one survives the trip. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const randomCode = (length: number): string => {
	const bytes = randomBytes(length);
	let code = "";
	for (const byte of bytes) {
		code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
	}
	return code;
};

/** Codes are spoken aloud and typed by hand: case and separators are noise. */
const normalizeCode = (code: string): string =>
	code.replaceAll(/[\s-]/gu, "").toUpperCase();

export interface RoomRegistryOptions {
	/** Database path; ":memory:" for tests. */
	readonly path: string;
	readonly clock?: () => string;
	readonly newIdentityId?: () => string;
	readonly newLinkCode?: (length: number) => string;
}

export type LinkCodeKind = "adoption" | "device";

export interface PresentationPreferences {
	readonly feedRail?: boolean;
	readonly focusMarker?: boolean;
	readonly sidebarRail?: boolean;
}

export type PresentationPreference = keyof PresentationPreferences;

/**
 * The gateway's store. It is ADR-0013's **local** {@link IdentityDirectory}
 * implementation: `identityOf` and `isRevoked` are synchronous because they are
 * local reads, and they must stay that way — they answer on the authentication
 * path with no network and no backend process in existence.
 */
export interface GatewayRoomRegistry
	extends RoomOwnership, IdentityDirectory, KeyGraph {
	/** Whether a name is claimed at all — the difference between "no such room"
	 * and "that room's Host is offline". */
	readonly isClaimed: (name: string) => boolean;
	readonly ownerOf: (name: string) => string | undefined;
	/**
	 * The owner identity a key resolves to, minted on first contact (NQ-8: an
	 * unknown key becomes an identity). An identity may now hold several keys —
	 * that is the whole of GM roaming: the laptop's key resolves to the same
	 * identity as the desktop's, and the name does not change owner.
	 */
	readonly resolveIdentity: (key: string) => string;
	/** Every actor of an identity, first-linked first — retired keys included,
	 * because attribution still has to reach the lines they wrote. */
	readonly actorsOf: (identityId: string) => readonly string[];
	/** The subset that still authenticates: `actorsOf` minus the retired keys. */
	readonly liveActorsOf: (identityId: string) => readonly string[];
	/** Current owner identity followed by identities this key formerly owned.
	 * Backend ownership survives ADR-0005's permitted lone-key move. */
	readonly ownerIdentitiesOf: (key: string) => readonly string[];
	/**
	 * Mints an adoption code for a live guest session. The gateway mints it
	 * itself — ADR-0005 routed this through the backend and ADR-0013 removed
	 * that hop, which is also the only shape that works with no backend.
	 */
	readonly mintAdoptionCode: (guestActor: string) => LinkCodeOutcome;
	/** What this Door session's matched key resolves to. Undefined means the
	 * keyless guest path; no key is silently invented for it (#90). */
	readonly whoAmI: (key: string | undefined) => WhoAmIResult;
	readonly presentationPreferences: (
		identityId: string
	) => PresentationPreferences;
	readonly setPresentationPreference: (
		identityId: string,
		preference: PresentationPreference,
		value: boolean
	) => void;
	readonly close: () => void;
}

interface OwnerRow {
	readonly owner_id: string;
}

interface IdentityRow {
	readonly identity_id: string;
}

interface RevokedRow {
	readonly revoked: number;
}

interface KeyRow {
	readonly key: string;
}

interface FormerIdentityRow {
	readonly former_identity_id: string;
}

interface CountRow {
	readonly count: number;
}

interface PresentationPreferencesRow {
	readonly feed_rail: number | null;
	readonly focus_marker: number | null;
	readonly sidebar_rail: number | null;
}

interface LinkCodeRow {
	readonly code: string;
	readonly kind: string;
	readonly subject: string;
	readonly expires_at: string;
	readonly redeemed_at: string | null;
	readonly retired_at: string | null;
}

const NOT_A_CODE = "That link code is not valid.";
const USED_CODE = "That link code has already been used.";
const EXPIRED_CODE = "That link code has expired.";
const REVOKED_KEY = "This key has been retired.";
const ALREADY_ADOPTED = "That guest has already been adopted.";
const OWN_CODE = "This key is already linked to that identity.";
const TANGLED =
	"This key already holds an identity of its own. Link a fresh key, or move that identity's rooms first.";

/**
 * The four ways `key revoke` says no. Each names a different fact, because a GM
 * who retired a key and then presented it — or typed the wrong key entirely —
 * deserves to be told which of the two happened (#59, ADR-0012 NQ-3).
 */
const REVOKE_FROM_RETIRED =
	"The key you are revoking with has itself been retired.";
const REVOKE_SELF =
	"That is the key you are using. Revoke a key from a machine you still control.";
const REVOKE_UNKNOWN =
	"This gateway has never seen that key. Check it with 'supervillain key show' on the machine you are retiring.";
const REVOKE_NOT_YOURS = "That key is not one of yours.";
const REVOKE_ALREADY = "That key is already retired.";
const REVOKE_GUEST =
	"That is a guest actor, not a key. Nothing can authenticate as it, so there is nothing to retire.";

/**
 * The gateway's durable half of registration (ADR-0012, NQ-4): `name → owner`,
 * surviving disconnects. The live half — `name → current pipe` — is memory only
 * and lives in `serveHostPipes`; nothing about a live connection is written
 * here, ever (ADR-0013's never-durable mirror).
 *
 * It also owns the key-equivalence graph and the link codes, which is what
 * makes identity resolution and revocation local reads (ADR-0013).
 */
// oxlint-disable-next-line eslint/max-lines-per-function -- the store is one object over one database handle; its prepared statements and closures are a single unit.
export const openRoomRegistry = (
	options: RoomRegistryOptions
): GatewayRoomRegistry => {
	const db = new Database(options.path, { create: true, strict: true });
	migrate(db, MIGRATIONS);
	// Enforcement is per-connection and deliberately follows the migrations:
	// early steps copy/drop/rename tables in ways checks would refuse, and the
	// orphan-purge step above needs to see the litter before the gate closes.
	// From here, a write that would orphan a per-identity row throws at the
	// write site instead of planting a landmine (#127, ADR-0008).
	db.run("PRAGMA foreign_keys = ON");
	const clock = options.clock ?? (() => new Date().toISOString());
	const newIdentityId = options.newIdentityId ?? (() => randomUUID());
	const newLinkCode = options.newLinkCode ?? randomCode;
	const selectOwner = db.query("SELECT owner_id FROM rooms WHERE name = $name");
	const selectIdentity = db.query(
		"SELECT identity_id FROM identity_keys WHERE key = $key"
	);
	const selectRevoked = db.query(
		"SELECT revoked FROM identity_keys WHERE key = $key"
	);
	const selectKeysOf = db.query(
		`SELECT key FROM identity_keys WHERE identity_id = $identityId
		 ORDER BY created_at, key`
	);
	// The authenticating half of an equivalence class. `actorsOf` deliberately
	// keeps returning every actor including the retired ones: revocation removes
	// a key from its class *for authentication purposes* only, and attribution
	// still has to reach the lines it wrote (#59).
	const selectLiveKeysOf = db.query(
		`SELECT key FROM identity_keys
		 WHERE identity_id = $identityId AND revoked = 0
		 ORDER BY created_at, key`
	);
	const markRevoked = db.query(
		"UPDATE identity_keys SET revoked = 1 WHERE key = $key"
	);
	const countRoomsOf = db.query(
		"SELECT COUNT(*) AS count FROM rooms WHERE owner_id = $identityId"
	);
	const insertIdentity = db.query(
		"INSERT INTO identities (id, created_at) VALUES ($id, $createdAt)"
	);
	const insertIdentityKey = db.query(
		`INSERT INTO identity_keys (key, identity_id, created_at)
		 VALUES ($key, $identityId, $createdAt)`
	);
	const repointIdentityKey = db.query(
		"UPDATE identity_keys SET identity_id = $identityId WHERE key = $key"
	);
	const repointIdentityAliases = db.query(
		`UPDATE identity_aliases SET current_identity_id = $identityId
		 WHERE current_identity_id = $formerIdentityId`
	);
	const insertIdentityAlias = db.query(
		`INSERT INTO identity_aliases (former_identity_id, current_identity_id)
		 VALUES ($formerIdentityId, $identityId)`
	);
	const selectIdentityAliases = db.query(
		`SELECT former_identity_id FROM identity_aliases
		 WHERE current_identity_id = $identityId ORDER BY former_identity_id`
	);
	const selectPresentationPreferences = db.query(
		`SELECT feed_rail, focus_marker, sidebar_rail
		 FROM presentation_preferences WHERE identity_id = $identityId`
	);
	const setFeedRail = db.query(
		`INSERT INTO presentation_preferences (identity_id, feed_rail)
		 VALUES ($identityId, $value)
		 ON CONFLICT(identity_id) DO UPDATE SET feed_rail = excluded.feed_rail`
	);
	const setFocusMarker = db.query(
		`INSERT INTO presentation_preferences (identity_id, focus_marker)
		 VALUES ($identityId, $value)
		 ON CONFLICT(identity_id) DO UPDATE SET focus_marker = excluded.focus_marker`
	);
	const setSidebarRail = db.query(
		`INSERT INTO presentation_preferences (identity_id, sidebar_rail)
		 VALUES ($identityId, $value)
		 ON CONFLICT(identity_id) DO UPDATE SET sidebar_rail = excluded.sidebar_rail`
	);
	// The fold merge (#127, ADR-0008 amended 2026-08-05): an explicit choice
	// beats an unset one, and the destination wins true conflicts — so the
	// outcome depends on what the person chose, never on which machine minted
	// the link code. If the destination has no row, the source's values land.
	const mergePresentationPreferences = db.query(
		`INSERT INTO presentation_preferences
		 (identity_id, feed_rail, focus_marker, sidebar_rail)
		 SELECT $identityId, feed_rail, focus_marker, sidebar_rail
		 FROM presentation_preferences WHERE identity_id = $formerIdentityId
		 ON CONFLICT(identity_id) DO UPDATE SET
		 feed_rail = coalesce(presentation_preferences.feed_rail, excluded.feed_rail),
		 focus_marker = coalesce(presentation_preferences.focus_marker, excluded.focus_marker),
		 sidebar_rail = coalesce(presentation_preferences.sidebar_rail, excluded.sidebar_rail)`
	);
	const deletePresentationPreferences = db.query(
		"DELETE FROM presentation_preferences WHERE identity_id = $formerIdentityId"
	);
	const deleteIdentity = db.query("DELETE FROM identities WHERE id = $id");
	const upsertRoom = db.query(
		`INSERT INTO rooms (name, owner_id, updated_at)
		 VALUES ($name, $ownerId, $updatedAt)
		 ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at`
	);
	const insertLinkCode = db.query(
		`INSERT INTO link_codes
		 (code, kind, subject, created_at, expires_at, minted_by)
		 VALUES ($code, $kind, $subject, $createdAt, $expiresAt, $mintedBy)`
	);
	const selectLinkCode = db.query(
		`SELECT code, kind, subject, expires_at, redeemed_at, retired_at
		 FROM link_codes WHERE code = $code`
	);
	const markRedeemed = db.query(
		"UPDATE link_codes SET redeemed_at = $redeemedAt WHERE code = $code"
	);
	const retireDeviceCodes = db.query(
		`UPDATE link_codes SET retired_at = $retiredAt
		 WHERE kind = 'device' AND minted_by = $key
		 AND redeemed_at IS NULL AND retired_at IS NULL`
	);
	const purgeLinkCodes = db.query(
		"DELETE FROM link_codes WHERE expires_at < $before OR redeemed_at IS NOT NULL"
	);
	// Spent and long-dead codes are litter, not history — nothing derives from
	// them, and no queue is hiding in here.
	purgeLinkCodes.run({
		before: new Date(
			new Date(clock()).getTime() - LINK_CODE_GRACE_MS
		).toISOString(),
	});

	const identityOf = (actor: string): string | undefined => {
		const row = selectIdentity.get({ key: actor }) as IdentityRow | null;
		return row?.identity_id;
	};

	const isRevoked = (key: string): boolean => {
		const row = selectRevoked.get({ key }) as RevokedRow | null;
		return row !== null && row.revoked !== 0;
	};

	const actorsOf = (identityId: string): readonly string[] =>
		(selectKeysOf.all({ identityId }) as KeyRow[]).map((row) => row.key);

	const liveActorsOf = (identityId: string): readonly string[] =>
		(selectLiveKeysOf.all({ identityId }) as KeyRow[]).map((row) => row.key);

	const ownerIdentitiesOf = (key: string): readonly string[] => {
		const identityId = identityOf(key);
		if (identityId === undefined) {
			return [];
		}
		const former = selectIdentityAliases.all({
			identityId,
		}) as FormerIdentityRow[];
		return [identityId, ...former.map((row) => row.former_identity_id)];
	};

	/**
	 * The retire half of rotation (ADR-0012, NQ-3). Two rules, both narrow on
	 * purpose:
	 *
	 * - you may only retire a key of **your own** identity, because the graph is
	 *   the only thing that says two keys are one person, and
	 * - you may not retire the key you are holding — the whole point is to do
	 *   this from a machine you still control, and a self-revoke on the last key
	 *   would lock an identity out of its own rooms with nothing left to undo it
	 *   with.
	 *
	 * Nothing is deleted: the row keeps its identity, so the class's other keys
	 * and the identity's room-ownership rows (which hang off owner identity, not
	 * key) are untouched.
	 */
	const revoke = (target: string, byKey: string): RevocationOutcome => {
		if (isRevoked(byKey)) {
			return { message: REVOKE_FROM_RETIRED, rejected: true };
		}
		const key = target.trim();
		if (key === byKey) {
			return { message: REVOKE_SELF, rejected: true };
		}
		// `identity_keys` holds adopted `guest:X` actors too, and one of those is
		// not a credential — nothing can ever present it. Retiring one would only
		// hide a line of history behind a word that promises a safety property it
		// is not delivering, so this refuses rather than pretend.
		if (isGuestActor(key)) {
			return { message: REVOKE_GUEST, rejected: true };
		}
		const identityId = identityOf(key);
		if (identityId === undefined) {
			return { message: REVOKE_UNKNOWN, rejected: true };
		}
		if (identityId !== identityOf(byKey)) {
			return { message: REVOKE_NOT_YOURS, rejected: true };
		}
		if (isRevoked(key)) {
			return { message: REVOKE_ALREADY, rejected: true };
		}
		const revokedAt = clock();
		markRevoked.run({ key });
		retireDeviceCodes.run({ key, retiredAt: revokedAt });
		return {
			accepted: true,
			identityId,
			remaining: liveActorsOf(identityId),
			revoked: key,
		};
	};

	const resolveIdentity = (key: string): string => {
		const existing = identityOf(key);
		if (existing !== undefined) {
			return existing;
		}
		const id = newIdentityId();
		const createdAt = clock();
		db.transaction(() => {
			insertIdentity.run({ createdAt, id });
			insertIdentityKey.run({ createdAt, identityId: id, key });
		})();
		return id;
	};

	const ownerOf = (name: string): string | undefined => {
		const row = selectOwner.get({ name }) as OwnerRow | null;
		return row?.owner_id;
	};

	const presentationPreferences = (
		identityId: string
	): PresentationPreferences => {
		const row = selectPresentationPreferences.get({
			identityId,
		}) as PresentationPreferencesRow | null;
		return row === null
			? {}
			: {
					...(row.feed_rail === null ? {} : { feedRail: row.feed_rail !== 0 }),
					...(row.focus_marker === null
						? {}
						: { focusMarker: row.focus_marker !== 0 }),
					...(row.sidebar_rail === null
						? {}
						: { sidebarRail: row.sidebar_rail !== 0 }),
				};
	};

	const setPresentationPreference = (
		identityId: string,
		preference: PresentationPreference,
		value: boolean
	): void => {
		const parameters = { identityId, value: value ? 1 : 0 };
		if (preference === "feedRail") {
			setFeedRail.run(parameters);
			return;
		}
		if (preference === "focusMarker") {
			setFocusMarker.run(parameters);
			return;
		}
		setSidebarRail.run(parameters);
	};

	const whoAmI = (key: string | undefined): WhoAmIResult => {
		if (key === undefined || isGuestActor(key)) {
			return {
				identity: "guest",
				linkedFingerprints: [],
				matchedFingerprint: undefined,
			};
		}
		const identityId = resolveIdentity(key);
		return {
			identity: "keyed",
			linkedFingerprints: liveActorsOf(identityId).flatMap((actor) => {
				const fingerprint =
					actor === key ? undefined : fingerprintFromActor(actor);
				return fingerprint === undefined ? [] : [fingerprint];
			}),
			matchedFingerprint: fingerprintFromActor(key),
		};
	};

	const mintCode = (
		kind: LinkCodeKind,
		subject: string,
		length: number,
		ttlMs: number,
		mintedBy = ""
	): LinkCodeOutcome => {
		const createdAt = clock();
		const expiresAt = new Date(
			new Date(createdAt).getTime() + ttlMs
		).toISOString();
		for (let attempt = 0; attempt < CODE_MINT_ATTEMPTS; attempt += 1) {
			const code = newLinkCode(length);
			const existing = selectLinkCode.get({ code }) as LinkCodeRow | null;
			if (existing === null) {
				insertLinkCode.run({
					code,
					createdAt,
					expiresAt,
					kind,
					mintedBy,
					subject,
				});
				return { accepted: true, code, expiresAt };
			}
		}
		return { message: "Could not mint a link code.", rejected: true };
	};

	/** Guest adoption: the guest actor joins the redeeming key's identity, so a
	 * historical `guest:X` line becomes reachable with the log untouched. */
	const adopt = (guestActor: string, key: string): LinkRedemptionOutcome => {
		if (identityOf(guestActor) !== undefined) {
			return { message: ALREADY_ADOPTED, rejected: true };
		}
		const identityId = resolveIdentity(key);
		insertIdentityKey.run({
			createdAt: clock(),
			identityId,
			key: guestActor,
		});
		return { accepted: true, identityId, linked: guestActor };
	};

	/** Device linking: the redeeming key joins the minting identity. */
	const joinIdentity = (
		identityId: string,
		key: string
	): LinkRedemptionOutcome => {
		const anchor = actorsOf(identityId).find((actor) => actor !== key);
		if (anchor === undefined) {
			return { message: NOT_A_CODE, rejected: true };
		}
		const current = identityOf(key);
		if (current === undefined) {
			insertIdentityKey.run({ createdAt: clock(), identityId, key });
			return { accepted: true, identityId, linked: anchor };
		}
		// Merging two established identities is a product decision nothing in the
		// definition covers, so this refuses rather than inventing one. A key that
		// is alone and owns nothing simply moves.
		const siblings = actorsOf(current).filter((actor) => actor !== key);
		const rooms = (countRoomsOf.get({ identityId: current }) as CountRow).count;
		if (siblings.length > 0 || rooms > 0) {
			return { message: TANGLED, rejected: true };
		}
		// Gateway room ownership cannot reveal backend artifact ownership. Keep the
		// old id as lineage before deleting its gateway identity, and flatten any
		// earlier moves onto the new current identity (#104, ADR-0013).
		repointIdentityAliases.run({
			formerIdentityId: current,
			identityId,
		});
		insertIdentityAlias.run({ formerIdentityId: current, identityId });
		repointIdentityKey.run({ identityId, key });
		// The folded identity's presentation prefs merge rather than orphan
		// (#127, ADR-0008 amended 2026-08-05): the row must die before its
		// identity does, or FK enforcement refuses the fold. Presentation rows
		// only — this is no precedent for merging tangled identities.
		mergePresentationPreferences.run({ formerIdentityId: current, identityId });
		deletePresentationPreferences.run({ formerIdentityId: current });
		deleteIdentity.run({ id: current });
		return { accepted: true, identityId, linked: anchor };
	};

	const redeem = (code: string, key: string): LinkRedemptionOutcome => {
		if (isRevoked(key)) {
			return { message: REVOKED_KEY, rejected: true };
		}
		const normalized = normalizeCode(code);
		const row = selectLinkCode.get({ code: normalized }) as LinkCodeRow | null;
		if (row === null) {
			return { message: NOT_A_CODE, rejected: true };
		}
		if (row.redeemed_at !== null) {
			return { message: USED_CODE, rejected: true };
		}
		if (row.retired_at !== null) {
			return { message: REVOKED_KEY, rejected: true };
		}
		const now = clock();
		if (row.expires_at <= now) {
			return { message: EXPIRED_CODE, rejected: true };
		}
		if (row.kind === "device" && row.subject === identityOf(key)) {
			// Redeeming your own code links nothing; say so instead of burning it.
			return { message: OWN_CODE, rejected: true };
		}
		const outcome =
			row.kind === "adoption"
				? adopt(row.subject, key)
				: joinIdentity(row.subject, key);
		if ("accepted" in outcome) {
			markRedeemed.run({ code: normalized, redeemedAt: now });
		}
		return outcome;
	};

	/**
	 * ADR-0013's derive-never-queue answer. Given the actors a room's log
	 * mentions, name the actors it is missing — one per linked actor, anchored
	 * on an actor the room already knows so its fold can union the two.
	 *
	 * Deterministic and idempotent: a room that already carries the link asks
	 * with both actors in the roster and gets nothing back.
	 */
	const resolveActorLinks = (
		actors: readonly string[]
	): readonly ActorLink[] => {
		const known = new Set(actors);
		const anchors = new Map<string, string>();
		for (const actor of [...known].toSorted()) {
			const identityId = identityOf(actor);
			if (identityId !== undefined && !anchors.has(identityId)) {
				anchors.set(identityId, actor);
			}
		}
		const links: ActorLink[] = [];
		for (const [identityId, anchor] of anchors) {
			for (const actor of actorsOf(identityId)) {
				if (!known.has(actor)) {
					links.push({ actor, linked: anchor });
				}
			}
		}
		return links.toSorted((left, right) => (left.actor < right.actor ? -1 : 1));
	};

	return {
		actorsOf,
		claim: (hostKey: string, name: string): Promise<ClaimOutcome> => {
			const ownerId = resolveIdentity(hostKey);
			const existing = ownerOf(name);
			if (existing !== undefined && existing !== ownerId) {
				return Promise.resolve({
					message: `The name '${name}' is already claimed by another key.`,
					rejected: true,
				});
			}
			upsertRoom.run({ name, ownerId, updatedAt: clock() });
			return Promise.resolve({ accepted: true, ownerId });
		},
		close: () => db.close(),
		identityOf,
		isClaimed: (name: string): boolean => ownerOf(name) !== undefined,
		isRevoked,
		liveActorsOf,
		mintAdoptionCode: (guestActor: string): LinkCodeOutcome =>
			mintCode(
				"adoption",
				guestActor,
				ADOPTION_CODE_LENGTH,
				ADOPTION_CODE_TTL_MS
			),
		mintDeviceCode: (key: string): Promise<LinkCodeOutcome> =>
			Promise.resolve(
				isRevoked(key)
					? { message: REVOKED_KEY, rejected: true }
					: mintCode(
							"device",
							resolveIdentity(key),
							DEVICE_CODE_LENGTH,
							DEVICE_CODE_TTL_MS,
							key
						)
			),
		ownerIdentitiesOf,
		ownerOf,
		presentationPreferences,
		redeemLinkCode: (
			code: string,
			key: string
		): Promise<LinkRedemptionOutcome> =>
			Promise.resolve(db.transaction(() => redeem(code, key))()),
		resolveActorLinks: (
			actors: readonly string[]
		): Promise<readonly ActorLink[]> =>
			Promise.resolve(resolveActorLinks(actors)),
		resolveIdentity,
		revokeKey: (target: string, byKey: string): Promise<RevocationOutcome> =>
			Promise.resolve(db.transaction(() => revoke(target, byKey))()),
		setPresentationPreference,
		whoAmI,
	};
};
