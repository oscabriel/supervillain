/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite (ADR-0020): the API runs against the real Hono factory, stubbing its clock and nonce source. */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApi } from "../src/server/api";
import type { AsyncIdentityDirectory } from "../src/server/identity-directory";
import type { BackendStore } from "../src/server/store";
import { openBackendStore } from "../src/server/store";

const AUTH_DOMAIN = "supervillain/publish-http/1\n";
// Mirrors the server constants the suite pins: the publish body ceiling is
// the snapshot limit plus 4 KiB envelope slack; the challenge table refuses
// at 4096 outstanding TTL-live entries.
const TEN_MEBIBYTES = 10 * 1024 * 1024;
const HEADROOM_BYTES = 4096;
const MAX_PUBLISH_BODY_BYTES = TEN_MEBIBYTES + HEADROOM_BYTES;
const CHALLENGE_BODY_MAX_BYTES = 1024;
const MAX_OUTSTANDING_CHALLENGES = 4096;
const AUTH_CHALLENGE_TTL_MS = 2 * 60 * 1000;

interface TestKey {
	readonly publicKeyHex: string;
	readonly sign: (challenge: string) => string;
}

const createTestKey = (): TestKey => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const jwk = publicKey.export({ format: "jwk" });
	if (jwk.x === undefined) {
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

const snapshot = (title: string) => ({
	artifactType: "character",
	card: { description: "Publish-limits probe", fields: [], title },
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

interface Harness {
	readonly advanceClock: (milliseconds: number) => void;
	readonly identities: Map<
		string,
		{
			readonly identityId?: string;
			readonly ownerIdentityIds: readonly string[];
			readonly revoked: boolean;
		}
	>;
	readonly mintChallenge: (keyHex: string) => Promise<Response>;
	readonly publish: (
		key: TestKey,
		init: Omit<RequestInit, "method">
	) => Promise<Response>;
	readonly request: (pathname: string, init?: RequestInit) => Promise<Response>;
}

const createHarness = async (): Promise<Harness> => {
	const root = await mkdtemp(path.join(tmpdir(), "supervillain-web-limits-"));
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
	// Stubbed time and nonce source let the suite drive TTL expiry and fill
	// the challenge table deterministically without sleeping.
	let now = 1_700_000_000_000;
	let challengeSeq = 0;
	const api = createApi({
		clock: () => now,
		directory,
		newChallenge: () => (challengeSeq += 1).toString(16).padStart(64, "0"),
		store,
	});
	const request = (pathname: string, init?: RequestInit) =>
		api.fetch(new Request(`https://supervillain.test${pathname}`, init));
	const mintChallenge = (keyHex: string) =>
		request("/api/publish/challenge", {
			body: JSON.stringify({ key: keyHex }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
	const authenticated = async (
		key: TestKey,
		pathname: string,
		init?: RequestInit
	) => {
		const challengeResponse = await mintChallenge(key.publicKeyHex);
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
	const publish = (key: TestKey, init: Omit<RequestInit, "method">) =>
		authenticated(key, "/api/publish", { ...init, method: "POST" });
	return {
		advanceClock: (milliseconds) => {
			now += milliseconds;
		},
		identities,
		mintChallenge,
		publish,
		request,
	};
};

describe("publish request caps", () => {
	test("refuses a publish body over the byte cap before parsing it", async () => {
		const { identities, publish } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		// Valid JSON whose total body exceeds the cap: the response must carry
		// the cap code, proving enforcement happened ahead of the JSON parse
		// (which would otherwise have surfaced `snapshot-too-large` or a 400).
		const body = JSON.stringify({
			document: {
				artifactType: "character",
				futurePayload: "x".repeat(MAX_PUBLISH_BODY_BYTES),
				schemaVersion: 2,
			},
			name: "too big",
			type: "character",
		});

		const response = await publish(key, {
			body,
			headers: { "content-type": "application/json" },
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: {
				code: "body-too-large",
				message: "Request body exceeds the allowed size.",
			},
		});
	});

	test("caps a chunked publish body even when content-length is absent", async () => {
		const { identities, publish } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});
		const body = JSON.stringify({
			document: {
				artifactType: "character",
				futurePayload: "x".repeat(MAX_PUBLISH_BODY_BYTES),
				schemaVersion: 2,
			},
			name: "chunked",
			type: "character",
		});
		const encoded = new TextEncoder().encode(body);

		const response = await publish(key, {
			// Streamed body: no content-length exists on the outgoing request.
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(encoded.subarray(0, 1024));
					controller.enqueue(encoded.subarray(1024));
					controller.close();
				},
			}),
			headers: { "content-type": "application/json" },
		} as RequestInit);

		expect(response.status).toBe(413);
		expect(
			((await response.json()) as { readonly error: { readonly code: string } })
				.error.code
		).toBe("body-too-large");
	});

	test("a small legitimate publish still succeeds end-to-end", async () => {
		const { identities, publish } = await createHarness();
		const key = createTestKey();
		identities.set(key.publicKeyHex, {
			identityId: "identity-1",
			ownerIdentityIds: ["identity-1"],
			revoked: false,
		});

		const response = await publish(key, {
			body: JSON.stringify({
				document: snapshot("Doctor Malignant"),
				name: "Doctor Malignant",
				type: "character",
			}),
			headers: { "content-type": "application/json" },
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
	});

	test("challenges refuse at the outstanding-table cap until entries expire", async () => {
		const { advanceClock, mintChallenge } = await createHarness();
		const floodKey = "b".repeat(64);
		for (let index = 0; index < MAX_OUTSTANDING_CHALLENGES; index += 1) {
			// Filling the table is necessarily sequential; each mint may refuse
			// once the cap lands.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const filled = await mintChallenge(floodKey);
			expect(filled.status).toBe(201);
		}

		const refused = await mintChallenge(floodKey);
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({
			error: {
				code: "challenge-capacity",
				message: "Too many outstanding challenges. Retry shortly.",
			},
		});

		advanceClock(AUTH_CHALLENGE_TTL_MS + 1);
		const freed = await mintChallenge(floodKey);
		expect(freed.status).toBe(201);
	});

	test("an oversized challenge body is refused at its tighter cap", async () => {
		const { mintChallenge, request } = await createHarness();

		// Content-length preview path: 1025 JSON bytes already exceed the cap
		// (CHALLENGE_BODY_MAX_BYTES minus envelope framing).
		const longKeyBody = `{"key":"${"c".repeat(CHALLENGE_BODY_MAX_BYTES)}"}`;
		const oversized = await request("/api/publish/challenge", {
			body: longKeyBody,
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toEqual({
			error: {
				code: "body-too-large",
				message: "Request body exceeds the allowed size.",
			},
		});

		// A well-formed body stays under the cap and mints normally.
		const healthy = await mintChallenge("d".repeat(64));
		expect(healthy.status).toBe(201);
	});
});
