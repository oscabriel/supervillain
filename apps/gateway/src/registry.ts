import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { ClaimOutcome, RoomOwnership } from "@supervillain/room-wire";

import { migrate } from "./migrate.js";

/**
 * Migrations only ever grow. Steps 1–8 retire the iroh-era `rooms.address`
 * column (ADR-0012 killed the dial it held) and put an **indirection** where
 * the bare owner key used to be: a name belongs to an identity row, and keys
 * point at identity rows. Today every identity has exactly one key, because
 * ADR-0005's key-equivalence graph does not exist yet — when it lands, linking
 * a second key is one more row in `identity_keys`, and no room changes owner.
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
];

export interface RoomRegistryOptions {
	/** Database path; ":memory:" for tests. */
	readonly path: string;
	readonly clock?: () => string;
	readonly newIdentityId?: () => string;
}

export interface GatewayRoomRegistry extends RoomOwnership {
	/** Whether a name is claimed at all — the difference between "no such room"
	 * and "that room's Host is offline". */
	readonly isClaimed: (name: string) => boolean;
	readonly ownerOf: (name: string) => string | undefined;
	/**
	 * The owner identity a key resolves to, minted on first contact (NQ-8: an
	 * unknown key becomes an identity). **At this stage one key is one
	 * identity** — there is no linking, so a GM hosting from a second machine
	 * is a different owner and cannot take over their own name. That gap closes
	 * with ADR-0005, not here.
	 */
	readonly resolveIdentity: (key: string) => string;
	readonly close: () => void;
}

interface OwnerRow {
	readonly owner_id: string;
}

interface IdentityRow {
	readonly identity_id: string;
}

/**
 * The gateway's durable half of registration (ADR-0012, NQ-4): `name → owner`,
 * surviving disconnects. The live half — `name → current pipe` — is memory only
 * and lives in `serveHostPipes`; nothing about a live connection is written
 * here, ever (ADR-0013's never-durable mirror).
 */
export const openRoomRegistry = (
	options: RoomRegistryOptions
): GatewayRoomRegistry => {
	const db = new Database(options.path, { create: true, strict: true });
	migrate(db, MIGRATIONS);
	const clock = options.clock ?? (() => new Date().toISOString());
	const newIdentityId = options.newIdentityId ?? (() => randomUUID());
	const selectOwner = db.query("SELECT owner_id FROM rooms WHERE name = $name");
	const selectIdentity = db.query(
		"SELECT identity_id FROM identity_keys WHERE key = $key"
	);
	const insertIdentity = db.query(
		"INSERT INTO identities (id, created_at) VALUES ($id, $createdAt)"
	);
	const insertIdentityKey = db.query(
		`INSERT INTO identity_keys (key, identity_id, created_at)
		 VALUES ($key, $identityId, $createdAt)`
	);
	const upsertRoom = db.query(
		`INSERT INTO rooms (name, owner_id, updated_at)
		 VALUES ($name, $ownerId, $updatedAt)
		 ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at`
	);

	const resolveIdentity = (key: string): string => {
		const existing = selectIdentity.get({ key }) as IdentityRow | null;
		if (existing !== null) {
			return existing.identity_id;
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

	return {
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
		isClaimed: (name: string): boolean => ownerOf(name) !== undefined,
		ownerOf,
		resolveIdentity,
	};
};
