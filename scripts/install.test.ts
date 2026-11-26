import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
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

const FAILING_CP = [
	"#!/bin/sh",
	'for last in "$@"; do :; done',
	'case "$last" in',
	'  "$SUPERVILLAIN_BIN"/*)',
	'    printf "%s\\n" "$last" >> "$CURL_LOG.cp"',
	'    printf "half a binary" > "$last"',
	"    exit 1",
	"    ;;",
	"esac",
	'exec "$REAL_CP" "$@"',
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

const listed = async (at: Rig, binary: string, sums: string) => {
	await writeFile(path.join(at.fixtures, BINARY), binary);
	await writeFile(path.join(at.fixtures, "SHA256SUMS"), sums);
};

const breakCp = async (at: Rig) => {
	const cp = path.join(at.tools, "cp");
	await rm(cp);
	await writeFile(cp, FAILING_CP);
	await chmod(cp, 0o755);
};

const namesIn = async (dir: string) => {
	const names = await readdir(dir);

	return names.toSorted();
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

	return { stdout, stderr, exitCode, pid: proc.pid };
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

	test("only trusts a 64-character hex checksum, in either case", async () => {
		const good = sha256("the binary");

		const refused = async (entry: string) => {
			await withTempDir(async (dir) => {
				const at = await rig(dir, true);
				await listed(at, "the binary", `${entry}  ${BINARY}\n`);
				const ran = await install(at);
				expect(ran.exitCode).toBe(1);
				expect(ran.stderr).toContain(
					`SHA256SUMS lists no ${BINARY}, so it can't be checked`
				);
				expect(await exists(path.join(at.bin, "supervillain"))).toBe(false);
			});
		};

		await Promise.all(
			[
				good.slice(0, 63),
				`${good}0`,
				"z".repeat(64),
				`${good.slice(0, 63)}/`,
			].map(refused)
		);

		await withTempDir(async (dir) => {
			const at = await rig(dir, true);
			await listed(at, "the binary", `${good.toUpperCase()} *${BINARY}\n`);
			const ran = await install(at);
			expect(ran.stderr).toBe("");
			expect(ran.exitCode).toBe(0);
			expect(await readFile(path.join(at.bin, "supervillain"), "utf-8")).toBe(
				"the binary"
			);
		});
	});

	test("stages under its own name, leaving another install's staged file alone", async () => {
		await withTempDir(async (dir) => {
			const at = await rig(dir, true);
			await release(at, "the binary", "the binary");
			await mkdir(at.bin);
			const theirs = path.join(at.bin, ".supervillain.new");
			await writeFile(theirs, "another install, mid-copy");
			const ran = await install(at);
			expect(ran.stderr).toBe("");
			expect(ran.exitCode).toBe(0);
			expect(await readFile(theirs, "utf-8")).toBe("another install, mid-copy");
			expect(await readFile(path.join(at.bin, "supervillain"), "utf-8")).toBe(
				"the binary"
			);
			expect(await namesIn(at.bin)).toEqual([
				".supervillain.new",
				"supervillain",
			]);
		});
	});

	test("says so when the copy into place fails, and leaves no partial file", async () => {
		await withTempDir(async (dir) => {
			const at = await rig(dir, true);
			await release(at, "the binary", "the binary");
			await mkdir(at.bin);
			const installed = path.join(at.bin, "supervillain");
			await writeFile(installed, "the old binary");
			await breakCp(at);
			const ran = await install(at, { REAL_CP: Bun.which("cp") ?? "cp" });
			expect(ran.exitCode).toBe(1);
			expect(ran.stderr).toBe(
				`supervillain install: can't write to ${at.bin}; nothing installed\n`
			);
			expect(await readFile(`${at.log}.cp`, "utf-8")).toBe(
				`${at.bin}/.supervillain.new.${ran.pid}\n`
			);
			expect(await namesIn(at.bin)).toEqual(["supervillain"]);
			expect(await readFile(installed, "utf-8")).toBe("the old binary");
		});
	});
});
