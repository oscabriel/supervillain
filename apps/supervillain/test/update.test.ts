import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

import { Effect, Fiber, Function, Layer } from "effect";
import { TestClock } from "effect/testing";

import { INSTALL_URL } from "../src/relay/lobby/create.ts";
import {
	binaryNameFor,
	checksumFor,
	progressBar,
	runUpdate,
} from "../src/update.ts";
import type { UpdateOptions } from "../src/update.ts";
import { effect, waitFor } from "./host/effect.ts";
import { tempDir } from "./host/tempDir.ts";

const sha256 = (data: string) =>
	createHash("sha256").update(data).digest("hex");

const BINARY =
	binaryNameFor(process.platform, process.arch) ?? "supervillain-linux-x64";

const STAGED_PREFIX = ".supervillain.update.";

type Route = Response | Promise<Response>;

interface Routes {
	readonly [pathname: string]: () => Route;
}

const never = async (): Promise<Response> =>
	await Promise.withResolvers<Response>().promise;

const trickle = (): Response =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("the first bytes"));
			},
		}),
		{ headers: { "content-length": "4096" } }
	);

const serve = (routes: Routes) =>
	Effect.gen(function* () {
		const hits: Array<string> = [];

		const server = yield* Effect.acquireRelease(
			Effect.sync(() =>
				Bun.serve({
					port: 0,
					hostname: "127.0.0.1",
					async fetch(req) {
						const { pathname } = new URL(req.url);
						hits.push(pathname);

						const route = routes[pathname];

						return route === undefined
							? new Response("not found", { status: 404 })
							: await route();
					},
				})
			),
			(running) =>
				Effect.promise(async () => {
					await running.stop(true);
				})
		);

		return { base: server.url.origin, hits };
	});

const releaseRoutes = (
	tag: string,
	binaryBody: string,
	sumsBody: string
): Routes => ({
	"/latest": () => Response.json({ tag_name: tag }),
	[`/download/${tag}/${BINARY}`]: () =>
		new Response(binaryBody, {
			headers: { "content-length": String(Buffer.byteLength(binaryBody)) },
		}),
	[`/download/${tag}/SHA256SUMS`]: () => new Response(sumsBody),
});

const serveReleases = (tag: string, binaryBody: string, sumsBody: string) =>
	serve(releaseRoutes(tag, binaryBody, sumsBody));

const sumsFor = (binaryBody: string) => `${sha256(binaryBody)}  ${BINARY}\n`;

const asked = (over: Partial<UpdateOptions>): UpdateOptions => ({
	check: false,
	force: false,
	version: undefined,
	currentVersion: "0.7.1",
	compiled: true,
	isTTY: false,
	write: Function.constVoid,
	...over,
});

const installedAt = (dir: string, body: string) =>
	Effect.promise(async () => {
		const target = path.join(dir, "supervillain");
		await writeFile(target, body);

		return target;
	});

const textOf = (file: string) =>
	Effect.promise(async () => await readFile(file, "utf-8"));

const namesIn = (dir: string) =>
	Effect.promise(async () => {
		const names = await readdir(dir);

		return names.toSorted();
	});

const stagedIn = (dir: string) =>
	readdirSync(dir).filter((name) => name.startsWith(STAGED_PREFIX));

const stagedBytesIn = (dir: string) =>
	stagedIn(dir).reduce(
		(total, name) => total + statSync(path.join(dir, name)).size,
		0
	);

const tick = Effect.andThen(
	TestClock.adjust("1 minute"),
	Effect.promise(async () => {
		await Bun.sleep(10);
	})
);

const outlasting = <A, E, R>(
	what: string,
	reached: () => boolean,
	body: Effect.Effect<A, E, R>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(TestClock.layer()), (context) =>
			Effect.provideContext(
				Effect.raceFirst(
					body,
					Effect.andThen(waitFor(what, reached), Effect.forever(tick))
				),
				context
			)
		)
	);

