import { homedir } from "node:os";

import type { RulesetName } from "@supervillain/domain";
import { Config, Effect, FileSystem, Option, Path } from "effect";

import { CAMPAIGN_FILE, readCampaignConfig } from "../content/campaignFile.ts";

export const HOME_FOLDER = "supervillain";

export interface FoundCampaign {
	readonly dir: string;
	readonly name: string;
	readonly rules: RulesetName;
	readonly lastPlayed: Option.Option<Date>;
	readonly here: boolean;
}

export const supervillainHome = Effect.gen(function* () {
	const path = yield* Path.Path;

	const set = yield* Config.option(Config.String("SUPERVILLAIN_HOME")).pipe(
		Effect.orElseSucceed(() => Option.none<string>())
	);

	return Option.match(set, {
		onNone: () => path.join(homedir(), HOME_FOLDER),
		onSome: (dir) =>
			dir === "" ? path.join(homedir(), HOME_FOLDER) : path.resolve(dir),
	});
}).pipe(Effect.withSpan("scan.supervillainHome"));

export const isBareName = (name: string): boolean =>
	name !== "" &&
	!name.includes("/") &&
	!name.includes("\\") &&
	!name.includes(".");

const isFile = (fs: FileSystem.FileSystem, file: string) =>
	fs.stat(file).pipe(
		Effect.map((info) => info.type === "File"),
		Effect.orElseSucceed(() => false)
	);

export const campaignAt = Effect.fn("scan.campaignAt")(function* (
	dir: string,
	here: boolean
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const log = path.join(dir, "events.jsonl");
	const marked = yield* isFile(fs, path.join(dir, CAMPAIGN_FILE));
	const played = yield* isFile(fs, log);

	if (!marked && !played) {
		return Option.none<FoundCampaign>();
	}

	const config = yield* readCampaignConfig(dir).pipe(Effect.option);

	if (Option.isNone(config)) {
		return Option.none<FoundCampaign>();
	}

	const lastPlayed = played
		? yield* fs.stat(log).pipe(
				Effect.map((info) => info.mtime),
				Effect.orElseSucceed(() => Option.none<Date>())
			)
		: Option.none<Date>();

	const found: FoundCampaign = {
		dir,
		name: path.basename(dir),
		rules: config.value.rules,
		lastPlayed,
		here,
	};

	return Option.some(found);
});

const childrenOf = Effect.fn("scan.childrenOf")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const names = yield* fs
		.readDirectory(dir)
		.pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

	const folders = yield* Effect.forEach(
		names.filter((name) => !name.startsWith(".")).toSorted(),
		(name) => {
			const child = path.join(dir, name);

			return fs.stat(child).pipe(
				Effect.map((info) => (info.type === "Directory" ? [child] : [])),
				Effect.orElseSucceed((): ReadonlyArray<string> => [])
			);
		},
		{ concurrency: 8 }
	);

	return folders.flat();
});

const playedAt = (found: FoundCampaign): number =>
	Option.match(found.lastPlayed, {
		onNone: () => 0,
		onSome: (date) => date.getTime(),
	});

const byLastPlayed = (a: FoundCampaign, b: FoundCampaign): number => {
	const later = playedAt(b) - playedAt(a);

	return later === 0 ? a.name.localeCompare(b.name) : later;
};

export const scanCampaigns = Effect.fn("scan.scanCampaigns")(function* (
	cwd: string,
	home: string
) {
	const path = yield* Path.Path;
	const here = path.resolve(cwd);
	const atHere = yield* campaignAt(here, true);

	const below = [
		...(yield* childrenOf(here)),
		...(yield* childrenOf(path.resolve(home))),
	];

	const seen = new Set<string>([here]);

	const unique = below.filter((dir) => {
		if (seen.has(dir)) {
			return false;
		}

		seen.add(dir);

		return true;
	});

	const found = yield* Effect.forEach(unique, (dir) => campaignAt(dir, false), {
		concurrency: 8,
	});

	const rest = found
		.flatMap((each) => Option.toArray(each))
		.toSorted(byLastPlayed);

	return Option.isSome(atHere) ? [atHere.value, ...rest] : rest;
});
