/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; apps/web ships as nitro's bun preset (ADR-0020). */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApi } from "../src/server/api";
import type { AsyncIdentityDirectory } from "../src/server/identity-directory";
import type { BackendStore } from "../src/server/store";
import { openBackendStore } from "../src/server/store";

const AUTH_DOMAIN = "supervillain/publish-http/1\n";
const TEN_MEBIBYTES = 10 * 1024 * 1024;

interface TestKey {
	readonly publicKeyHex: string;
	readonly sign: (challenge: string) => string;
}

const createTestKey = (): TestKey => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const jwk = publicKey.export({ format: "jwk" });
	if (typeof jwk.x !== "string") {
		throw new TypeError("test key did not expose raw public material");
	}
	const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");
	return {
		publicKeyHex,
		sign: (challenge) =>
			Buffer.from(
				sign(
					null,
					Buffer.from(`${AUTH_DOMAIN}${challenge}\n${publicKeyHex}`),
					privateKey
				)
			).toString("hex"),
	};
};

const snapshot = (title: string, description = "A test snapshot") => ({
	artifactType: "character",
	card: { description, fields: [], title },
	schemaVersion: 1,
	sections: [],
});

const roots: string[] = [];
const stores: BackendStore[] = [];

afterEach(async () => {
	for (const store of stores.splice(0)) {
		store.close();
	}
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
	);
});

