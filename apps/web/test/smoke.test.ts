/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/no-await-in-loop -- Bun-only suite; booting a real server is polled, not parallel. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
const base = `http://localhost:${port}`;
let server: ReturnType<typeof Bun.spawn> | undefined;
let stateParent = "";

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
	await rm(stateParent, { force: true, recursive: true });
});

describe("production output under bun (tracer)", () => {
	test("GET / is server-rendered 200", async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("supervillain");
	});

	test("GET /a/:capability SSRs a known artifact", async () => {
		const ingest = await fetch(`${base}/api/ingest`, {
			body: JSON.stringify({
				document: {},
				name: "Doctor Malignant",
				type: "character",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const { url } = (await ingest.json()) as { readonly url: string };
		const res = await fetch(`${base}${url}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Doctor Malignant");
	});

	test("GET /a/:capability is 404 for an unknown capability", async () => {
		const res = await fetch(`${base}/a/no-such-capability`);
		expect(res.status).toBe(404);
	});

	test("POST /api/ingest lands on the mounted Hono app and reads back over SSR", async () => {
		const res = await fetch(`${base}/api/ingest`, {
			body: JSON.stringify({
				document: {},
				name: "Smoke Session",
				type: "log",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(res.status).toBe(201);
		const { capability, url } = (await res.json()) as {
			capability: string;
			url: string;
		};
		expect(url).toBe(`/a/${capability}`);
		const page = await fetch(`${base}${url}`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Smoke Session");
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
