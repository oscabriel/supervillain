import { Database } from "bun:sqlite";

import type {
	RegistrationOutcome,
	RoomRegistration,
	RoomRegistry,
} from "@supervillain/room-wire";

import { migrate } from "./migrate.js";

const MIGRATIONS: readonly string[] = [
	`CREATE TABLE rooms (
		name TEXT PRIMARY KEY,
		address TEXT NOT NULL,
		owner TEXT NOT NULL,
		updated_at TEXT NOT NULL
	) STRICT`,
];

export interface RoomRegistryOptions {
	/** Database path; ":memory:" for tests. */
	readonly path: string;
	readonly sshHost: string;
	readonly sshPort: number;
	readonly clock?: () => string;
}

export interface GatewayRoomRegistry extends RoomRegistry {
	/** The host address a room name dials to, or undefined when unregistered. */
	readonly resolve: (name: string) => string | undefined;
	readonly close: () => void;
}

/** The name→host registry on bun:sqlite — the only durable state the gateway
 * holds for GM-hosted rooms. A name belongs to the key that registered it;
 * re-registration by the same key updates the address (a GM re-minting their
 * room after a restart), by any other key is rejected. */
export const openRoomRegistry = (
	options: RoomRegistryOptions
): GatewayRoomRegistry => {
	const db = new Database(options.path, { create: true, strict: true });
	migrate(db, MIGRATIONS);
	const clock = options.clock ?? (() => new Date().toISOString());
	const selectOwner = db.query("SELECT owner FROM rooms WHERE name = $name");
	const selectAddress = db.query(
		"SELECT address FROM rooms WHERE name = $name"
	);
	const upsert = db.query(
		`INSERT INTO rooms (name, address, owner, updated_at)
		 VALUES ($name, $address, $owner, $updatedAt)
		 ON CONFLICT(name) DO UPDATE SET
		   address = excluded.address,
		   updated_at = excluded.updated_at`
	);
	return {
		close: () => db.close(),
		register: (
			owner: string,
			registration: RoomRegistration
		): Promise<RegistrationOutcome> => {
			const existing = selectOwner.get({ name: registration.name }) as {
				readonly owner: string;
			} | null;
			if (existing !== null && existing.owner !== owner) {
				return Promise.resolve({
					message: `The name '${registration.name}' is already claimed by another key.`,
					rejected: true,
				});
			}
			upsert.run({
				address: registration.address,
				name: registration.name,
				owner,
				updatedAt: clock(),
			});
			return Promise.resolve({
				accepted: true,
				sshHost: options.sshHost,
				sshPort: options.sshPort,
			});
		},
		resolve: (name: string): string | undefined => {
			const row = selectAddress.get({ name }) as {
				readonly address: string;
			} | null;
			return row?.address;
		},
	};
};
