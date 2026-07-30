import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrate } from "./migrate";
import {
	assertSchemaMatchesMigrations,
	capabilityTokens,
	deadTokenTombstones,
	MIGRATIONS,
	publishedArtifacts,
} from "./schema";

/** The closed artifact type set (ADR-0009). */
export type ArtifactType = "character" | "log" | "map";

export interface Artifact {
	readonly type: ArtifactType;
	readonly name: string;
	/** #100's self-describing snapshot document; the API owns validation. */
	readonly document: unknown;
}

export interface ArtifactKey {
	readonly ownerIdentity: string;
	readonly type: ArtifactType;
	readonly name: string;
}

export interface ArtifactIngest extends Artifact, ArtifactKey {}

export interface PublishArtifactInput extends Artifact {
	readonly ownerIdentity: string;
	/** Current identity plus former owner ids supplied by the gateway conduit. */
	readonly ownerIdentityIds: readonly string[];
}

export interface PublishedArtifactSummary {
	readonly capability: string;
	readonly name: string;
	readonly publishedAt: string;
	readonly type: ArtifactType;
}

export type PublishArtifactResult =
	| {
			readonly kind: "published";
			readonly capability: string;
			readonly created: boolean;
			readonly publishedAt: string;
	  }
	| {
			readonly kind: "collision";
			readonly capabilities: readonly string[];
	  };

export type RevokeOwnedArtifactResult =
	| { readonly kind: "revoked" }
	| { readonly kind: "not-found" }
	| { readonly kind: "collision"; readonly capabilities: readonly string[] };

export interface BackendStoreOptions {
	/** The operated-box default is `/var/lib/supervillain`. */
	readonly stateRoot?: string;
	/** Must remain outside stateRoot and its database/file backup set. */
	readonly tokenKeyPath?: string;
	readonly clock?: () => string;
	readonly newArtifactId?: () => string;
	readonly newSeed?: () => Buffer;
}

export interface BackendStore {
	/** Compatibility/store-level single-owner entry; API callers use publishArtifact. */
	readonly ingestArtifact: (artifact: ArtifactIngest) => string;
	readonly publishArtifact: (
		artifact: PublishArtifactInput
	) => PublishArtifactResult;
	readonly listArtifacts: (
		ownerIdentityIds: readonly string[]
	) => readonly PublishedArtifactSummary[];
	readonly getArtifact: (capability: string) => Artifact | undefined;
	readonly revokeArtifact: (artifact: ArtifactKey) => boolean;
	readonly revokeOwnedArtifact: (artifact: {
		readonly ownerIdentityIds: readonly string[];
		readonly type: ArtifactType;
		readonly name: string;
		readonly capability?: string;
	}) => RevokeOwnedArtifactResult;
	readonly close: () => void;
}

export const DEFAULT_WEB_STATE_ROOT = "/var/lib/supervillain";
export const DEFAULT_WEB_TOKEN_KEY_PATH = "/etc/supervillain/web-token-key";

const ARTIFACT_TYPES: readonly ArtifactType[] = ["character", "log", "map"];
const TOKEN_BYTE_LENGTH = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DATABASE_FILE = "web.sqlite";
const SNAPSHOT_DIRECTORY = "snapshots";
const OG_DIRECTORY = "og";
const TOKEN_KEY_MODE = 0o600;
const TOKEN_MINT_ATTEMPTS = 8;

export const isArtifactType = (value: unknown): value is ArtifactType =>
	typeof value === "string" &&
	(ARTIFACT_TYPES as readonly string[]).includes(value);

const isInside = (parent: string, child: string): boolean => {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
};

const loadOrCreateTokenKey = (tokenKeyPath: string): Buffer => {
	mkdirSync(path.dirname(tokenKeyPath), { recursive: true });
	if (!existsSync(tokenKeyPath)) {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(tokenKeyPath, "wx", TOKEN_KEY_MODE);
			writeFileSync(descriptor, randomBytes(TOKEN_BYTE_LENGTH));
		} finally {
			if (descriptor !== undefined) {
				closeSync(descriptor);
			}
		}
	}
	const key = readFileSync(tokenKeyPath);
	if (key.byteLength !== TOKEN_BYTE_LENGTH) {
		throw new Error(`Web token key must be exactly ${TOKEN_BYTE_LENGTH} bytes`);
	}
	// oxlint-disable-next-line eslint/no-bitwise -- Unix permission masks are bit fields.
	const permissions = statSync(tokenKeyPath).mode & 0o777;
	if (permissions !== TOKEN_KEY_MODE) {
		chmodSync(tokenKeyPath, TOKEN_KEY_MODE);
	}
	return key;
};

