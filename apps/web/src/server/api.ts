import {
	createPublicKey,
	randomBytes,
	verify as verifySignature,
} from "node:crypto";

import { validateSnapshotDocument } from "@supervillain/core";
import { Hono } from "hono";

import { createRemoteIdentityDirectory } from "./identity-directory";
import type {
	AsyncIdentityDirectory,
	ResolvedPublishIdentity,
} from "./identity-directory";
import { renderArtifactCard } from "./og";
import { getDefaultStore, isArtifactType } from "./store";
import type { ArtifactType, BackendStore } from "./store";
import { fullArtifactUrl } from "./urls";

const AUTH_DOMAIN = "supervillain/publish-http/1\n";
const AUTH_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const AUTH_NONCE_BYTES = 32;
const HEX_KEY = /^[0-9a-f]{64}$/u;
const HEX_CHALLENGE = /^[0-9a-f]{64}$/u;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/u;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SNAPSHOT_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_IDENTITY_CONDUIT_URL = "http://127.0.0.1:3002";
const REVOKE_MESSAGE =
	"Revoked. Chat apps may retain unfurl previews already rendered in chat history.";

interface ChallengeRecord {
	readonly expiresAt: number;
	readonly key: string;
}

export interface PublishApiOptions {
	readonly directory?: AsyncIdentityDirectory;
	readonly store?: BackendStore;
	readonly origin?: string;
	readonly clock?: () => number;
	readonly newChallenge?: () => string;
}

interface PublishBody {
	readonly document: unknown;
	readonly name: string;
	readonly type: ArtifactType;
}

interface RevokeBody {
	readonly capability?: string;
	readonly name: string;
	readonly type: ArtifactType;
}

type AuthenticationResult =
	| {
			readonly ok: true;
			readonly identity: ResolvedPublishIdentity & {
				readonly identityId: string;
			};
	  }
	| { readonly ok: false; readonly unavailable?: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const publicKeyFromHex = (key: string) =>
	createPublicKey({
		format: "der",
		key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key, "hex")]),
		type: "spki",
	});

const signedChallenge = (challenge: string, key: string): Buffer =>
	Buffer.from(`${AUTH_DOMAIN}${challenge}\n${key}`);

const parsePublishBody = (body: unknown): PublishBody | undefined => {
	if (!isRecord(body)) {
		return;
	}
	const { document, name, type } = body;
	if (
		!isArtifactType(type) ||
		typeof name !== "string" ||
		name.length === 0 ||
		document === undefined
	) {
		return;
	}
	return { document, name, type };
};

const parseRevokeBody = (body: unknown): RevokeBody | undefined => {
	if (!isRecord(body)) {
		return;
	}
	const { capability, name, type } = body;
	if (
		!isArtifactType(type) ||
		typeof name !== "string" ||
		name.length === 0 ||
		(capability !== undefined && typeof capability !== "string")
	) {
		return;
	}
	return { capability, name, type };
};

const validateDocument = (
	document: unknown,
	type: ArtifactType
): string | undefined => {
	if (!isRecord(document)) {
		return "Snapshot document must be an object.";
	}
	if (
		!Number.isSafeInteger(document.schemaVersion) ||
		(document.schemaVersion as number) < 1
	) {
		return "Snapshot document schemaVersion must be a positive integer.";
	}
	if (document.artifactType !== type) {
		return "Snapshot document artifactType must match the published type.";
	}
	if (document.schemaVersion === 1) {
		const validated = validateSnapshotDocument(document);
		if (!validated.ok) {
			return validated.errors.map(({ message }) => message).join(" ");
		}
	}
	// Unknown integer majors stay opaque. The CLI that knows that version owns
	// its schema; storing raw is what lets the backend render every accepted one.
};

const documentBytes = (document: unknown): number | undefined => {
	const serialized = JSON.stringify(document);
	return serialized === undefined
		? undefined
		: Buffer.byteLength(serialized, "utf-8");
};