const createHarness = async () => {
	const root = await mkdtemp(path.join(tmpdir(), "supervillain-web-api-"));
	roots.push(root);
	const store = openBackendStore({
		stateRoot: path.join(root, "state"),
		tokenKeyPath: path.join(root, "secrets", "web-token-key"),
	});
	stores.push(store);
	const identities = new Map<
		string,
		{
			readonly identityId?: string;
			readonly ownerIdentityIds: readonly string[];
			readonly revoked: boolean;
		}
	>();
	const directory: AsyncIdentityDirectory = {
		resolveKey: (key) =>
			Promise.resolve(
				identities.get(key) ?? { ownerIdentityIds: [], revoked: false }
			),
	};
	const api = createApi({
		directory,
		origin: "https://supervillain.test",
		store,
	});
	const request = (pathname: string, init?: RequestInit) =>
		api.fetch(new Request(`https://supervillain.test${pathname}`, init));
	const authenticated = async (
		key: TestKey,
		pathname: string,
		init?: RequestInit
	) => {
		const challengeResponse = await request("/api/publish/challenge", {
			body: JSON.stringify({ key: key.publicKeyHex }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(challengeResponse.status).toBe(201);
		const { challenge } = (await challengeResponse.json()) as {
			readonly challenge: string;
		};
		const headers = new Headers(init?.headers);
		headers.set("supervillain-key", key.publicKeyHex);
		headers.set("supervillain-challenge", challenge);
		headers.set("supervillain-signature", key.sign(challenge));
		return request(pathname, { ...init, headers });
	};
	const publish = (key: TestKey, body: unknown) =>
		authenticated(key, "/api/publish", {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
	return { api, authenticated, identities, publish, request, root, store };
};

describe("the authenticated publish API", () => {
	test("ingests a version-1 snapshot for the authenticated identity", async () => {
		const { identities, publish, store } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});

		const response = await publish(key, {
			document: snapshot("Doctor Malignant"),
			name: "Doctor Malignant",
			type: "character",
		});

		expect(response.status).toBe(201);
		const payload = (await response.json()) as {
			readonly capability: string;
			readonly url: string;
		};
		expect(payload.capability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(payload.url).toBe(
			`https://supervillain.test/a/${payload.capability}`
		);
		expect(store.getArtifact(payload.capability)?.document).toEqual(
			snapshot("Doctor Malignant")
		);
	});

	test("publish renders a card and re-publish regenerates it in place", async () => {
		const { identities, publish, root, store } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		const artifact = { name: "Doctor Malignant", type: "character" } as const;
		const first = await publish(key, {
			...artifact,
			document: snapshot("Doctor Malignant", "Before"),
		});
		const firstBody = (await first.json()) as { readonly url: string };
		const ogDirectory = path.join(root, "state", "og");
		const [ogName] = readdirSync(ogDirectory);
		expect(ogName).toMatch(/^[0-9a-f-]+\.png$/u);
		const firstPng = readFileSync(path.join(ogDirectory, ogName ?? ""));

		const second = await publish(key, {
			...artifact,
			document: snapshot("Doctor Malignant", "After"),
		});
		const secondBody = (await second.json()) as {
			readonly capability: string;
			readonly url: string;
		};

		expect(second.status).toBe(200);
		expect(secondBody.url).toBe(firstBody.url);
		expect(store.getArtifact(secondBody.capability)?.document).toEqual(
			snapshot("Doctor Malignant", "After")
		);
		expect(readdirSync(ogDirectory)).toEqual([ogName]);
		expect(
			readFileSync(path.join(ogDirectory, ogName ?? "")).equals(firstPng)
		).toBe(false);
	});

	test("revoke tombstones the URL, deletes its snapshot and card, and never resurrects it", async () => {
		const { authenticated, identities, publish, root, store } =
			await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		const artifact = { name: "Doctor Malignant", type: "character" } as const;
		const first = await publish(key, {
			...artifact,
			document: snapshot("Doctor Malignant"),
		});
		const firstBody = (await first.json()) as {
			readonly capability: string;
		};
		expect(readdirSync(path.join(root, "state", "og"))).toHaveLength(1);

		const revoked = await authenticated(key, "/api/publish", {
			body: JSON.stringify(artifact),
			headers: { "content-type": "application/json" },
			method: "DELETE",
		});
		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toEqual({
			message:
				"Revoked. Chat apps may retain unfurl previews already rendered in chat history.",
		});
		expect(store.getArtifact(firstBody.capability)).toBeUndefined();
		expect(readdirSync(path.join(root, "state", "og"))).toHaveLength(0);

		const republished = await publish(key, {
			...artifact,
			document: snapshot("Doctor Malignant", "Fresh"),
		});
		const republishedBody = (await republished.json()) as {
			readonly capability: string;
		};
		expect(republishedBody.capability).not.toBe(firstBody.capability);
		expect(store.getArtifact(firstBody.capability)).toBeUndefined();
	});

	test("authenticated owners can regenerate a missing card", async () => {
		const { authenticated, identities, publish, root } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		await publish(key, {
			document: snapshot("Doctor Malignant"),
			name: "Doctor Malignant",
			type: "character",
		});
		const ogDirectory = path.join(root, "state", "og");
		const [ogName] = readdirSync(ogDirectory);
		await rm(path.join(ogDirectory, ogName ?? ""));

		const regenerated = await authenticated(key, "/api/publish/og", {
			body: JSON.stringify({ name: "Doctor Malignant", type: "character" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(regenerated.status).toBe(200);
		expect(await regenerated.json()).toEqual({ card: "regenerated" });
		expect(readdirSync(ogDirectory)).toEqual([ogName]);
	});

	test("regeneration authenticates and hides unknown or non-owned artifacts", async () => {
		const { authenticated, identities, publish, request } =
			await createHarness();
		const owner = createTestKey();
		const outsider = createTestKey();
		identities.set(owner.publicKeyHex, {
			identityId: "identity-owner",
			ownerIdentityIds: ["identity-owner"],
			revoked: false,
		});
		identities.set(outsider.publicKeyHex, {
			identityId: "identity-outsider",
			ownerIdentityIds: ["identity-outsider"],
			revoked: false,
		});
		await publish(owner, {
			document: snapshot("Private Character"),
			name: "Private Character",
			type: "character",
		});
		const unknownBody = JSON.stringify({ name: "missing", type: "character" });
		const nonOwnedBody = JSON.stringify({
			name: "Private Character",
			type: "character",
		});

		const unauthenticated = await request("/api/publish/og", {
			body: unknownBody,
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const unknown = await authenticated(outsider, "/api/publish/og", {
			body: unknownBody,
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const nonOwned = await authenticated(outsider, "/api/publish/og", {
			body: nonOwnedBody,
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(unauthenticated.status).toBe(401);
		expect(unknown.status).toBe(404);
		expect(nonOwned.status).toBe(404);
		expect(await nonOwned.json()).toEqual(await unknown.json());
	});

	test("lists every live artifact and reconstructs its full URL", async () => {
		const { authenticated, identities, publish } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		const published = await publish(key, {
			document: snapshot("Doctor Malignant"),
			name: "Doctor Malignant",
			type: "character",
		});
		const { url } = (await published.json()) as { readonly url: string };

		const response = await authenticated(key, "/api/publish");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			readonly artifacts: readonly Record<string, unknown>[];
		};
		expect(body.artifacts).toHaveLength(1);
		expect(body.artifacts[0]).toMatchObject({
			name: "Doctor Malignant",
			type: "character",
			url,
		});
		expect(body.artifacts[0]?.publishedAt).toMatch(/Z$/u);
	});

	test("rejects a snapshot over the 10 MB operational cap structurally", async () => {
		const { identities, publish } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		const response = await publish(key, {
			document: {
				artifactType: "character",
				futurePayload: "x".repeat(TEN_MEBIBYTES),
				schemaVersion: 2,
			},
			name: "too large",
			type: "character",
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: {
				code: "snapshot-too-large",
				limitBytes: TEN_MEBIBYTES,
				message: "Snapshot document exceeds the 10 MB publish limit.",
			},
		});
	});

	test("linked-owner collision refuses overwrite and lists both stable URLs", async () => {
		const { identities, publish } = await createHarness();
		const oldKey = createTestKey();
		const currentKey = createTestKey();
		identities.set(oldKey.publicKeyHex, {
			identityId: "identity-old",
			ownerIdentityIds: ["identity-old"],
			revoked: false,
		});
		identities.set(currentKey.publicKeyHex, {
			identityId: "identity-current",
			ownerIdentityIds: ["identity-current"],
			revoked: false,
		});
		const artifact = { name: "shared", type: "character" } as const;
		const oldPublish = await publish(oldKey, {
			...artifact,
			document: snapshot("Old URL"),
		});
		const currentPublish = await publish(currentKey, {
			...artifact,
			document: snapshot("Current URL"),
		});
		const oldUrl = ((await oldPublish.json()) as { readonly url: string }).url;
		const currentUrl = (
			(await currentPublish.json()) as { readonly url: string }
		).url;
		identities.set(currentKey.publicKeyHex, {
			identityId: "identity-current",
			ownerIdentityIds: ["identity-current", "identity-old"],
			revoked: false,
		});

		const collision = await publish(currentKey, {
			...artifact,
			document: snapshot("Must not overwrite"),
		});
		expect(collision.status).toBe(409);
		expect(await collision.json()).toEqual({
			error: {
				code: "linked-artifact-collision",
				message:
					"Linked identities own more than one artifact with this type and name. Revoke one before re-publishing.",
				urls: [currentUrl, oldUrl],
			},
		});
	});

	test("accepts structurally valid unknown snapshot majors without interpreting them", async () => {
		const { identities, publish } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		const response = await publish(key, {
			document: {
				artifactType: "character",
				futurePayload: { presentation: "owned by version 2" },
				schemaVersion: 2,
			},
			name: "future",
			type: "character",
		});
		expect(response.status).toBe(201);
	});

	test("rejects revoked keys after signature verification", async () => {
		const { identities, publish } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: true,
		});
		const response = await publish(key, {
			document: snapshot("Retired"),
			name: "retired",
			type: "character",
		});
		expect(response.status).toBe(401);
	});
});