const hashCapability = (capability: string): Buffer | undefined => {
	if (!CAPABILITY_PATTERN.test(capability)) {
		return undefined;
	}
	const token = Buffer.from(capability, "base64url");
	if (token.byteLength !== TOKEN_BYTE_LENGTH) {
		return undefined;
	}
	return createHash("sha256").update(token).digest();
};

const capabilityFromSeed = (tokenKey: Buffer, seed: Buffer): string =>
	createHmac("sha256", tokenKey).update(seed).digest("base64url");

const createCapability = (
	tokenKey: Buffer,
	newSeed: () => Buffer
): {
	readonly capability: string;
	readonly seed: Buffer;
	readonly tokenHash: Buffer;
} => {
	const seed = newSeed();
	if (seed.byteLength !== TOKEN_BYTE_LENGTH) {
		throw new Error(
			`Capability seed must be exactly ${TOKEN_BYTE_LENGTH} bytes`
		);
	}
	const token = createHmac("sha256", tokenKey).update(seed).digest();
	return {
		capability: token.toString("base64url"),
		seed,
		tokenHash: createHash("sha256").update(token).digest(),
	};
};

const serializeDocument = (document: unknown): string => {
	const serialized = JSON.stringify(document);
	if (serialized === undefined) {
		throw new Error("Snapshot document must be JSON-serializable");
	}
	return serialized;
};

const writeSnapshot = (
	stateRoot: string,
	artifactId: string,
	document: unknown
): string => {
	const pointer = path.join(SNAPSHOT_DIRECTORY, `${artifactId}.json`);
	const destination = path.join(stateRoot, pointer);
	const temporary = `${destination}.${randomUUID()}.tmp`;
	writeFileSync(temporary, serializeDocument(document), {
		encoding: "utf-8",
		flag: "wx",
		mode: TOKEN_KEY_MODE,
	});
	try {
		renameSync(temporary, destination);
	} catch (error) {
		unlinkSync(temporary);
		throw error;
	}
	return pointer;
};

const unlinkIfPresent = (file: string): void => {
	if (existsSync(file)) {
		unlinkSync(file);
	}
};

interface OwnedArtifactRow {
	readonly id: string;
	readonly name: string;
	readonly ownerIdentity: string;
	readonly publishedAt: string;
	readonly seed: Buffer;
	readonly snapshotPath: string;
	readonly tokenHash: Buffer;
	readonly type: ArtifactType;
}

/**
 * Opens the web backend's complete durable store. Drizzle is deliberately used
 * only for typed SQL queries; no relational query API or migration tooling is
 * configured. Schema drift is asserted after every migration/startup.
 */
