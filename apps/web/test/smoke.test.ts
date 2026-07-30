/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/no-await-in-loop -- Bun-only suite; booting a real server is polled, not parallel. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The production-build-and-boot smoke — the tracer's whole point (#101,
 * ADR-0020): `vite build` with nitro's bun preset, boot the `.output` with
 * plain `bun`, drive every tracer route over real HTTP, and prove SIGTERM
 * drains to exit 0 (src/server/shutdown.ts — the preset alone would die 143).
 */
const appDir = path.join(import.meta.dir, "..");
const port = 4890;
const conduitPort = 4891;
const base = `http://localhost:${port}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicJwk = publicKey.export({ format: "jwk" });
if (typeof publicJwk.x !== "string") {
	throw new TypeError("smoke key did not expose raw public material");
}
const publicKeyHex = Buffer.from(publicJwk.x, "base64url").toString("hex");
let server: ReturnType<typeof Bun.spawn> | undefined;
let conduit: ReturnType<typeof Bun.serve> | undefined;
let stateParent = "";

const snapshot = (title: string) => ({
	artifactType: "character",
	card: { description: "Production smoke", fields: [], title },
	schemaVersion: 1,
	sections: [],
});

const expectArtifactHeaders = (response: Response): void => {
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(response.headers.get("x-robots-tag")).toBe("noindex");
};

const authenticatedFetch = async (
	pathname: string,
	init?: RequestInit
): Promise<Response> => {
	const challengeResponse = await fetch(`${base}/api/publish/challenge`, {
		body: JSON.stringify({ key: publicKeyHex }),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	const { challenge } = (await challengeResponse.json()) as {
		readonly challenge: string;
	};
	const signature = sign(
		null,
		Buffer.from(`supervillain/publish-http/1\n${challenge}\n${publicKeyHex}`),
		privateKey
	).toString("hex");
	const headers = new Headers(init?.headers);
	headers.set("supervillain-key", publicKeyHex);
	headers.set("supervillain-challenge", challenge);
	headers.set("supervillain-signature", signature);
	return fetch(`${base}${pathname}`, { ...init, headers });
};

const waitForBoot = async (): Promise<void> => {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const up = await fetch(`${base}/`, { signal: AbortSignal.timeout(500) })
			.then(() => true)
			.catch(() => false);
		if (up) {
			return;
		}
		await Bun.sleep(100);
	}
	throw new Error("server never answered");
};

beforeAll(async () => {
	stateParent = await mkdtemp(path.join(tmpdir(), "supervillain-web-smoke-"));
	conduit = Bun.serve({
		fetch: async (request) => {
			const body = (await request.json()) as { readonly key?: string };
			return Response.json({
				identityId: body.key === publicKeyHex ? "smoke-identity" : null,
				ownerIdentityIds: body.key === publicKeyHex ? ["smoke-identity"] : [],
				revoked: false,
			});
		},
		hostname: "127.0.0.1",
		port: conduitPort,
	});
	const build = Bun.spawn(["bun", "run", "build"], {
		cwd: appDir,
		stderr: "pipe",
		stdout: "pipe",
	});
	if ((await build.exited) !== 0) {
		throw new Error(
			`vite build failed:\n${await new Response(build.stderr).text()}`
		);
	}
	server = Bun.spawn(["bun", ".output/server/index.mjs"], {
		cwd: appDir,
		env: {
			...process.env,
			PORT: String(port),
			SUPERVILLAIN_IDENTITY_CONDUIT_URL: `http://127.0.0.1:${conduitPort}`,
			SUPERVILLAIN_WEB_STATE_ROOT: path.join(stateParent, "state"),
			SUPERVILLAIN_WEB_TOKEN_KEY_PATH: path.join(
				stateParent,
				"secrets",
				"web-token-key"
			),
		},
		stderr: "ignore",
		stdout: "ignore",
	});
	await waitForBoot();
}, 120_000);

afterAll(async () => {
	server?.kill();
	await server?.exited;
	conduit?.stop(true);
	await rm(stateParent, { force: true, recursive: true });
});

