import type { RulesetName } from "@supervillain/domain";
import type { JsonSchema } from "effect";

export type ProtocolRole = "gm" | "player";

export type CommandScope = "core" | "stage" | "ruleset";

export const ALL_RULESETS = [
	"draw-steel",
	"set-world",
	"pf2e",
	"freeform",
] as const satisfies ReadonlyArray<RulesetName>;

export const RULESET_LABELS: Readonly<Record<RulesetName, string>> = {
	"draw-steel": "Draw Steel",
	"set-world": "set.world",
	pf2e: "PF2e (ORC)",
	freeform: "Freeform",
};

export interface ParamEntry {
	readonly name: string;
	readonly type: string;
	readonly required: boolean;
	readonly description: string;
}

export interface CommandDoc {
	readonly type: string;
	readonly toolName: string;
	readonly usage: string;
	readonly summary: string;
	readonly gmOnly: boolean;
	readonly scope: CommandScope;
	readonly hostFacts: ReadonlyArray<string>;
	readonly params: ReadonlyArray<ParamEntry>;
	readonly inputSchema: JsonSchema.JsonSchema;
	readonly jsonSchema: string;
}

export interface MetaToolDoc {
	readonly name: string;
	readonly description: string;
	readonly gmOnly: boolean;
	readonly readOnly: boolean;
	readonly destructive: boolean;
	readonly rulesets: ReadonlyArray<RulesetName>;
	readonly params: ReadonlyArray<ParamEntry>;
	readonly inputSchema: JsonSchema.JsonSchema;
	readonly jsonSchema: string;
}

export interface ResourceDoc {
	readonly uri: string;
	readonly name: string;
	readonly mimeType: string;
	readonly gmOnly: boolean;
	readonly description: string;
}

export interface CampaignSchemaDoc {
	readonly kind: string;
	readonly glob: string;
	readonly uri: string;
	readonly purpose: string;
}

export interface CatalogToolEntry {
	readonly name: string;
	readonly description: string;
	readonly gmOnly: boolean;
	readonly readOnly: boolean;
	readonly destructive: boolean;
	readonly inputSchema: JsonSchema.JsonSchema;
}

export interface McpCatalogDocument {
	readonly ruleset: RulesetName;
	readonly subsystem: string;
	readonly tools: ReadonlyArray<CatalogToolEntry>;
	readonly resources: ReadonlyArray<ResourceDoc>;
}

export interface ProtocolSnapshot {
	readonly commands: Readonly<Record<RulesetName, ReadonlyArray<CommandDoc>>>;
	readonly metaTools: ReadonlyArray<MetaToolDoc>;
	readonly resources: ReadonlyArray<ResourceDoc>;
	readonly campaignSchemas: ReadonlyArray<CampaignSchemaDoc>;
	readonly envelopeSchemaJson: string;
}
