/* oxlint-disable vitest/prefer-importing-vitest-globals -- this pure-local smoke runs with bun test. */
import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const isExecutable = async (file: string): Promise<boolean> => {
	try {
		await access(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

const run = async (
	installer: string,
	baseUrl: string,
	installDirectory: string
): Promise<{ readonly exitCode: number; readonly stderr: string }> => {
	const process = Bun.spawn(["sh", installer], {
		env: {
			...globalThis.process.env,
			SUPERVILLAIN_BASE_URL: baseUrl,
			SUPERVILLAIN_INSTALL_DIR: installDirectory,
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		process.exited,
		new Response(process.stderr).text(),
		new Response(process.stdout).text(),
	]);
	return { exitCode, stderr };
};

test("installs a verified local fixture and rejects a corrupt checksum", async () => {
	const scratch = await mkdtemp(
		path.join(tmpdir(), "supervillain-install-test-")
	);
	const installer = path.resolve(import.meta.dir, "../../install.sh");
	try {
		const fixture = path.join(scratch, "fixture");
		await mkdir(fixture);
		const binary = path.join(fixture, "supervillain");
		await writeFile(binary, "#!/bin/sh\necho supervillain fixture\n");
		await chmod(binary, 0o755);
		const triple =
			globalThis.process.platform === "darwin"
				? `macos-${globalThis.process.arch === "arm64" ? "arm64" : "x64"}`
				: `linux-${globalThis.process.arch === "arm64" ? "arm64" : "x64"}`;
		const archiveName = `supervillain-${triple}.tar.gz`;
		const archive = path.join(fixture, archiveName);
		const tar = Bun.spawn([
			"tar",
			"-czf",
			archive,
			"-C",
			fixture,
			"supervillain",
		]);
		expect(await tar.exited).toBe(0);
		const bytes = await Bun.file(archive).arrayBuffer();
		const checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		let checksumBody = `${checksum}  ${archiveName}\n`;
		const server = Bun.serve({
			fetch(request) {
				const { url } = request;
				const { pathname } = new URL(url);
				if (pathname.endsWith(`/${archiveName}`)) {
					return new Response(Bun.file(archive));
				}
				if (pathname.endsWith("/SHA256SUMS")) {
					return new Response(checksumBody);
				}
				return new Response("not found", { status: 404 });
			},
			hostname: "127.0.0.1",
			port: 0,
		});
		try {
			const baseUrl = `http://${server.hostname}:${server.port}/releases`;
			const installDirectory = path.join(scratch, "installed");
			const installed = await run(installer, baseUrl, installDirectory);
			expect(installed.exitCode).toBe(0);
			expect(
				await isExecutable(path.join(installDirectory, "supervillain"))
			).toBe(true);

			checksumBody = `${"0".repeat(64)}  ${archiveName}\n`;
			const corrupt = await run(
				installer,
				baseUrl,
				path.join(scratch, "corrupt-install")
			);
			expect(corrupt.exitCode).not.toBe(0);
			expect(corrupt.stderr).toContain("checksum");
		} finally {
			await server.stop(true);
		}
	} finally {
		await rm(scratch, { force: true, recursive: true });
	}
});
