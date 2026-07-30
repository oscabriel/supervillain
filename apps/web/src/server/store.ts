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

import { and, eq } from "drizzle-orm";
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
	/** #100's self-describing snapshot document; #104 owns validation. */
	readonly document: unknown;
}

export interface ArtifactKey {
	readonly ownerIdentity: string;
	readonly type: ArtifactType;
	readonly name: string;
}

export interface ArtifactIngest extends Artifact, ArtifactKey {}

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
	readonly ingestArtifact: (artifact: ArtifactIngest) => string;
	readonly getArtifact: (capability: string) => Artifact | undefined;
	readonly revokeArtifact: (artifact: ArtifactKey) => boolean;
	readonly close: () => void;
}

export const DEFAULT_WEB_STATE_ROOT = "/var/lib/supervillain";
export const DEFAULT_WEB_TOKEN_KEY_PATH = "/etc/supervillain/web-token-key";

const ARTIFACT_TYPES: readonly ArtifactType[] = ["character", "log", "map"];
const TOKEN_BYTE_LENGTH = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DATABASE_FILE = "web.sqlite";
const SNAPSHOT_DIRECTORY = "snapshots";
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

/**
 * Opens the web backend's complete durable store. Drizzle is deliberately used
 * only for typed SQL queries; no relational query API or migration tooling is
 * configured. Schema drift is asserted after every migration/startup.
 */
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

	const mintCapability = (): {
		readonly capability: string;
		readonly seed: Buffer;
		readonly tokenHash: Buffer;
	} => {
		for (let attempt = 0; attempt < TOKEN_MINT_ATTEMPTS; attempt += 1) {
			const minted = createCapability(tokenKey, newSeed);
			if (!capabilityExists(minted.tokenHash)) {
				return minted;
			}
		}
		throw new Error("Could not mint a unique capability token");
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
		ingestArtifact: ({ document, name, ownerIdentity, type }) => {
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
							publishedAt: clock(),
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
			return minted.capability;
		},
		revokeArtifact: ({ name, ownerIdentity, type }) => {
			const artifact = database
				.select({
					id: publishedArtifacts.id,
					snapshotPath: publishedArtifacts.snapshotPath,
				})
				.from(publishedArtifacts)
				.where(
					and(
						eq(publishedArtifacts.ownerIdentity, ownerIdentity),
						eq(publishedArtifacts.type, type),
						eq(publishedArtifacts.name, name)
					)
				)
				.limit(1)
				.get();
			if (!artifact) {
				return false;
			}
			const capability = database
				.select({ tokenHash: capabilityTokens.tokenHash })
				.from(capabilityTokens)
				.where(eq(capabilityTokens.artifactId, artifact.id))
				.limit(1)
				.get();
			if (!capability) {
				throw new Error("Published artifact has no capability token");
			}
			database.transaction((transaction) => {
				transaction
					.insert(deadTokenTombstones)
					.values({ revokedAt: clock(), tokenHash: capability.tokenHash })
					.run();
				transaction
					.delete(publishedArtifacts)
					.where(eq(publishedArtifacts.id, artifact.id))
					.run();
			});
			unlinkSync(path.join(stateRoot, artifact.snapshotPath));
			return true;
		},
	};
};

let defaultStore: BackendStore | undefined;

const getDefaultStore = (): BackendStore => {
	defaultStore ??= openBackendStore({
		stateRoot: process.env.SUPERVILLAIN_WEB_STATE_ROOT,
		tokenKeyPath: process.env.SUPERVILLAIN_WEB_TOKEN_KEY_PATH,
	});
	return defaultStore;
};

/** Compatibility wrapper for #101's tracer route; #104 replaces its lifecycle. */
export const getArtifact = (capability: string): Artifact | undefined =>
	getDefaultStore().getArtifact(capability);

/** Compatibility wrapper for #101's unauthenticated tracer ingest only. */
export const ingestArtifact = (artifact: Artifact): string =>
	getDefaultStore().ingestArtifact({
		...artifact,
		ownerIdentity: "tracer-owner",
	});
