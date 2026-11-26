import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SITE = path.resolve(import.meta.dir, "..");

const SCRIPT = path.resolve(SITE, "../../scripts/install.sh");

describe("the site's /install", () => {
	test("is scripts/install.sh, byte for byte, served as plain text", async () => {
		const built = Bun.spawn(["bun", "run", "build"], {
			cwd: SITE,
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stderr, exitCode] = await Promise.all([
			new Response(built.stderr).text(),
			built.exited,
		]);

		expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
			exitCode: 0,
			stderr: "",
		});

		const served = await readFile(path.join(SITE, "dist/client/install"));
		expect(served.equals(await readFile(SCRIPT))).toBe(true);

		const headers = await readFile(
			path.join(SITE, "dist/client/_headers"),
			"utf-8"
		);

		expect(headers).toContain(
			"/install\n  Content-Type: text/plain; charset=utf-8\n"
		);
	}, 60_000);
});
