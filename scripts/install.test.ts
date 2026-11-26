import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "install.sh");

const BINARY = `supervillain-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

const TOOLS = [
	"uname",
	"cut",
	"awk",
	"mktemp",
	"rm",
	"mkdir",
	"chmod",
	"cp",
	"mv",
	"basename",
];

const FAKE_CURL = [
	"#!/bin/sh",
	'out=""',
	'url=""',
	'printf "%s\\n" "$*" >> "$CURL_LOG.args"',
	'while [ "$#" -gt 0 ]; do',
	'  case "$1" in',
	'    -o) out="$2"; shift 2 ;;',
	"    --proto) shift 2 ;;",
	"    -*) shift ;;",
	'    *) url="$1"; shift ;;',
	"  esac",
	"done",
	'printf "%s\\n" "$url" >> "$CURL_LOG"',
	'name="$(basename "$url")"',
	'[ -f "$FIXTURES/$name" ] || exit 22',
	'cp "$FIXTURES/$name" "$out"',
	"",
].join("\n");

const sha256 = (data: string) =>
	createHash("sha256").update(data).digest("hex");

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
	const dir = await mkdtemp(path.join(tmpdir(), "sv-install-test-"));

	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

interface Rig {
	readonly dir: string;
	readonly bin: string;
	readonly tools: string;
	readonly log: string;
	readonly fixtures: string;
}

const rig = async (dir: string, verifiers: boolean): Promise<Rig> => {
	const tools = path.join(dir, "tools");
	const fixtures = path.join(dir, "fixtures");
	await mkdir(tools);
	await mkdir(fixtures);

	const linked = verifiers ? [...TOOLS, "sha256sum", "shasum"] : TOOLS;

	await Promise.all(
		linked.flatMap((tool) => {
			const found = Bun.which(tool);

			return found === null ? [] : [symlink(found, path.join(tools, tool))];
		})
	);

	const curl = path.join(tools, "curl");
	await writeFile(curl, FAKE_CURL);
	await chmod(curl, 0o755);

	return {
		dir,
		bin: path.join(dir, "bin"),
		tools,
		log: path.join(dir, "curl.log"),
		fixtures,
	};
};

const release = async (at: Rig, binary: string, listed: string) => {
	await writeFile(path.join(at.fixtures, BINARY), binary);
	await writeFile(
		path.join(at.fixtures, "SHA256SUMS"),
		`${sha256(listed)}  ${BINARY}\n${sha256("other")}  supervillain-other\n`
	);
};

const install = async (at: Rig, env: Readonly<Record<string, string>> = {}) => {
	const proc = Bun.spawn(["/bin/sh", SCRIPT], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			HOME: at.dir,
			PATH: at.tools,
			SUPERVILLAIN_BIN: at.bin,
			CURL_LOG: at.log,
			FIXTURES: at.fixtures,
			...env,
		},
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { stdout, stderr, exitCode };
};

const exists = async (file: string) =>
	await stat(file)
		.then(() => true)
		.catch(() => false);

describe("scripts/install.sh", () => {
	test("is POSIX sh that parses", async () => {
		const proc = Bun.spawn(["/bin/sh", "-n", SCRIPT], { stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const text = await readFile(SCRIPT, "utf-8");
		expect(text.startsWith("#!")).toBe(false);
		expect(text).not.toContain("pipefail");
		expect(text.trimEnd().endsWith('main "$@"')).toBe(true);
	});

	test("downloads the latest release for this machine, checks it, and installs it", async () => {
		await withTempDir(async (dir) => {
			const at = await rig(dir, true);
			await release(at, "the binary", "the binary");
			const ran = await install(at, { SUPERVILLAIN_REPO: "someone/fork" });
			expect(ran.stderr).toBe("");
			expect(ran.exitCode).toBe(0);
			const installed = path.join(at.bin, "supervillain");
			expect(await readFile(installed, "utf-8")).toBe("the binary");
			const info = await stat(installed);
			expect(info.mode % 0o1000).toBe(0o755);
			expect(await readFile(at.log, "utf-8")).toBe(
				[
					`https://github.com/someone/fork/releases/latest/download/${BINARY}`,
					"https://github.com/someone/fork/releases/latest/download/SHA256SUMS",
					"",
				].join("\n")
			);

			const logged = await readFile(`${at.log}.args`, "utf-8");
			const asked = logged.trimEnd().split("\n");

			expect(asked).toHaveLength(2);

			for (const line of asked) {
				expect(line.startsWith("--proto =https --tlsv1.2 ")).toBe(true);
			}

			expect(ran.stdout).toContain(`installed ${installed}`);
			expect(ran.stdout).toContain(`${at.bin} isn't on your PATH`);
			expect(ran.stdout).toContain("next, run: supervillain");

			const onPath = await install(at, { PATH: `${at.tools}:${at.bin}` });
			expect(onPath.exitCode).toBe(0);
			expect(onPath.stdout).not.toContain("isn't on your PATH");
		});
	});

	test("refuses a download that doesn't match SHA256SUMS, installing nothing", async () => {
		await withTempDir(async (dir) => {
			const at = await rig(dir, true);
			await release(at, "a tampered binary", "the binary");
			const ran = await install(at);
			expect(ran.exitCode).toBe(1);
			expect(ran.stderr).toContain("doesn't match SHA256SUMS");
			expect(await exists(path.join(at.bin, "supervillain"))).toBe(false);
		});
	});

	test("fails closed with no checksum tool, and on a missing download", async () => {
		await withTempDir(async (dir) => {
			const at = await rig(dir, false);
			await release(at, "the binary", "the binary");
			const ran = await install(at);
			expect(ran.exitCode).toBe(1);
			expect(ran.stderr).toContain("needs sha256sum or shasum");
			expect(await exists(path.join(at.bin, "supervillain"))).toBe(false);
		});

		await withTempDir(async (dir) => {
			const at = await rig(dir, true);
			const ran = await install(at);
			expect(ran.exitCode).toBe(1);
			expect(ran.stderr).toContain(
				`can't download https://github.com/oscabriel/supervillain/releases/latest/download/${BINARY}`
			);
		});
	});
});