// oxlint-disable-next-line eslint/max-lines-per-function -- one database handle owns these prepared typed operations as a unit.
export const openBackendStore = (
	options: BackendStoreOptions = {}
): BackendStore => {
	const stateRoot = path.resolve(options.stateRoot ?? DEFAULT_WEB_STATE_ROOT);
	const tokenKeyPath = path.resolve(
		options.tokenKeyPath ?? DEFAULT_WEB_TOKEN_KEY_PATH
	);
	if (isInside(stateRoot, tokenKeyPath)) {
		throw new Error("Web token key must live outside the backed-up state tree");
	}
	mkdirSync(path.join(stateRoot, SNAPSHOT_DIRECTORY), { recursive: true });
	mkdirSync(path.join(stateRoot, OG_DIRECTORY), { recursive: true });
	const tokenKey = loadOrCreateTokenKey(tokenKeyPath);
	const database = drizzle({
		connection: {
			create: true,
			source: path.join(stateRoot, DATABASE_FILE),
		},
	});
	const sqlite = database.$client;
	sqlite.run("PRAGMA foreign_keys = ON");
	migrate(sqlite, MIGRATIONS);
	assertSchemaMatchesMigrations(sqlite);
	const clock = options.clock ?? (() => new Date().toISOString());
	const newArtifactId = options.newArtifactId ?? randomUUID;
	const newSeed = options.newSeed ?? (() => randomBytes(TOKEN_BYTE_LENGTH));

	const capabilityExists = (tokenHash: Buffer): boolean => {
		const live = database
			.select({ tokenHash: capabilityTokens.tokenHash })
			.from(capabilityTokens)
			.where(eq(capabilityTokens.tokenHash, tokenHash))
			.limit(1)
			.get();
		const dead = database
			.select({ tokenHash: deadTokenTombstones.tokenHash })
			.from(deadTokenTombstones)
			.where(eq(deadTokenTombstones.tokenHash, tokenHash))
			.limit(1)
			.get();
		return live !== undefined || dead !== undefined;
	};

	const mintCapability = () => {
		for (let attempt = 0; attempt < TOKEN_MINT_ATTEMPTS; attempt += 1) {
			const minted = createCapability(tokenKey, newSeed);
			if (!capabilityExists(minted.tokenHash)) {
				return minted;
			}
		}
		throw new Error("Could not mint a unique capability token");
	};

	const ownedArtifacts = (
		ownerIdentityIds: readonly string[],
		type?: ArtifactType,
		name?: string
	): readonly OwnedArtifactRow[] => {
		if (ownerIdentityIds.length === 0) {
			return [];
		}
		const conditions = [
			inArray(publishedArtifacts.ownerIdentity, [...ownerIdentityIds]),
		];
		if (type !== undefined) {
			conditions.push(eq(publishedArtifacts.type, type));
		}
		if (name !== undefined) {
			conditions.push(eq(publishedArtifacts.name, name));
		}
		const rows = database
			.select({
				id: publishedArtifacts.id,
				name: publishedArtifacts.name,
				ownerIdentity: publishedArtifacts.ownerIdentity,
				publishedAt: publishedArtifacts.publishedAt,
				seed: capabilityTokens.seed,
				snapshotPath: publishedArtifacts.snapshotPath,
				tokenHash: capabilityTokens.tokenHash,
				type: publishedArtifacts.type,
			})
			.from(publishedArtifacts)
			.innerJoin(
				capabilityTokens,
				eq(capabilityTokens.artifactId, publishedArtifacts.id)
			)
			.where(and(...conditions))
			.all();
		const ownerOrder = new Map(
			ownerIdentityIds.map((identityId, index) => [identityId, index])
		);
		return rows.toSorted(
			(left, right) =>
				(ownerOrder.get(left.ownerIdentity) ?? Number.MAX_SAFE_INTEGER) -
				(ownerOrder.get(right.ownerIdentity) ?? Number.MAX_SAFE_INTEGER)
		);
	};

	const publishArtifact = ({
		document,
		name,
		ownerIdentity,
		ownerIdentityIds,
		type,
	}: PublishArtifactInput): PublishArtifactResult => {
		const matches = ownedArtifacts(ownerIdentityIds, type, name);
		if (matches.length > 1) {
			return {
				capabilities: matches.map((row) =>
					capabilityFromSeed(tokenKey, row.seed)
				),
				kind: "collision",
			};
		}
		const [existing] = matches;
		const publishedAt = clock();
		if (existing !== undefined) {
			writeSnapshot(stateRoot, existing.id, document);
			database
				.update(publishedArtifacts)
				.set({ publishedAt })
				.where(eq(publishedArtifacts.id, existing.id))
				.run();
			return {
				capability: capabilityFromSeed(tokenKey, existing.seed),
				created: false,
				kind: "published",
				publishedAt,
			};
		}
		const artifactId = newArtifactId();
		const minted = mintCapability();
		const snapshotPath = writeSnapshot(stateRoot, artifactId, document);
		try {
			database.transaction((transaction) => {
				transaction
					.insert(publishedArtifacts)
					.values({
						id: artifactId,
						name,
						ownerIdentity,
						publishedAt,
						snapshotPath,
						type,
					})
					.run();
				transaction
					.insert(capabilityTokens)
					.values({
						artifactId,
						seed: minted.seed,
						tokenHash: minted.tokenHash,
					})
					.run();
			});
		} catch (error) {
			unlinkSync(path.join(stateRoot, snapshotPath));
			throw error;
		}
		return {
			capability: minted.capability,
			created: true,
			kind: "published",
			publishedAt,
		};
	};

	const revokeOwnedArtifact = (artifact: {
		readonly ownerIdentityIds: readonly string[];
		readonly type: ArtifactType;
		readonly name: string;
		readonly capability?: string;
	}): RevokeOwnedArtifactResult => {
		let matches = ownedArtifacts(
			artifact.ownerIdentityIds,
			artifact.type,
			artifact.name
		);
		if (artifact.capability !== undefined) {
			matches = matches.filter(
				(row) => capabilityFromSeed(tokenKey, row.seed) === artifact.capability
			);
		}
		if (matches.length === 0) {
			return { kind: "not-found" };
		}
		if (matches.length > 1) {
			return {
				capabilities: matches.map((row) =>
					capabilityFromSeed(tokenKey, row.seed)
				),
				kind: "collision",
			};
		}
		const [target] = matches;
		if (target === undefined) {
			return { kind: "not-found" };
		}
		const writeDeadTokenTombstone = (): void => {
			database.transaction((transaction) => {
				// Operator takedown semantics land here later; #87d, not designed by #104.
				transaction
					.insert(deadTokenTombstones)
					.values({ revokedAt: clock(), tokenHash: target.tokenHash })
					.run();
				transaction
					.delete(publishedArtifacts)
					.where(eq(publishedArtifacts.id, target.id))
					.run();
			});
		};
		writeDeadTokenTombstone();
		unlinkIfPresent(path.join(stateRoot, target.snapshotPath));
		unlinkIfPresent(path.join(stateRoot, OG_DIRECTORY, `${target.id}.png`));
		return { kind: "revoked" };
	};

	return {
		close: () => sqlite.close(),
		getArtifact: (capability) => {
			const tokenHash = hashCapability(capability);
			if (!tokenHash) {
				return;
			}
			// ADR-0022 requires both indexed lookups on every well-formed request.
			const live = database
				.select({ artifactId: capabilityTokens.artifactId })
				.from(capabilityTokens)
				.where(eq(capabilityTokens.tokenHash, tokenHash))
				.limit(1)
				.get();
			const dead = database
				.select({ tokenHash: deadTokenTombstones.tokenHash })
				.from(deadTokenTombstones)
				.where(eq(deadTokenTombstones.tokenHash, tokenHash))
				.limit(1)
				.get();
			if (!live || dead) {
				return;
			}
			const artifact = database
				.select({
					name: publishedArtifacts.name,
					snapshotPath: publishedArtifacts.snapshotPath,
					type: publishedArtifacts.type,
				})
				.from(publishedArtifacts)
				.where(eq(publishedArtifacts.id, live.artifactId))
				.limit(1)
				.get();
			if (!artifact) {
				return;
			}
			return {
				document: JSON.parse(
					readFileSync(path.join(stateRoot, artifact.snapshotPath), "utf-8")
				) as unknown,
				name: artifact.name,
				type: artifact.type,
			};
		},
		ingestArtifact: (artifact) => {
			const result = publishArtifact({
				...artifact,
				ownerIdentityIds: [artifact.ownerIdentity],
			});
			if (result.kind !== "published") {
				throw new Error("Single-owner ingest unexpectedly collided");
			}
			return result.capability;
		},
		listArtifacts: (ownerIdentityIds) =>
			ownedArtifacts(ownerIdentityIds).map((row) => ({
				capability: capabilityFromSeed(tokenKey, row.seed),
				name: row.name,
				publishedAt: row.publishedAt,
				type: row.type,
			})),
		publishArtifact,
		revokeArtifact: ({ name, ownerIdentity, type }) =>
			revokeOwnedArtifact({
				name,
				ownerIdentityIds: [ownerIdentity],
				type,
			}).kind === "revoked",
		revokeOwnedArtifact,
	};
};

let defaultStore: BackendStore | undefined;

export const getDefaultStore = (): BackendStore => {
	defaultStore ??= openBackendStore({
		stateRoot: process.env.SUPERVILLAIN_WEB_STATE_ROOT,
		tokenKeyPath: process.env.SUPERVILLAIN_WEB_TOKEN_KEY_PATH,
	});
	return defaultStore;
};

export const getArtifact = (capability: string): Artifact | undefined =>
	getDefaultStore().getArtifact(capability);
