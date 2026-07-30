import type { Register } from "@tanstack/react-router";
import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import type { RequestHandler } from "@tanstack/react-start/server";

import { api } from "./server/api";

/**
 * The server entry — where ADR-0020's "Hono mounted inside the TanStack
 * server" happens. One Fetch handler, one process: `/api/*` belongs to the
 * Hono app (ingest, revoke, auth catch-all, OG — the machine-facing
 * surface), everything else to TanStack Start's SSR handler (marketing,
 * docs, artifact pages).
 */
const startHandler: RequestHandler<Register> =
	createStartHandler(defaultStreamHandler);

const ARTIFACT_ROUTE_PREFIX = "/a/";
/** The only identifier an app logger may receive for this route (ADR-0022). */
export const ARTIFACT_ROUTE_PATTERN = "/a/:capability";
const ARTIFACT_NOT_FOUND_BODY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title><link rel="stylesheet" href="/site.css"></head><body><main><h1>Not found</h1><p>No artifact lives at this address.</p></main></body></html>`;

const protectArtifactResponse = (response: Response): Response => {
	const headers = new Headers(response.headers);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Cache-Control", "private, no-store");
	headers.set("X-Robots-Tag", "noindex");
	if (response.status === 404) {
		// TanStack's hydration state includes route params. Replacing the whole
		// not-found response keeps the capability out of the generic body and
		// makes unknown and tombstoned results byte-identical (ADR-0022).
		headers.set("Content-Type", "text/html; charset=utf-8");
		return new Response(ARTIFACT_NOT_FOUND_BODY, { headers, status: 404 });
	}
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
};

export default {
	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/api" || pathname.startsWith("/api/")) {
			return api.fetch(request);
		}
		const response = await startHandler(request);
		return pathname.startsWith(ARTIFACT_ROUTE_PREFIX)
			? protectArtifactResponse(response)
			: response;
	},
};
