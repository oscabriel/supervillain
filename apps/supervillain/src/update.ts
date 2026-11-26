import { createHash } from "node:crypto";

import {
	Clock,
	Config,
	Duration,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { COMPILED } from "./content/newCampaign.ts";
import { INSTALL_URL } from "./relay/lobby/create.ts";

export class UpdateError extends Schema.TaggedError<UpdateError>()(
	"UpdateError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

const DEFAULT_REPO = "oscabriel/supervillain";

const METADATA_SECONDS = 15;

const CONNECT_SECONDS = 30;

const STALL_SECONDS = 30;

const STAGED_MODE = 0o600;

const INSTALLED_MODE = 0o755;

const BAR_WIDTH = 22;

const BYTES_PER_MB = 1_048_576;

const BYTES_PER_KB = 1024;

const LatestRelease = Schema.Struct({
	tag_name: Schema.String,
});

export interface UpdateOptions {
	readonly check: boolean;
	readonly force: boolean;
	readonly version: string | undefined;
	readonly currentVersion: string;
	readonly repo?: string;
	readonly releaseBase?: string;
	readonly targetPath?: string;
	readonly compiled?: boolean;
	readonly isTTY?: boolean;
	readonly write?: (text: string) => void;
}

export interface UpdateResult {
	readonly status: "up-to-date" | "available" | "ahead" | "updated";
	readonly current: string;
	readonly latest: string;
	readonly target: string | undefined;
}

interface Palette {
	readonly brand: string;
	readonly ok: string;
	readonly bold: string;
	readonly dim: string;
	readonly reset: string;
}

const PLAIN_PALETTE: Palette = {
	brand: "",
	ok: "",
	bold: "",
	dim: "",
	reset: "",
};

const COLOR_PALETTE: Palette = {
	brand: "\u001B[1;38;2;224;108;117m",
	ok: "\u001B[1;38;2;152;195;121m",
	bold: "\u001B[1m",
	dim: "\u001B[2m",
	reset: "\u001B[0m",
};

const envValue = (name: string) =>
	Config.option(Config.String(name)).pipe(
		Effect.map((found) =>
			Option.getOrUndefined(Option.filter(found, (text) => text !== ""))
		),
		Effect.orElseSucceed((): string | undefined => undefined)
	);

export const binaryNameFor = (
	platform: string,
	arch: string
): string | undefined => {
	const os =
		platform === "linux" || platform === "darwin" ? platform : undefined;

	const cpu = arch === "x64" || arch === "arm64" ? arch : undefined;

	return os === undefined || cpu === undefined
		? undefined
		: `supervillain-${os}-${cpu}`;
};

const normalizeVersion = (raw: string): string => {
	const clean = raw.trim().replace(/^v/u, "");

	return clean === "" ? "0.0.0" : clean;
};

const SEMVER =
	/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const NUMERIC = /^\d+$/u;

interface Version {
	readonly core: ReadonlyArray<number>;
	readonly prerelease: ReadonlyArray<string>;
}

const parseVersion = (clean: string): Version | undefined => {
	if (!SEMVER.test(clean)) {
		return undefined;
	}

	const [unbuilt = ""] = clean.split("+");
	const dash = unbuilt.indexOf("-");
	const core = dash === -1 ? unbuilt : unbuilt.slice(0, dash);

	return {
		core: core.split(".").map(Number),
		prerelease: dash === -1 ? [] : unbuilt.slice(dash + 1).split("."),
	};
};

const compareNumbers = (mine: number, theirs: number): number =>
	Math.sign(mine - theirs);

const compareIdentifiers = (mine: string, theirs: string): number => {
	const numeric = NUMERIC.test(mine);

	if (numeric !== NUMERIC.test(theirs)) {
		return numeric ? -1 : 1;
	}

	if (numeric) {
		return compareNumbers(Number(mine), Number(theirs));
	}

	if (mine === theirs) {
		return 0;
	}

	return mine < theirs ? -1 : 1;
};

const compareEach = <A>(
	mine: ReadonlyArray<A>,
	theirs: ReadonlyArray<A>,
	compare: (left: A, right: A) => number
): number => {
	for (const [index, left] of mine.entries()) {
		const right = theirs[index];

		if (right === undefined) {
			return 1;
		}

		const order = compare(left, right);

		if (order !== 0) {
			return order;
		}
	}

	return compareNumbers(mine.length, theirs.length);
};

const compareVersions = (mine: Version, theirs: Version): number => {
	const core = compareEach(mine.core, theirs.core, compareNumbers);

	if (core !== 0) {
		return core;
	}

	if (mine.prerelease.length === 0 || theirs.prerelease.length === 0) {
		return compareNumbers(theirs.prerelease.length, mine.prerelease.length);
	}

	return compareEach(mine.prerelease, theirs.prerelease, compareIdentifiers);
};

type Standing = "same" | "behind" | "ahead" | "unknown";

const standingOf = (current: string, release: string): Standing => {
	const mine = parseVersion(current);
	const theirs = parseVersion(release);

	if (mine === undefined || theirs === undefined) {
		return current === release ? "same" : "unknown";
	}

	const order = compareVersions(mine, theirs);

	if (order === 0) {
		return "same";
	}

	return order < 0 ? "behind" : "ahead";
};

type Verdict = "up-to-date" | "ahead" | "available" | "install";

const verdictOf = (standing: Standing, options: UpdateOptions): Verdict => {
	if (standing === "same" && (options.check || !options.force)) {
		return "up-to-date";
	}

	const asked = options.force || options.version !== undefined;

	if (standing === "ahead" && (options.check || !asked)) {
		return "ahead";
	}

	return options.check ? "available" : "install";
};

interface Labels {
	readonly current: string;
	readonly latest: string;
	readonly pinned: boolean;
}

const noticeOf = (
	verdict: Exclude<Verdict, "install">,
	p: Palette,
	at: Labels
): string => {
	const older = at.pinned ? at.latest : `the latest release (${at.latest})`;

	const install = at.pinned
		? `supervillain update --version ${at.latest}`
		: "supervillain update";

	const notices = {
		"up-to-date": `  ${p.ok}✓${p.reset} already up to date (${at.latest})\n`,
		ahead:
			`  ${p.ok}✓${p.reset} ${at.current} is newer than ${older}\n` +
			`  ${p.dim}run supervillain update --version ${at.latest} to go back to it${p.reset}\n`,
		available:
			`  ${p.bold}↑${p.reset} update available: ${at.current} → ${p.bold}${at.latest}${p.reset}\n` +
			`  ${p.dim}run ${install} to install it${p.reset}\n`,
	} satisfies Readonly<Record<Exclude<Verdict, "install">, string>>;

	return notices[verdict];
};

const doneOf = (standing: Standing, p: Palette, at: Labels): string => {
	const moved = `${p.dim}${at.current}${p.reset} → ${p.bold}${at.latest}${p.reset}`;

	const done = {
		same: `reinstalled supervillain ${p.bold}${at.latest}${p.reset}`,
		behind: `updated supervillain ${moved}`,
		ahead: `downgraded supervillain ${moved}`,
		unknown: `updated supervillain ${moved}`,
	} satisfies Readonly<Record<Standing, string>>;

	return done[standing];
};

export const checksumFor = (
	sumsText: string,
	filename: string
): string | undefined => {
	for (const line of sumsText.split(/\r?\n/u)) {
		const trimmed = line.trim();

		if (trimmed === "") {
			continue;
		}

		const [hash, rawName] = trimmed.split(/\s+/u);

		if (hash === undefined || rawName === undefined) {
			continue;
		}

		const cleanName = rawName.startsWith("*") ? rawName.slice(1) : rawName;

		if (cleanName === filename && /^[0-9a-f]{64}$/iu.test(hash)) {
			return hash.toLowerCase();
		}
	}

	return undefined;
};

const formatBytes = (bytes: number): string => {
	if (bytes >= BYTES_PER_MB) {
		return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
	}

	return `${Math.max(1, Math.round(bytes / BYTES_PER_KB))} KB`;
};

export const progressBar = (
	received: number,
	total: number | undefined,
	width: number = BAR_WIDTH
): string => {
	if (total !== undefined && total > 0) {
		const ratio = Math.max(0, Math.min(1, received / total));
		const filled = Math.round(ratio * width);
		const empty = Math.max(0, width - filled);
		const pct = String(Math.round(ratio * 100)).padStart(3);

		return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${pct}%  ${formatBytes(received)} / ${formatBytes(total)}`;
	}

	const pulse = Math.floor(received / (256 * BYTES_PER_KB)) % width;

	const bar = Array.from({ length: width }, (_unused, i) =>
		i === pulse || i === (pulse + 1) % width ? "█" : "░"
	).join("");

	return `[${bar}]  ${formatBytes(received)}`;
};

const failed = (what: string) => (cause: { readonly message: string }) =>
	new UpdateError({ message: `${what}: ${cause.message}`, cause });

const within =
	(seconds: number, message: string) =>
	<A, E, R>(self: Effect.Effect<A, E, R>) =>
		Effect.timeoutOrElse(self, {
			duration: Duration.seconds(seconds),
			orElse: () => Effect.fail(new UpdateError({ message })),
		});

const answerTo = Effect.fn("update.answerTo")(function* (
	url: string,
	accept: string,
	what: string,
	from: string
) {
	const client = yield* HttpClient.HttpClient;

	const response = yield* client
		.execute(HttpClientRequest.get(url, { headers: { accept } }))
		.pipe(Effect.mapError(failed(what)));

	if (response.status < 200 || response.status >= 300) {
		return yield* new UpdateError({
			message: `${what}: HTTP ${response.status}${from}`,
		});
	}

	return response;
});

const resolveLatestTag = Effect.fn("update.resolveLatestTag")(function* (
	repo: string,
	releaseBase: string | undefined
) {
	const url =
		releaseBase === undefined
			? `https://github.com/${repo}/releases/latest`
			: `${releaseBase}/latest`;

	const what = "can't check for updates";

	return yield* Effect.gen(function* () {
		const response = yield* answerTo(
			url,
			"application/json",
			what,
			` from ${url}`
		);

		const release = yield* HttpClientResponse.schemaBodyJson(LatestRelease)(
			response
		).pipe(Effect.mapError(failed("can't read latest release version")));

		return release.tag_name;
	}).pipe(
		within(
			METADATA_SECONDS,
			`${what}: no answer from ${url} in ${METADATA_SECONDS} seconds`
		)
	);
});

const downloadText = Effect.fn("update.downloadText")(function* (url: string) {
	const what = `can't download ${url}`;

	return yield* Effect.gen(function* () {
		const response = yield* answerTo(url, "*/*", what, "");

		return yield* response.text.pipe(
			Effect.mapError(failed(`can't read ${url}`))
		);
	}).pipe(
		within(
			METADATA_SECONDS,
			`${what}: no answer in ${METADATA_SECONDS} seconds`
		)
	);
});

const downloadBinary = Effect.fn("update.downloadBinary")(function* (
	url: string,
	staged: string,
	tty: boolean,
	write: (text: string) => void
) {
	const fs = yield* FileSystem.FileSystem;
	const what = `can't download ${url}`;
	const unwritable = failed(`can't write ${staged}`);

	const response = yield* answerTo(url, "*/*", what, "").pipe(
		within(CONNECT_SECONDS, `${what}: no answer in ${CONNECT_SECONDS} seconds`)
	);

	const lengthHeader = response.headers["content-length"];

	const parsedLength =
		lengthHeader === undefined ? Number.NaN : Math.trunc(Number(lengthHeader));

	const total =
		Number.isFinite(parsedLength) && parsedLength > 0
			? parsedLength
			: undefined;

	const file = yield* fs
		.open(staged, { flag: "w", mode: STAGED_MODE })
		.pipe(Effect.mapError(unwritable));

	const hash = createHash("sha256");
	let received = 0;
	let lastDraw = 0;
	let drawn = false;

	yield* response.stream.pipe(
		Stream.mapError(failed(what)),
		Stream.timeoutOrElse({
			duration: Duration.seconds(STALL_SECONDS),
			orElse: () =>
				Stream.fail(
					new UpdateError({
						message: `${what}: no data for ${STALL_SECONDS} seconds; nothing changed`,
					})
				),
		}),
		Stream.runForEach((chunk) =>
			Effect.gen(function* () {
				yield* file.writeAll(chunk).pipe(Effect.mapError(unwritable));
				hash.update(chunk);
				received += chunk.byteLength;

				const now = yield* Clock.currentTimeMillis;

				if (tty && now - lastDraw >= 60) {
					write(`\r  ${progressBar(received, total)}`);
					lastDraw = now;
					drawn = true;
				}
			})
		),
		Effect.onError(() =>
			Effect.sync(() => {
				if (drawn) {
					write("\n");
				}
			})
		)
	);

	yield* file.sync.pipe(Effect.mapError(unwritable));

	if (tty) {
		write(`\r  ${progressBar(received, total ?? received)}\n`);
	}

	return hash.digest("hex");
}, Effect.scoped);

interface Swap {
	readonly target: string;
	readonly from: string;
	readonly binary: string;
	readonly release: string;
	readonly tty: boolean;
	readonly p: Palette;
	readonly write: (text: string) => void;
}

const install = Effect.fn("update.install")(function* (swap: Swap) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { binary, p, write } = swap;

	const installed = yield* fs
		.realPath(swap.target)
		.pipe(Effect.orElseSucceed(() => swap.target));

	const staged = path.join(
		path.dirname(installed),
		`.supervillain.update.${process.pid}`
	);

	yield* Effect.addFinalizer(() =>
		Effect.ignore(fs.remove(staged, { force: true }))
	);

	write(
		`  ${p.dim}[1/3]${p.reset} Downloading ${binary} (${swap.release})...\n`
	);

	const digest = yield* downloadBinary(
		`${swap.from}/${binary}`,
		staged,
		swap.tty,
		write
	);

	write(`  ${p.dim}[2/3]${p.reset} Verifying SHA256SUMS...\n`);
	const sums = yield* downloadText(`${swap.from}/SHA256SUMS`);
	const want = checksumFor(sums, binary);

	if (want === undefined) {
		return yield* new UpdateError({
			message: `SHA256SUMS lists no ${binary}, so the download can't be verified`,
		});
	}

	if (digest !== want) {
		return yield* new UpdateError({
			message: `the download doesn't match SHA256SUMS (want ${want}, got ${digest}); nothing changed`,
		});
	}

	write(
		`  ${p.ok}✓${p.reset} checksum verified (${digest.slice(0, 12)}…)\n` +
			`  ${p.dim}[3/3]${p.reset} Replacing binary...\n`
	);

	yield* Effect.andThen(
		fs.chmod(staged, INSTALLED_MODE),
		fs.rename(staged, installed)
	).pipe(
		Effect.uninterruptible,
		Effect.mapError(failed(`can't replace ${swap.target}`))
	);

	return installed;
}, Effect.scoped);

export const runUpdate = Effect.fn("update.runUpdate")(function* (
	options: UpdateOptions
) {
	const envRepo = yield* envValue("SUPERVILLAIN_REPO");
	const noColor = yield* envValue("NO_COLOR");
	const repo = options.repo ?? envRepo ?? DEFAULT_REPO;
	const tty = options.isTTY ?? process.stdout.isTTY;

	const write =
		options.write ??
		((text: string) => {
			process.stdout.write(text);
		});

	const p = tty && noColor === undefined ? COLOR_PALETTE : PLAIN_PALETTE;
	const binary = binaryNameFor(process.platform, process.arch);

	if (binary === undefined) {
		return yield* new UpdateError({
			message: `no prebuilt binary for ${process.platform}-${process.arch}`,
		});
	}

	const currentClean = normalizeVersion(options.currentVersion);
	const current = `v${currentClean}`;

	write(
		`${p.brand}◆ supervillain${p.reset} ${p.dim}· update${p.reset}\n` +
			`  ${p.dim}current${p.reset}   ${current}\n` +
			`  ${p.dim}platform${p.reset}  ${process.platform}-${process.arch}\n\n`
	);

	const latestClean = normalizeVersion(
		options.version ?? (yield* resolveLatestTag(repo, options.releaseBase))
	);

	const latest = `v${latestClean}`;
	const at: Labels = { current, latest, pinned: options.version !== undefined };
	const standing = standingOf(currentClean, latestClean);
	const verdict = verdictOf(standing, options);

	if (verdict !== "install") {
		write(noticeOf(verdict, p, at));

		return {
			status: verdict,
			current,
			latest,
			target: undefined,
		} satisfies UpdateResult;
	}

	if (!(options.compiled ?? COMPILED) && options.targetPath === undefined) {
		return yield* new UpdateError({
			message: `running from source; update with git pull, or install a release binary with: curl -fsSL ${INSTALL_URL} | sh`,
		});
	}

	if (standing === "ahead") {
		write(
			`  ${p.bold}↓${p.reset} downgrading: ${current} → ${p.bold}${latest}${p.reset}\n`
		);
	}

	const target = yield* install({
		target: options.targetPath ?? process.execPath,
		from:
			options.releaseBase === undefined
				? `https://github.com/${repo}/releases/download/${latest}`
				: `${options.releaseBase}/download/${latest}`,
		binary,
		release: latest,
		tty,
		p,
		write,
	});

	write(
		`  ${p.ok}✓${p.reset} ${doneOf(standing, p, at)}\n` +
			`  ${p.dim}target${p.reset}    ${target}\n`
	);

	return {
		status: "updated",
		current,
		latest,
		target,
	} satisfies UpdateResult;
});
