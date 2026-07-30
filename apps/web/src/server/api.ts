import { Hono } from "hono";

import type { Artifact } from "./store";
import { ingestArtifact, isArtifactType } from "./store";

interface TracerStore {
	readonly ingestArtifact: (artifact: Artifact) => string;
}

/**
 * The mounted Hono app — ADR-0020's backend surface. It owns everything under
 * `/api/*`. #104 replaces this unauthenticated tracer route with the real
 * publish lifecycle; injection keeps this placeholder from owning store state.
 */
export const createApi = (store?: TracerStore): Hono => {
	const activeStore = store ?? { ingestArtifact };
	const app = new Hono().basePath("/api");
	app.post("/ingest", async (c) => {
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
		const capability = activeStore.ingestArtifact({ document, name, type });
		return c.json({ capability, url: `/a/${capability}` }, 201);
	});
	return app;
};

export const api = createApi();
