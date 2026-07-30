/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; apps/web ships as nitro's bun preset (ADR-0020). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApi } from "../src/server/api";
import type { BackendStore } from "../src/server/store";
import { openBackendStore } from "../src/server/store";

let root = "";
let store: BackendStore;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "supervillain-web-api-"));
	store = openBackendStore({
		stateRoot: path.join(root, "state"),
		tokenKeyPath: path.join(root, "secrets", "web-token-key"),
	});
});

afterAll(async () => {
	store.close();
	await rm(root, { force: true, recursive: true });
});

const api = createApi({
	ingestArtifact: (artifact) =>
		store.ingestArtifact({ ...artifact, ownerIdentity: "tracer-owner" }),
});

const ingest = (body: unknown) =>
	api.fetch(
		new Request("http://web.test/api/ingest", {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
	);

describe("the mounted Hono API (tracer)", () => {
	test("POST /api/ingest returns 201 with a capability and url", async () => {
		const res = await ingest({
			document: {},
			name: "session zero",
			type: "log",
		});
		expect(res.status).toBe(201);
		const payload = (await res.json()) as { capability: string; url: string };
		expect(payload.capability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(payload.url).toBe(`/a/${payload.capability}`);
	});

	test("an ingested artifact is immediately readable through the store", async () => {
		const res = await ingest({ document: {}, name: "The Vault", type: "map" });
		const { capability } = (await res.json()) as { capability: string };
		expect(store.getArtifact(capability)).toEqual({
			document: {},
			name: "The Vault",
			type: "map",
		});
	});

	test("rejects a non-JSON body", async () => {
		const res = await api.fetch(
			new Request("http://web.test/api/ingest", {
				body: "not json",
				method: "POST",
			})
		);
		expect(res.status).toBe(400);
	});

	test("rejects an unknown artifact type and a missing name", async () => {
		const unknownType = await ingest({ name: "x", type: "sonnet" });
		expect(unknownType.status).toBe(400);
		const emptyName = await ingest({ name: "", type: "log" });
		expect(emptyName.status).toBe(400);
	});

	test("unknown /api routes are 404", async () => {
		const res = await api.fetch(new Request("http://web.test/api/whatever"));
		expect(res.status).toBe(404);
	});
});