const renderAndPersistCard = async (
	backendStore: BackendStore,
	capability: string,
	document: unknown
): Promise<boolean> => {
	const validated = validateSnapshotDocument(document);
	if (!validated.ok) {
		backendStore.deleteArtifactCard(capability);
		return false;
	}
	try {
		const png = await renderArtifactCard(validated.document);
		return backendStore.writeArtifactCard(capability, png);
	} catch {
		// #107 chooses publish-without-card: the durable artifact must survive a
		// native renderer failure, while a stale card must not misrepresent it.
		backendStore.deleteArtifactCard(capability);
		return false;
	}
};

/** ADR-0020's mounted machine-facing surface and ADR-0009's publish lifecycle. */
// oxlint-disable-next-line eslint/max-lines-per-function -- route registration is the Hono app's cohesive public surface.
export const createApi = (options: PublishApiOptions = {}): Hono => {
	const store = (): BackendStore => options.store ?? getDefaultStore();
	const directory =
		options.directory ??
		createRemoteIdentityDirectory({
			conduitUrl:
				process.env.SUPERVILLAIN_IDENTITY_CONDUIT_URL ??
				DEFAULT_IDENTITY_CONDUIT_URL,
		});
	const clock = options.clock ?? Date.now;
	const newChallenge =
		options.newChallenge ??
		(() => randomBytes(AUTH_NONCE_BYTES).toString("hex"));
	const challenges = new Map<string, ChallengeRecord>();

	const issueChallenge = (key: string): string => {
		const now = clock();
		for (const [challenge, record] of challenges) {
			if (record.expiresAt <= now) {
				challenges.delete(challenge);
			}
		}
		const challenge = newChallenge();
		if (!HEX_CHALLENGE.test(challenge)) {
			throw new Error(
				"Publish auth challenge must be 32 bytes of lowercase hex"
			);
		}
		challenges.set(challenge, {
			expiresAt: now + AUTH_CHALLENGE_TTL_MS,
			key,
		});
		return challenge;
	};

	const authenticate = async (
		request: Request
	): Promise<AuthenticationResult> => {
		const key = request.headers.get("supervillain-key");
		const challenge = request.headers.get("supervillain-challenge");
		const signature = request.headers.get("supervillain-signature");
		if (
			key === null ||
			challenge === null ||
			signature === null ||
			!HEX_KEY.test(key) ||
			!HEX_CHALLENGE.test(challenge) ||
			!HEX_SIGNATURE.test(signature)
		) {
			return { ok: false };
		}
		const issued = challenges.get(challenge);
		challenges.delete(challenge);
		if (
			issued === undefined ||
			issued.key !== key ||
			issued.expiresAt <= clock()
		) {
			return { ok: false };
		}
		let verified = false;
		try {
			verified = verifySignature(
				null,
				signedChallenge(challenge, key),
				publicKeyFromHex(key),
				Buffer.from(signature, "hex")
			);
		} catch {
			return { ok: false };
		}
		if (!verified) {
			return { ok: false };
		}
		let identity: ResolvedPublishIdentity;
		try {
			identity = await directory.resolveKey(key);
		} catch {
			return { ok: false, unavailable: true };
		}
		if (
			identity.revoked ||
			identity.identityId === undefined ||
			identity.ownerIdentityIds.length === 0
		) {
			return { ok: false };
		}
		return {
			identity: { ...identity, identityId: identity.identityId },
			ok: true,
		};
	};

	const app = new Hono().basePath("/api");
	app.post("/publish/challenge", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "body must be JSON" }, 400);
		}
		if (
			!isRecord(body) ||
			typeof body.key !== "string" ||
			!HEX_KEY.test(body.key)
		) {
			return c.json({ error: "key must be 64 lowercase hex chars" }, 400);
		}
		return c.json({ challenge: issueChallenge(body.key) }, 201);
	});

	app.post("/publish", async (c) => {
		const authenticated = await authenticate(c.req.raw);
		if (!authenticated.ok) {
			return c.json(
				{ error: "authentication failed" },
				authenticated.unavailable === true ? 503 : 401
			);
		}
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "body must be JSON" }, 400);
		}
		const publish = parsePublishBody(body);
		if (publish === undefined) {
			return c.json(
				{ error: "body needs type, non-empty name, and document" },
				400
			);
		}
		const bytes = documentBytes(publish.document);
		if (bytes === undefined) {
			return c.json({ error: "document must be JSON-serializable" }, 400);
		}
		if (bytes > SNAPSHOT_SIZE_LIMIT_BYTES) {
			return c.json(
				{
					error: {
						code: "snapshot-too-large",
						limitBytes: SNAPSHOT_SIZE_LIMIT_BYTES,
						message: "Snapshot document exceeds the 10 MB publish limit.",
					},
				},
				413
			);
		}
		const validationError = validateDocument(publish.document, publish.type);
		if (validationError !== undefined) {
			return c.json(
				{ error: { code: "invalid-snapshot", message: validationError } },
				400
			);
		}
		const backendStore = store();
		const result = backendStore.publishArtifact({
			...publish,
			ownerIdentity: authenticated.identity.identityId,
			ownerIdentityIds: authenticated.identity.ownerIdentityIds,
		});
		if (result.kind === "collision") {
			return c.json(
				{
					error: {
						code: "linked-artifact-collision",
						message:
							"Linked identities own more than one artifact with this type and name. Revoke one before re-publishing.",
						urls: result.capabilities.map((capability) =>
							fullArtifactUrl(capability, c.req.url, options.origin)
						),
					},
				},
				409
			);
		}
		const cardReady = await renderAndPersistCard(
			backendStore,
			result.capability,
			publish.document
		);
		return c.json(
			{
				capability: result.capability,
				card: cardReady ? "ready" : "unavailable",
				publishedAt: result.publishedAt,
				url: fullArtifactUrl(result.capability, c.req.url, options.origin),
			},
			result.created ? 201 : 200
		);
	});

	// FLAG #107 route choice: a child of the existing publish noun, authenticated
	// by the exact challenge/signature flow used by ingest, list, and revoke.
	app.post("/publish/og", async (c) => {
		const authenticated = await authenticate(c.req.raw);
		if (!authenticated.ok) {
			return c.json(
				{ error: "authentication failed" },
				authenticated.unavailable === true ? 503 : 401
			);
		}
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "body must be JSON" }, 400);
		}
		const request = parseRevokeBody(body);
		if (request === undefined) {
			return c.json({ error: "body needs type and non-empty name" }, 400);
		}
		const source = store().getOwnedArtifactCardSource({
			...request,
			ownerIdentityIds: authenticated.identity.ownerIdentityIds,
		});
		if (source === undefined) {
			return c.json({ error: "artifact not found" }, 404);
		}
		const ready = await renderAndPersistCard(
			store(),
			source.capability,
			source.artifact.document
		);
		return ready
			? c.json({ card: "regenerated" })
			: c.json({ error: "snapshot has no card renderer" }, 422);
	});

	app.get("/publish", async (c) => {
		const authenticated = await authenticate(c.req.raw);
		if (!authenticated.ok) {
			return c.json(
				{ error: "authentication failed" },
				authenticated.unavailable === true ? 503 : 401
			);
		}
		return c.json({
			artifacts: store()
				.listArtifacts(authenticated.identity.ownerIdentityIds)
				.map(({ capability, ...artifact }) => ({
					...artifact,
					url: fullArtifactUrl(capability, c.req.url, options.origin),
				})),
		});
	});

	app.delete("/publish", async (c) => {
		const authenticated = await authenticate(c.req.raw);
		if (!authenticated.ok) {
			return c.json(
				{ error: "authentication failed" },
				authenticated.unavailable === true ? 503 : 401
			);
		}
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "body must be JSON" }, 400);
		}
		const revoke = parseRevokeBody(body);
		if (revoke === undefined) {
			return c.json({ error: "body needs type and non-empty name" }, 400);
		}
		const result = store().revokeOwnedArtifact({
			...revoke,
			ownerIdentityIds: authenticated.identity.ownerIdentityIds,
		});
		if (result.kind === "not-found") {
			return c.json({ error: "artifact not found" }, 404);
		}
		if (result.kind === "collision") {
			return c.json(
				{
					error: {
						code: "linked-artifact-collision",
						message: "Name is ambiguous; revoke one capability explicitly.",
						urls: result.capabilities.map((capability) =>
							fullArtifactUrl(capability, c.req.url, options.origin)
						),
					},
				},
				409
			);
		}
		return c.json({ message: REVOKE_MESSAGE });
	});
	return app;
};

export const api = createApi();
