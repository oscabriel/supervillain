import { Hono } from "hono";

import { ingestArtifact, isArtifactType } from "./store";

/**
 * The mounted Hono app — ADR-0020's backend surface. It owns everything
 * under `/api/*`; the server entry routes those requests here before the
 * TanStack Start handler ever sees them. The real routes (authenticated
 * ingest, revoke, list, the auth catch-all, OG regeneration) arrive with
 * #104 and later; the tracer ships one placeholder ingest route in the #43
 * spike's shape.
 */
export const api = new Hono().basePath("/api");

api.post("/ingest", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "body must be JSON" }, 400);
	}
	if (typeof body !== "object" || body === null) {
		return c.json({ error: "body must be an object" }, 400);
	}
	const { type, name, document } = body as Record<string, unknown>;
	if (!isArtifactType(type)) {
		return c.json({ error: "type must be character | log | map" }, 400);
	}
	if (typeof name !== "string" || name.length === 0) {
		return c.json({ error: "name must be a non-empty string" }, 400);
	}
	const capability = ingestArtifact({ document, name, type });
	return c.json({ capability, url: `/a/${capability}` }, 201);
});
