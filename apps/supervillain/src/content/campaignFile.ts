import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { DEFAULT_RULESET, type Ruleset, RULESETS } from "../game/table.ts";
import { orList } from "../game/text.ts";
import { CampaignConfigInvalid, ContentReadError } from "./errors.ts";

// A campaign's settings: `campaign.yaml` at its root, which says what it plays. A campaign without
// one plays Draw Steel, as every campaign did before there was a choice.

/** The file's name in a campaign folder. */
export const CAMPAIGN_FILE = "campaign.yaml";

export interface CampaignConfig {
  /** The ruleset the table plays: which commands it offers and what its seats see. */
  readonly rules: Ruleset;
}

/** What `new` writes: the ruleset, with a word on what else it could be. */
export const campaignYaml = (rules: Ruleset): string =>
  `# What this campaign plays: ${RULESETS.join(" or ")}.\nrules: ${rules}\n`;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Reads a campaign's `campaign.yaml`, or the defaults when there is none. A setting it doesn't
 * know is refused rather than ignored, so `rule: set-world` can't quietly play Draw Steel.
 */
export const readCampaignConfig = (
  dir: string,
): Effect.Effect<CampaignConfig, CampaignConfigInvalid | ContentReadError> =>
  Effect.gen(function* () {
    const file = join(dir, CAMPAIGN_FILE);
    const text = yield* Effect.tryPromise({
      try: () =>
        readFile(file, "utf8").catch((e: NodeJS.ErrnoException) =>
          e.code === "ENOENT" ? undefined : Promise.reject(e),
        ),
      catch: (e) =>
        new ContentReadError({
          message: `can't read ${file}: ${messageOf(e)}`,
        }),
    });
    if (text === undefined) return { rules: DEFAULT_RULESET };
    const invalid = (why: string) =>
      new CampaignConfigInvalid({ file, message: `${file}: ${why}` });
    const parsed = yield* Effect.try({
      try: () => Bun.YAML.parse(text) as unknown,
      catch: (e) => invalid(`isn't YAML (${messageOf(e)})`),
    });
    // An empty file has nothing to say: the defaults stand.
    if (parsed === null || parsed === undefined) return { rules: DEFAULT_RULESET };
    if (typeof parsed !== "object" || Array.isArray(parsed))
      return yield* invalid("should hold settings like `rules: draw-steel`");
    const settings = parsed as Record<string, unknown>;
    const unknown = Object.keys(settings).filter((k) => k !== "rules");
    if (unknown.length > 0)
      return yield* invalid(
        `has ${unknown.map((k) => `\`${k}\``).join(", ")}, which no campaign has; it holds only \`rules\``,
      );
    const rules = settings.rules ?? DEFAULT_RULESET;
    const known = RULESETS.find((r) => r === rules);
    if (known === undefined)
      return yield* invalid(
        `says rules: ${typeof rules === "string" ? rules : JSON.stringify(rules)}, but a campaign plays ${orList(RULESETS)}`,
      );
    return { rules: known };
  });
