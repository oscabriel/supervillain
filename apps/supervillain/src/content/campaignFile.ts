import {
	ContentReadError,
	DEFAULT_RULESET,
	orList,
	RULESET_NAMES,
} from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect";
import type { PlatformError } from "effect";

import { readBounded, tooLarge, utf8Of } from "./bounded.ts";
import type { Files } from "./bounded.ts";
import { CampaignConfigInvalid } from "./errors.ts";
import { MD_BYTES, TABLE_FILE } from "./kinds.ts";
import { splitFrontmatter } from "./markdown.ts";
import { YamlValueSchema } from "./sheetFiles.ts";
import type { YamlValue } from "./sheetFiles.ts";

export const CAMPAIGN_FILE = "campaign.yaml";

export interface CampaignConfig {
	readonly rules: RulesetName;
}

export const campaignYaml = (rules: RulesetName): string =>
	`# What this campaign plays: ${orList(RULESET_NAMES)}.\nrules: ${rules}\n`;

const Settings = Schema.Record(Schema.String, YamlValueSchema);

const decodeSettings = Schema.decodeUnknownOption(Settings);

const decodeYamlValue = Schema.decodeUnknownSync(YamlValueSchema);

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const formatRuleValue = (value: YamlValue): string => {
	if (Predicate.isString(value)) {
		return value;
	}

	if (Predicate.isNumber(value)) {
		return String(value);
	}

	const json = decodeJson(value);

	return Option.isSome(json)
		? jsonText(json.value)
		: (JSON.stringify(value) ?? "");
};

const DEFAULTS: CampaignConfig = { rules: DEFAULT_RULESET };

const parseYaml = (
	text: string,
	invalid: (why: string) => CampaignConfigInvalid
) =>
	Effect.try({
		try: () => decodeYamlValue(Bun.YAML.parse(text)),
		catch: (cause) =>
			invalid(
				`isn't YAML (${Predicate.isError(cause) ? cause.message : String(cause)})`
			),
	});

const tableYaml = Effect.fn("campaignFile.tableYaml")(function* (
	{ fs, path }: Files,
	dir: string
) {
	const read = yield* readBounded(fs, path.join(dir, TABLE_FILE), MD_BYTES);
	const text = read.ok ? utf8Of(read.bytes) : undefined;

	if (text === undefined) {
		return Option.none<string>();
	}

	const split = splitFrontmatter(text);

	return "problem" in split ? Option.none<string>() : Option.some(split.yaml);
});

const parsedYaml = (yaml: string): Option.Option<YamlValue> => {
	try {
		return Option.some(decodeYamlValue(Bun.YAML.parse(yaml)));
	} catch {
		return Option.none();
	}
};

const tableRules = Effect.fn("campaignFile.tableRules")(function* (
	files: Files,
	dir: string
) {
	const file = `${dir}/${TABLE_FILE}`;

	const named = Option.flatMap(yield* tableYaml(files, dir), (yaml) =>
		Option.flatMap(parsedYaml(yaml), (value) =>
			Predicate.isNullish(value) || Array.isArray(value)
				? Option.none()
				: Option.flatMap(decodeSettings(value), (s) =>
						Option.fromNullishOr(s.rules)
					)
		)
	);

	if (Option.isNone(named)) {
		return Option.none<CampaignConfig>();
	}

	const known = RULESET_NAMES.find((name) => name === named.value);

	if (known === undefined) {
		return yield* new CampaignConfigInvalid({
			file,
			message: `${file}: says rules: ${formatRuleValue(named.value)}, but a campaign plays ${orList(RULESET_NAMES)}`,
		});
	}

	return Option.some<CampaignConfig>({ rules: known });
});

const readCampaignYaml = Effect.fn("campaignFile.readCampaignYaml")(function* (
	fs: FileSystem.FileSystem,
	file: string
) {
	const readError = (cause: PlatformError.PlatformError) =>
		new ContentReadError({
			message: `can't read ${file}: ${cause.message}`,
			cause,
		});

	const info = yield* fs.stat(file).pipe(
		Effect.asSome,
		Effect.catchReason("PlatformError", "NotFound", () =>
			Effect.succeed(Option.none<FileSystem.File.Info>())
		),
		Effect.mapError(readError)
	);

	if (Option.isNone(info)) {
		return Option.none<string>();
	}

	if (info.value.type !== "File") {
		return yield* new CampaignConfigInvalid({
			file,
			message: `${file}: isn't a plain file`,
		});
	}

	const size = Number(info.value.size);

	if (size > MD_BYTES) {
		return yield* new CampaignConfigInvalid({
			file,
			message: `${file}: ${tooLarge(size, MD_BYTES)}`,
		});
	}

	const bytes = yield* fs.readFile(file).pipe(Effect.mapError(readError));

	if (bytes.length > MD_BYTES) {
		return yield* new CampaignConfigInvalid({
			file,
			message: `${file}: ${tooLarge(bytes.length, MD_BYTES)}`,
		});
	}

	const text = utf8Of(bytes);

	return text === undefined
		? yield* new CampaignConfigInvalid({
				file,
				message: `${file}: isn't valid UTF-8 text`,
			})
		: Option.some(text);
});

export const campaignConfigWith = Effect.fn("campaignConfigWith")(function* (
	files: Files,
	dir: string
) {
	const { fs, path } = files;
	const file = path.join(dir, CAMPAIGN_FILE);
	const text = yield* readCampaignYaml(fs, file);

	const fromTable = Option.getOrUndefined(yield* tableRules(files, dir));

	if (Option.isNone(text)) {
		return fromTable ?? DEFAULTS;
	}

	const invalid = (why: string) =>
		new CampaignConfigInvalid({ file, message: `${file}: ${why}` });

	const parsed = yield* parseYaml(text.value, invalid);

	if (Predicate.isNullish(parsed)) {
		return fromTable ?? DEFAULTS;
	}

	const settings = Array.isArray(parsed)
		? Option.none()
		: decodeSettings(parsed);

	if (Option.isNone(settings)) {
		return yield* invalid("should hold settings like `rules: draw-steel`");
	}

	const unknown = Object.keys(settings.value).filter((key) => key !== "rules");

	if (unknown.length > 0) {
		return yield* invalid(
			`has ${unknown.map((key) => `\`${key}\``).join(", ")}, which no campaign has; it holds only \`rules\``
		);
	}

	if (settings.value.rules !== undefined && fromTable !== undefined) {
		return yield* invalid(
			`says rules: ${formatRuleValue(settings.value.rules)}, and table.md names the rules too; name them in one place`
		);
	}

	if (settings.value.rules === undefined && fromTable !== undefined) {
		return fromTable;
	}

	const rules = settings.value.rules ?? DEFAULT_RULESET;
	const known = RULESET_NAMES.find((name) => name === rules);

	if (known === undefined) {
		return yield* invalid(
			`says rules: ${formatRuleValue(rules)}, but a campaign plays ${orList(RULESET_NAMES)}`
		);
	}

	const config: CampaignConfig = { rules: known };

	return config;
});

export const readCampaignConfig = Effect.fn("readCampaignConfig")(function* (
	dir: string
) {
	const files: Files = {
		fs: yield* FileSystem.FileSystem,
		path: yield* Path.Path,
	};

	return yield* campaignConfigWith(files, dir);
});
