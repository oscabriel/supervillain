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

export default {
	fetch(request: Request): Response | Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/api" || pathname.startsWith("/api/")) {
			return api.fetch(request);
		}
		return startHandler(request);
	},
};