describe("production output under bun", () => {
	test("GET / is server-rendered 200", async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("supervillain");
	});

	test("GET /a/:capability SSRs a known artifact", async () => {
		const ingest = await authenticatedFetch("/api/publish", {
			body: JSON.stringify({
				document: snapshot("Doctor Malignant"),
				name: "Doctor Malignant",
				type: "character",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const { url } = (await ingest.json()) as { readonly url: string };
		const res = await fetch(url);
		expect(res.status).toBe(200);
		expectArtifactHeaders(res);
		const html = await res.text();
		expect(html).toContain("Doctor Malignant");
		expect(html).toContain('<meta content="noindex" name="robots"/>');
		expect(html).toContain(
			'<meta content="Doctor Malignant" property="og:title"/>'
		);
		expect(html).toContain(
			'<meta content="Production smoke" property="og:description"/>'
		);
		expect(html).toContain(
			`<meta content="${url}/og.png" property="og:image"/>`
		);
		expect(html).toContain('<meta content="website" property="og:type"/>');
		expect(html).toContain(
			'<meta content="summary_large_image" name="twitter:card"/>'
		);
	});

	test("unknown and revoked capabilities share one generic protected 404", async () => {
		const ingest = await authenticatedFetch("/api/publish", {
			body: JSON.stringify({
				document: snapshot("Revoked Character"),
				name: "Revoked Character",
				type: "character",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const { capability } = (await ingest.json()) as {
			readonly capability: string;
		};
		const revoke = await authenticatedFetch("/api/publish", {
			body: JSON.stringify({ name: "Revoked Character", type: "character" }),
			headers: { "content-type": "application/json" },
			method: "DELETE",
		});
		expect(revoke.status).toBe(200);

		const unknown = await fetch(`${base}/a/no-such-capability`);
		const revoked = await fetch(`${base}/a/${capability}`);
		expect(unknown.status).toBe(404);
		expect(revoked.status).toBe(404);
		expectArtifactHeaders(unknown);
		expectArtifactHeaders(revoked);
		expect(await revoked.text()).toBe(await unknown.text());
	});

	test("GET /a/:capability/og.png serves the persisted protected PNG", async () => {
		const ingest = await authenticatedFetch("/api/publish", {
			body: JSON.stringify({
				document: snapshot("Card Character"),
				name: "Card Character",
				type: "character",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const { capability } = (await ingest.json()) as {
			readonly capability: string;
		};

		const card = await fetch(`${base}/a/${capability}/og.png`);

		expect(card.status).toBe(200);
		expect(card.headers.get("content-type")).toBe("image/png");
		expectArtifactHeaders(card);
		const cardBytes = await card.arrayBuffer();
		expect(cardBytes.byteLength).toBeGreaterThan(10_000);
	});

	test("unknown and revoked OG paths share the page's generic protected 404", async () => {
		const ingest = await authenticatedFetch("/api/publish", {
			body: JSON.stringify({
				document: snapshot("Revoked Card"),
				name: "Revoked Card",
				type: "character",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const { capability } = (await ingest.json()) as {
			readonly capability: string;
		};
		await authenticatedFetch("/api/publish", {
			body: JSON.stringify({ name: "Revoked Card", type: "character" }),
			headers: { "content-type": "application/json" },
			method: "DELETE",
		});

		const pageUnknown = await fetch(`${base}/a/no-such-capability`);
		const unknown = await fetch(`${base}/a/no-such-capability/og.png`);
		const revoked = await fetch(`${base}/a/${capability}/og.png`);
		expect(unknown.status).toBe(404);
		expect(revoked.status).toBe(404);
		expectArtifactHeaders(unknown);
		expectArtifactHeaders(revoked);
		const unknownBody = await unknown.text();
		expect(await revoked.text()).toBe(unknownBody);
		expect(unknownBody).toBe(await pageUnknown.text());
	});

	test("POST /api/publish lands on the mounted Hono app and reads back over SSR", async () => {
		const res = await authenticatedFetch("/api/publish", {
			body: JSON.stringify({
				document: snapshot("Smoke Character"),
				name: "Smoke Character",
				type: "character",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(res.status).toBe(201);
		const { capability, url } = (await res.json()) as {
			capability: string;
			url: string;
		};
		expect(url).toBe(`${base}/a/${capability}`);
		const page = await fetch(url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Smoke Character");
	});

	test("static assets are served", async () => {
		const res = await fetch(`${base}/site.css`);
		expect(res.status).toBe(200);
	});

	test("SIGTERM drains to exit 0", async () => {
		const proc = server;
		if (!proc) {
			throw new Error("server never started");
		}
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(0);
		server = undefined;
	}, 15_000);
});
