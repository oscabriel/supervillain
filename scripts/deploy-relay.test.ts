import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "deploy-relay.sh");

const binaryName = () => {
	if (process.arch === "arm64") {
		return "supervillain-linux-arm64";
	}

	return "supervillain-linux-x64";
};

const sha256 = (data: Buffer | string) =>
	createHash("sha256").update(data).digest("hex");

const fakeBinary = (version: string) =>
	`#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "supervillain ${version}"; exit 0; fi\nexit 1\n`;

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
	const dir = await mkdtemp(path.join(tmpdir(), "sv-deploy-test-"));

	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

const packArchive = async (
	dir: string,
	files: ReadonlyArray<string>
): Promise<Uint8Array> => {
	const proc = Bun.spawn(["tar", "-C", dir, "-cf", "-", ...files], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
	const code = await proc.exited;

	if (code !== 0) {
		throw new Error(await new Response(proc.stderr).text());
	}

	return out;
};

const runDeploy = async (
	archive: Uint8Array,
	env: Readonly<Record<string, string>>
) => {
	const proc = Bun.spawn(["bash", SCRIPT], {
		stdin: archive,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, DEPLOY_TEST_DELAY: "0", ...env },
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { stdout, stderr, exitCode };
};

describe("scripts/deploy-relay.sh", () => {
	test("installs a verified release archive atomically and restarts the service", async () => {
		await withTempDir(async (dir) => {
			const stage = path.join(dir, "in");
			const dest = path.join(dir, "supervillain");
			const log = path.join(dir, "restarts.log");
			const restart = path.join(dir, "restart.sh");
			const check = path.join(dir, "check.sh");
			const bin = binaryName();
			const content = fakeBinary("v0.6.4");

			await Bun.write(path.join(stage, "RELEASE"), "v0.6.4\n");
			await Bun.write(path.join(stage, bin), content);
			await Bun.write(
				path.join(stage, "SHA256SUMS"),
				`${sha256(content)}  ${bin}\n`
			);
			await writeFile(
				restart,
				`echo "restarted:$("$1" --version)" >> "${log}"\n`
			);
			await writeFile(check, "exit 0\n");

			const archive = await packArchive(stage, ["RELEASE", "SHA256SUMS", bin]);

			const result = await runDeploy(archive, {
				DEPLOY_TEST_DEST: dest,
				DEPLOY_TEST_RESTART: restart,
				DEPLOY_TEST_CHECK: check,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(
				"deploy-relay: deployed supervillain v0.6.4"
			);
			expect(await readFile(dest, "utf-8")).toBe(content);
			const restarted = await readFile(log, "utf-8");
			expect(restarted.trim()).toBe("restarted:supervillain v0.6.4");
		});
	});

	test("rejects a bad checksum without touching the installed binary", async () => {
		await withTempDir(async (dir) => {
			const stage = path.join(dir, "in");
			const dest = path.join(dir, "supervillain");
			const bin = binaryName();
			const previous = fakeBinary("v0.6.3");

			await writeFile(dest, previous);
			await chmod(dest, 0o755);
			await Bun.write(path.join(stage, "RELEASE"), "v0.6.4\n");
			await Bun.write(path.join(stage, bin), fakeBinary("v0.6.4"));
			await Bun.write(
				path.join(stage, "SHA256SUMS"),
				`${"0".repeat(64)}  ${bin}\n`
			);

			const archive = await packArchive(stage, ["RELEASE", "SHA256SUMS", bin]);
			const result = await runDeploy(archive, { DEPLOY_TEST_DEST: dest });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("checksum verification failed");
			expect(await readFile(dest, "utf-8")).toBe(previous);
		});
	});

	test("rejects a binary whose --version does not match RELEASE", async () => {
		await withTempDir(async (dir) => {
			const stage = path.join(dir, "in");
			const dest = path.join(dir, "supervillain");
			const bin = binaryName();
			const wrong = fakeBinary("v0.6.2");

			await Bun.write(path.join(stage, "RELEASE"), "v0.6.4\n");
			await Bun.write(path.join(stage, bin), wrong);
			await Bun.write(
				path.join(stage, "SHA256SUMS"),
				`${sha256(wrong)}  ${bin}\n`
			);

			const archive = await packArchive(stage, ["RELEASE", "SHA256SUMS", bin]);
			const result = await runDeploy(archive, { DEPLOY_TEST_DEST: dest });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(
				"expected 'supervillain v0.6.4', got 'supervillain v0.6.2'"
			);
		});
	});

	test("rolls back to the previous binary when the service fails to stay active", async () => {
		await withTempDir(async (dir) => {
			const stage = path.join(dir, "in");
			const dest = path.join(dir, "supervillain");
			const log = path.join(dir, "restarts.log");
			const restart = path.join(dir, "restart.sh");
			const check = path.join(dir, "check.sh");
			const bin = binaryName();
			const previous = fakeBinary("v0.6.3");
			const next = fakeBinary("v0.6.4");

			await writeFile(dest, previous);
			await chmod(dest, 0o755);
			await Bun.write(path.join(stage, "RELEASE"), "v0.6.4\n");
			await Bun.write(path.join(stage, bin), next);
			await Bun.write(
				path.join(stage, "SHA256SUMS"),
				`${sha256(next)}  ${bin}\n`
			);
			await writeFile(restart, `echo "$("$1" --version)" >> "${log}"\n`);
			await writeFile(check, "exit 1\n");

			const archive = await packArchive(stage, ["RELEASE", "SHA256SUMS", bin]);

			const result = await runDeploy(archive, {
				DEPLOY_TEST_DEST: dest,
				DEPLOY_TEST_RESTART: restart,
				DEPLOY_TEST_CHECK: check,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("rolling back to previous binary");
			expect(await readFile(dest, "utf-8")).toBe(previous);
			const restarted = await readFile(log, "utf-8");
			expect(restarted.trim().split("\n")).toEqual([
				"supervillain v0.6.4",
				"supervillain v0.6.3",
			]);
		});
	}, 15_000);

	test("rejects an invalid release tag", async () => {
		await withTempDir(async (dir) => {
			const stage = path.join(dir, "in");
			const dest = path.join(dir, "supervillain");
			const bin = binaryName();
			const content = fakeBinary("v0.6.4");

			await Bun.write(path.join(stage, "RELEASE"), "../evil\n");
			await Bun.write(path.join(stage, bin), content);
			await Bun.write(
				path.join(stage, "SHA256SUMS"),
				`${sha256(content)}  ${bin}\n`
			);

			const archive = await packArchive(stage, ["RELEASE", "SHA256SUMS", bin]);
			const result = await runDeploy(archive, { DEPLOY_TEST_DEST: dest });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("invalid release tag");
		});
	});
});
