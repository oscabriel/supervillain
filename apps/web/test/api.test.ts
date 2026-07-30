/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; apps/web ships as nitro's bun preset (ADR-0020). */
import { describe, expect, test } from "bun:test";

import { api } from "../src/server/api";
import {
	getArtifact,
	ingestArtifact,
	SEED_CAPABILITY,
} from "../src/server/store";

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
		expect(payload.capability.length).toBeGreaterThan(0);
		expect(payload.url).toBe(`/a/${payload.capability}`);
	});

	test("an ingested artifact is immediately readable through the store", async () => {
		const res = await ingest({ document: {}, name: "The Vault", type: "map" });
		const { capability } = (await res.json()) as { capability: string };
		expect(getArtifact(capability)).toEqual({
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

describe("the in-memory store (tracer)", () => {
	test("is seeded with one artifact", () => {
		expect(getArtifact(SEED_CAPABILITY)?.name).toBe("Doctor Malignant");
	});

	test("mints distinct capabilities per ingest", () => {
		const a = ingestArtifact({ document: null, name: "a", type: "character" });
		const b = ingestArtifact({ document: null, name: "b", type: "character" });
		expect(a).not.toBe(b);
	});

	test("unknown capabilities read as undefined", () => {
		expect(getArtifact("nope")).toBeUndefined();
	});
});
