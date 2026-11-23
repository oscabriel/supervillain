import {
	ContentReadError,
	DEFAULT_RULESET,
	orList,
	RULESET_NAMES,
} from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect";

import { CampaignConfigInvalid } from "./errors.ts";
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

export const readCampaignConfig = Effect.fn("readCampaignConfig")(function* (
	dir: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(dir, CAMPAIGN_FILE);

	const text = yield* fs.readFileString(file).pipe(
		Effect.asSome,
		Effect.catchReason("PlatformError", "NotFound", () =>
			Effect.succeed(Option.none<string>())
		),
		Effect.mapError(
			(cause) =>
				new ContentReadError({
					message: `can't read ${file}: ${cause.message}`,
					cause,
				})
		)
	);

	if (Option.isNone(text)) {
		return DEFAULTS;
	}

	const invalid = (why: string) =>
		new CampaignConfigInvalid({ file, message: `${file}: ${why}` });

	const parsed = yield* parseYaml(text.value, invalid);

	if (Predicate.isNullish(parsed)) {
		return DEFAULTS;
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
