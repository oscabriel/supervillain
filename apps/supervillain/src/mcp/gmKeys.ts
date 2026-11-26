import { isFingerprint } from "@supervillain/ssh";
import { Effect, FileSystem, Option, Path, Ref } from "effect";

import { readBounded, utf8Of } from "../content/bounded.ts";

export const GM_KEYS_FILE = "gm_keys";

export const GM_KEYS_BYTES = 16 * 1024;

const GROUP_WRITE = 0o020;

const OTHER_WRITE = 0o002;

const hasBit = (mode: number, bit: number): boolean =>
	Math.floor(mode / bit) % 2 === 1;

const KEY_PREFIX = /^key:/u;

export interface GmKeys {
	readonly fingerprints: ReadonlySet<string>;
	readonly problem?: string;
}

const none = (problem?: string): GmKeys =>
	problem === undefined
		? { fingerprints: new Set() }
		: { fingerprints: new Set(), problem };

const parseGmKeys = (text: string): ReadonlySet<string> =>
	new Set(
		text
			.split("\n")
			.map((line) => line.trim().replace(KEY_PREFIX, ""))
			.filter(isFingerprint)
	);

export const readGmKeys = Effect.fn("readGmKeys")(function* (
	campaignDir: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(campaignDir, GM_KEYS_FILE);
	const info = yield* fs.lstat(file).pipe(Effect.option);

	if (Option.isNone(info)) {
		return none();
	}

	if (info.value.type !== "File") {
		return none(`${file} isn't a plain file; no remote GM keys`);
	}

	const uid = process.getuid?.();
	const owner = Option.getOrUndefined(info.value.uid);

	if (uid !== undefined && owner !== undefined && owner !== uid) {
		return none(`${file} belongs to another user; no remote GM keys`);
	}

	if (
		hasBit(info.value.mode, GROUP_WRITE) ||
		hasBit(info.value.mode, OTHER_WRITE)
	) {
		return none(
			`${file} can be written by others (chmod 600 it); no remote GM keys`
		);
	}

	const read = yield* readBounded(fs, file, GM_KEYS_BYTES);

	if (!read.ok) {
		return none(`${file} ${read.problem}; no remote GM keys`);
	}

	const text = utf8Of(read.bytes);

	return text === undefined
		? none(`${file} isn't UTF-8 text; no remote GM keys`)
		: { fingerprints: parseGmKeys(text) };
});

export const warnGmKeys = Effect.fn("warnGmKeys")(function* (
	warned: Ref.Ref<string | undefined>,
	keys: GmKeys
) {
	const before = yield* Ref.getAndSet(warned, keys.problem);

	if (keys.problem !== undefined && keys.problem !== before) {
		yield* Effect.logWarning(`agents: ${keys.problem}`);
	}
});