describe("update helpers", () => {
	test("maps supported platforms and parses checksums and progress bars", () => {
		expect(binaryNameFor("linux", "x64")).toBe("supervillain-linux-x64");
		expect(binaryNameFor("darwin", "arm64")).toBe("supervillain-darwin-arm64");
		expect(binaryNameFor("win32", "x64")).toBeUndefined();

		const hash = sha256("payload");

		expect(
			checksumFor(`${hash}  supervillain-linux-x64\n`, "supervillain-linux-x64")
		).toBe(hash);
		expect(
			checksumFor(`${hash} *supervillain-linux-x64\n`, "supervillain-linux-x64")
		).toBe(hash);
		expect(
			checksumFor(
				"not-a-hash  supervillain-linux-x64",
				"supervillain-linux-x64"
			)
		).toBeUndefined();

		expect(progressBar(500_000, 1_000_000, 10)).toContain(" 50%");
		expect(progressBar(500_000, undefined, 10)).toContain("KB");
	});
});

describe("supervillain update", () => {
	effect(
		"checks, downloads, verifies SHA256SUMS, and swaps the binary atomically",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const target = yield* installedAt(dir, "old-binary");
				const nextBinary = "new-supervillain-binary-v0.8.0";

				const server = yield* serveReleases(
					"v0.8.0",
					nextBinary,
					sumsFor(nextBinary)
				);

				const releaseBase = server.base;
				let checkOut = "";

				const checked = yield* runUpdate(
					asked({
						check: true,
						releaseBase,
						targetPath: target,
						write: (text) => {
							checkOut += text;
						},
					})
				);

				expect(checked).toEqual({
					status: "available",
					current: "v0.7.1",
					latest: "v0.8.0",
					target: undefined,
				});
				expect(checkOut).toContain("update available: v0.7.1 → v0.8.0");
				expect(checkOut).toContain("run supervillain update to install it");
				expect(yield* textOf(target)).toBe("old-binary");

				let updateOut = "";

				const updated = yield* runUpdate(
					asked({
						releaseBase,
						targetPath: target,
						isTTY: true,
						write: (text) => {
							updateOut += text;
						},
					})
				);

				expect(updated).toEqual({
					status: "updated",
					current: "v0.7.1",
					latest: "v0.8.0",
					target,
				});
				expect(updateOut).toContain("100%");
				expect(updateOut).toContain("checksum verified");
				expect(updateOut).toContain("updated supervillain");
				expect(yield* textOf(target)).toBe(nextBinary);
				expect(
					(yield* Effect.promise(async () => await stat(target))).mode % 0o1000
				).toBe(0o755);
				expect(yield* namesIn(dir)).toEqual(["supervillain"]);

				const upToDate = yield* runUpdate(
					asked({
						currentVersion: "0.8.0",
						releaseBase,
						targetPath: target,
					})
				);

				expect(upToDate.status).toBe("up-to-date");
			})
	);

	effect("orders versions by semver precedence and always shows a v", () =>
		Effect.gen(function* () {
			const statusOf = (currentVersion: string, version: string) =>
				Effect.map(
					runUpdate(asked({ check: true, currentVersion, version })),
					(result) => result.status
				);

			expect(yield* statusOf("0.7.1", "v0.8.0")).toBe("available");
			expect(yield* statusOf("0.8.0", "v0.8.0")).toBe("up-to-date");
			expect(yield* statusOf("v0.8.0", "0.8.0")).toBe("up-to-date");
			expect(yield* statusOf("0.8.0-rc.1", "v0.8.0")).toBe("available");
			expect(yield* statusOf("0.8.0-rc.2", "v0.8.0-rc.10")).toBe("available");
			expect(yield* statusOf("0.9.0", "v0.10.0")).toBe("available");
			expect(yield* statusOf("0.10.0", "v0.9.0")).toBe("ahead");
			expect(yield* statusOf("0.9.0-rc.1", "v0.8.0")).toBe("ahead");
			expect(yield* statusOf("0.8.0", "v0.8.0-rc.1")).toBe("ahead");
			expect(yield* statusOf("0.8.0-alpha", "v0.8.0-alpha.1")).toBe(
				"available"
			);
			expect(yield* statusOf("0.8.0-1", "v0.8.0-alpha")).toBe("available");
			expect(yield* statusOf("0.8.0-beta", "v0.8.0-alpha.9")).toBe("ahead");
			expect(yield* statusOf("0.8.0+local", "v0.8.0")).toBe("up-to-date");
			expect(yield* statusOf("nightly", "v0.8.0")).toBe("available");
			expect(yield* statusOf("nightly", "nightly")).toBe("up-to-date");

			let out = "";

			const blank = yield* runUpdate(
				asked({
					check: true,
					currentVersion: "",
					version: "v0.8.0",
					write: (text) => {
						out += text;
					},
				})
			);

			expect(blank.current).toBe("v0.0.0");
			expect(out).toContain("current   v0.0.0");
			expect(out).toContain("update available: v0.0.0 → v0.8.0");
			expect(out).toContain(
				"run supervillain update --version v0.8.0 to install it"
			);
		})
	);

	effect(
		"won't downgrade a build newer than the latest release unless asked",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const target = yield* installedAt(dir, "the-rc-binary");
				const stable = "the-stable-binary";

				const server = yield* serveReleases("v0.8.0", stable, sumsFor(stable));

				const newer = (over: Partial<UpdateOptions>) =>
					asked({
						currentVersion: "0.9.0-rc.1",
						releaseBase: server.base,
						targetPath: target,
						...over,
					});

				let checkOut = "";

				const checked = yield* runUpdate(
					newer({
						check: true,
						write: (text) => {
							checkOut += text;
						},
					})
				);

				expect(checked).toEqual({
					status: "ahead",
					current: "v0.9.0-rc.1",
					latest: "v0.8.0",
					target: undefined,
				});
				expect(checkOut).not.toContain("update available");
				expect(checkOut).toContain(
					"v0.9.0-rc.1 is newer than the latest release (v0.8.0)"
				);
				expect(checkOut).toContain(
					"run supervillain update --version v0.8.0 to go back to it"
				);

				let plainOut = "";

				const plain = yield* runUpdate(
					newer({
						write: (text) => {
							plainOut += text;
						},
					})
				);

				expect(plain.status).toBe("ahead");
				expect(plainOut).not.toContain("updated");
				expect(plainOut).toContain(
					"v0.9.0-rc.1 is newer than the latest release (v0.8.0)"
				);
				expect(yield* textOf(target)).toBe("the-rc-binary");
				expect(server.hits).toEqual(["/latest", "/latest"]);

				let forcedOut = "";

				const forced = yield* runUpdate(
					newer({
						force: true,
						write: (text) => {
							forcedOut += text;
						},
					})
				);

				expect(forced.status).toBe("updated");
				expect(forcedOut).toContain("downgrading: v0.9.0-rc.1 → v0.8.0");
				expect(forcedOut).toContain("downgraded supervillain");
				expect(forcedOut).not.toContain("updated supervillain");
				expect(yield* textOf(target)).toBe(stable);

				yield* Effect.promise(async () => {
					await writeFile(target, "the-rc-binary");
				});

				let pinnedOut = "";

				const pinned = yield* runUpdate(
					newer({
						version: "v0.8.0",
						write: (text) => {
							pinnedOut += text;
						},
					})
				);

				expect(pinned.status).toBe("updated");
				expect(pinnedOut).toContain("downgraded supervillain");
				expect(yield* textOf(target)).toBe(stable);
			})
	);

	effect("--version installs that tag without asking for the latest", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const target = yield* installedAt(dir, "old-binary");
			const pinned = "the-v0.7.5-binary";

			const server = yield* serve({
				...releaseRoutes("v0.9.0", "the-latest-binary", "unused"),
				...releaseRoutes("v0.7.5", pinned, sumsFor(pinned)),
			});

			const updated = yield* runUpdate(
				asked({
					version: "0.7.5",
					releaseBase: server.base,
					targetPath: target,
				})
			);

			expect(updated).toEqual({
				status: "updated",
				current: "v0.7.1",
				latest: "v0.7.5",
				target,
			});
			expect(yield* textOf(target)).toBe(pinned);
			expect(server.hits).toEqual([
				`/download/v0.7.5/${BINARY}`,
				"/download/v0.7.5/SHA256SUMS",
			]);
		})
	);

	effect("--force reinstalls the release this binary already is", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const target = yield* installedAt(dir, "a-damaged-binary");
			const fresh = "the-v0.8.0-binary";
			const server = yield* serveReleases("v0.8.0", fresh, sumsFor(fresh));

			const same = (over: Partial<UpdateOptions>) =>
				asked({
					currentVersion: "0.8.0",
					releaseBase: server.base,
					targetPath: target,
					...over,
				});

			expect((yield* runUpdate(same({}))).status).toBe("up-to-date");
			expect(yield* textOf(target)).toBe("a-damaged-binary");
			expect(server.hits).toEqual(["/latest"]);

			let out = "";

			const forced = yield* runUpdate(
				same({
					force: true,
					write: (text) => {
						out += text;
					},
				})
			);

			expect(forced.status).toBe("updated");
			expect(out).toContain("reinstalled supervillain v0.8.0");
			expect(yield* textOf(target)).toBe(fresh);
		})
	);

	effect(
		"refuses a mismatched checksum and leaves the existing binary untouched",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const target = yield* installedAt(dir, "original-binary");

				const server = yield* serveReleases(
					"v0.8.0",
					"tampered-binary",
					sumsFor("expected-binary")
				);

				const error = yield* Effect.flip(
					runUpdate(asked({ releaseBase: server.base, targetPath: target }))
				);

				expect(error.message).toContain("doesn't match SHA256SUMS");
				expect(yield* textOf(target)).toBe("original-binary");
				expect(yield* namesIn(dir)).toEqual(["supervillain"]);
			})
	);

	effect(
		"fails closed when SHA256SUMS is missing, malformed, or doesn't list the binary",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const target = yield* installedAt(dir, "original-binary");
				const next = "the-next-binary";

				const refusal = (routes: Routes) =>
					Effect.gen(function* () {
						const server = yield* serve(routes);

						const error = yield* Effect.flip(
							runUpdate(asked({ releaseBase: server.base, targetPath: target }))
						);

						expect(yield* textOf(target)).toBe("original-binary");
						expect(yield* namesIn(dir)).toEqual(["supervillain"]);

						return error.message;
					});

				expect(
					yield* refusal(
						releaseRoutes(
							"v0.8.0",
							next,
							`${sha256(next)}  supervillain-other-arch\n`
						)
					)
				).toBe(
					`SHA256SUMS lists no ${BINARY}, so the download can't be verified`
				);

				expect(
					yield* refusal(
						releaseRoutes(
							"v0.8.0",
							next,
							`${sha256(next).slice(0, 40)}  ${BINARY}\n`
						)
					)
				).toContain(`SHA256SUMS lists no ${BINARY}`);

				expect(
					yield* refusal({
						...releaseRoutes("v0.8.0", next, sumsFor(next)),
						"/download/v0.8.0/SHA256SUMS": () =>
							new Response("gone", { status: 404 }),
					})
				).toContain("/download/v0.8.0/SHA256SUMS: HTTP 404");
			})
	);

	effect("reports a non-2xx answer and changes nothing", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const target = yield* installedAt(dir, "original-binary");

			const down = yield* serve({
				"/latest": () => new Response("busy", { status: 503 }),
			});

			const checking = yield* Effect.flip(
				runUpdate(
					asked({ check: true, releaseBase: down.base, targetPath: target })
				)
			);

			expect(checking._tag).toBe("UpdateError");
			expect(checking.message).toBe(
				`can't check for updates: HTTP 503 from ${down.base}/latest`
			);

			const unpublished = yield* serve({
				"/latest": () => Response.json({ tag_name: "v0.8.0" }),
			});

			const downloading = yield* Effect.flip(
				runUpdate(asked({ releaseBase: unpublished.base, targetPath: target }))
			);

			expect(downloading.message).toBe(
				`can't download ${unpublished.base}/download/v0.8.0/${BINARY}: HTTP 404`
			);
			expect(yield* textOf(target)).toBe("original-binary");
			expect(yield* namesIn(dir)).toEqual(["supervillain"]);
		})
	);

	effect("refuses to replace itself when running from source", () =>
		Effect.gen(function* () {
			const next = "the-next-binary";
			const server = yield* serveReleases("v0.8.0", next, sumsFor(next));

			const error = yield* Effect.flip(
				runUpdate(asked({ compiled: false, releaseBase: server.base }))
			);

			expect(error.message).toContain("running from source");
			expect(error.message).toContain(`curl -fsSL ${INSTALL_URL} | sh`);
			expect(server.hits).toEqual(["/latest"]);
		})
	);

	effect(
		"replaces the file a symlinked target points at, keeping the link",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const real = path.join(dir, "real", "supervillain");
				const link = path.join(dir, "supervillain");
				const next = "the-next-binary";

				yield* Effect.promise(async () => {
					await mkdir(path.join(dir, "real"));
					await writeFile(real, "old-binary");
					await symlink(real, link);
				});

				const server = yield* serveReleases("v0.8.0", next, sumsFor(next));

				const updated = yield* runUpdate(
					asked({ releaseBase: server.base, targetPath: link })
				);

				expect(updated.target).toBe(real);
				expect(yield* textOf(real)).toBe(next);
				expect(
					(yield* Effect.promise(
						async () => await lstat(link)
					)).isSymbolicLink()
				).toBe(true);
				expect(yield* namesIn(path.join(dir, "real"))).toEqual([
					"supervillain",
				]);
				expect(yield* namesIn(dir)).toEqual(["real", "supervillain"]);
			})
	);

	effect("gives up on a release check that never answers", () =>
		Effect.gen(function* () {
			const server = yield* serve({ "/latest": never });

			const error = yield* Effect.flip(
				outlasting(
					"the release check",
					() => server.hits.includes("/latest"),
					runUpdate(asked({ check: true, releaseBase: server.base }))
				)
			);

			expect(error.message).toBe(
				`can't check for updates: no answer from ${server.base}/latest in 15 seconds`
			);
		})
	);

	effect(
		"gives up on a download that never starts or stalls, leaving nothing behind",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const target = yield* installedAt(dir, "original-binary");
				const next = "the-next-binary";
				const binaryPath = `/download/v0.8.0/${BINARY}`;
				const sumsPath = "/download/v0.8.0/SHA256SUMS";

				const stalled = (
					routes: Routes,
					what: string,
					reached: (hits: ReadonlyArray<string>) => boolean
				) =>
					Effect.gen(function* () {
						const server = yield* serve({
							...releaseRoutes("v0.8.0", next, sumsFor(next)),
							...routes,
						});

						const error = yield* Effect.flip(
							outlasting(
								what,
								() => reached(server.hits),
								runUpdate(
									asked({ releaseBase: server.base, targetPath: target })
								)
							)
						);

						expect(yield* textOf(target)).toBe("original-binary");
						expect(yield* namesIn(dir)).toEqual(["supervillain"]);

						return error.message.replace(server.base, "");
					});

				expect(
					yield* stalled({ [binaryPath]: never }, "the download", (hits) =>
						hits.includes(binaryPath)
					)
				).toBe(`can't download ${binaryPath}: no answer in 30 seconds`);

				expect(
					yield* stalled(
						{ [binaryPath]: trickle },
						"the first bytes",
						() => stagedBytesIn(dir) > 0
					)
				).toBe(
					`can't download ${binaryPath}: no data for 30 seconds; nothing changed`
				);

				expect(
					yield* stalled({ [sumsPath]: never }, "the checksums", (hits) =>
						hits.includes(sumsPath)
					)
				).toBe(`can't download ${sumsPath}: no answer in 15 seconds`);
			})
	);

	effect("an interrupted download leaves no staged file behind", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const target = yield* installedAt(dir, "original-binary");

			const server = yield* serve({
				...releaseRoutes("v0.8.0", "unused", "unused"),
				[`/download/v0.8.0/${BINARY}`]: trickle,
			});

			const running = yield* Effect.forkChild(
				runUpdate(asked({ releaseBase: server.base, targetPath: target }))
			);

			yield* waitFor("the first bytes", () => stagedBytesIn(dir) > 0);
			expect(stagedIn(dir)).toHaveLength(1);
			yield* Fiber.interrupt(running);
			expect(yield* namesIn(dir)).toEqual(["supervillain"]);
			expect(yield* textOf(target)).toBe("original-binary");
		})
	);
});
