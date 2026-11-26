import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect";

import { CAMPAIGN_FILE, campaignYaml } from "./campaignFile.ts";

export class CampaignError extends Schema.TaggedError<CampaignError>()(
	"CampaignError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

export const COMPILED = import.meta.dir.startsWith("/$bunfs/");

export const examplePath = Effect.map(Path.Path, (path) =>
	COMPILED
		? path.join(import.meta.dir, "campaign")
		: path.join(import.meta.dir, "../../../../examples/campaign")
);

const copyTree = (
	from: string,
	to: string
): Effect.Effect<
	void,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		for (const name of yield* fs.readDirectory(from)) {
			const source = path.join(from, name);
			const target = path.join(to, name);
			const { type } = yield* fs.stat(source);

			if (type === "Directory") {
				yield* fs.makeDirectory(target);
				yield* copyTree(source, target);
			} else {
				yield* fs.writeFile(target, yield* fs.readFile(source));
			}
		}
	});

const emptied = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		yield* Effect.forEach(
			yield* fs.readDirectory(dir),
			(name) => fs.remove(path.join(dir, name), { recursive: true }),
			{ concurrency: 1, discard: true }
		);
	}).pipe(Effect.ignore);

const isFree = (dir: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readDirectory(dir).pipe(
			Effect.map((names) => names.length === 0),
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.succeed(true)
			)
		)
	);

const README_BODY = {
	"draw-steel":
		"A supervillain campaign playing Draw Steel (campaign.yaml says so): hero sheets go in heroes/<id>.yaml, monster stat blocks in monsters/<id>.yaml, text maps in maps/<id>.txt, and the host keeps the log in events.jsonl.",
	"set-world":
		"A supervillain campaign playing set.world's rules (campaign.yaml says so): fighters are rolled at set.world at the table, text maps go in maps/<id>.txt, and the host keeps the log in events.jsonl.",
	freeform:
		"A supervillain campaign playing freeform rules (campaign.yaml says so): table.md is its front page, characters go in party/<id>.md and foes in monsters/<id>.md with any stats you like, scenes in scenes/<id>.md, text maps in maps/<id>.txt, and the host keeps the log in events.jsonl. A ## GM Notes section in any file stays with the GM.",
	pf2e: "A supervillain campaign playing PF2e (Remaster) rules under the ORC License (campaign.yaml says so): PC sheets go in heroes/<id>.yaml (import pathbuilder <file.json> writes one), creature stat blocks in monsters/<id>.yaml, text maps in maps/<id>.txt with 5-ft squares, and the host keeps the log in events.jsonl.",
} as const;

export type Rules = keyof typeof README_BODY;

const TITLE_MAX = 80;

const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const tableMd = (name: string) =>
	`---\ntitle: ${quoted(name.slice(0, TITLE_MAX) || "A new campaign")}\n---\n\nWhat the campaign is about, for the players.\n\n## GM Notes\n\nWhat only you know.\n`;

const readmeFor = (name: string, rules: Rules) =>
	`# ${name}\n\n${README_BODY[rules]}\n`;

export const madeWith = (rules: Rules) => {
	if (rules === "freeform") {
		return " playing freeform, with table.md, party/, monsters/, scenes/ and maps/";
	}

	if (rules === "set-world") {
		return ` playing ${rules}, with maps/`;
	}

	const playing = rules === "draw-steel" ? "" : ` playing ${rules},`;

	return `${playing} with heroes/, monsters/ and maps/`;
};

const emptyCampaign = Effect.fn("newCampaign.emptyCampaign")(function* (
	dir: string,
	rules: Rules
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.writeFileString(path.join(dir, CAMPAIGN_FILE), campaignYaml(rules));

	if (rules === "freeform") {
		yield* fs.makeDirectory(path.join(dir, "party"));
		yield* fs.makeDirectory(path.join(dir, "monsters"));
		yield* fs.makeDirectory(path.join(dir, "scenes"));
		yield* fs.writeFileString(
			path.join(dir, "table.md"),
			tableMd(path.basename(dir))
		);
	} else if (rules !== "set-world") {
		yield* fs.makeDirectory(path.join(dir, "heroes"));
		yield* fs.makeDirectory(path.join(dir, "monsters"));
	}

	yield* fs.makeDirectory(path.join(dir, "maps"));
	yield* fs.writeFileString(
		path.join(dir, "README.md"),
		readmeFor(path.basename(dir), rules)
	);
});

export const writeCampaign = Effect.fn("newCampaign.writeCampaign")(function* (
	dir: string,
	rules: Rules,
	example: boolean
) {
	const fs = yield* FileSystem.FileSystem;

	const unmade = (cause: PlatformError.PlatformError) =>
		new CampaignError({
			message: `can't make a campaign in ${dir}: ${cause.message}`,
			cause,
		});

	const free = yield* isFree(dir).pipe(Effect.mapError(unmade));

	if (!free) {
		return yield* new CampaignError({
			message: `can't make a campaign in ${dir}: it already has files in it`,
		});
	}

	const made = example
		? Effect.flatMap(examplePath, (from) =>
				copyTree(from, dir).pipe(Effect.tapError(() => emptied(dir)))
			)
		: emptyCampaign(dir, rules);

	return yield* fs
		.makeDirectory(dir, { recursive: true, mode: 0o700 })
		.pipe(
			Effect.andThen(fs.chmod(dir, 0o700)),
			Effect.andThen(made),
			Effect.mapError(unmade)
		);
});
