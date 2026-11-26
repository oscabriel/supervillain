import { Schema } from "effect";

import { hasTerminalControls } from "./text.ts";

export const ParaSchema = Schema.Struct({
	kind: Schema.Literal("para"),
	text: Schema.String,
});

export const PreSchema = Schema.Struct({
	kind: Schema.Literal("pre"),
	lines: Schema.Array(Schema.String),
});

export const ListSchema = Schema.Struct({
	kind: Schema.Literal("list"),
	ordered: Schema.Boolean,
	items: Schema.Array(Schema.String),
});

export const QuoteSchema = Schema.Struct({
	kind: Schema.Literal("quote"),
	text: Schema.String,
});

export const HeadingSchema = Schema.Struct({
	kind: Schema.Literal("heading"),
	level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
	text: Schema.String,
});

export const ProseBlockSchema = Schema.Union([
	ParaSchema,
	PreSchema,
	ListSchema,
	QuoteSchema,
	HeadingSchema,
]).annotate({
	identifier: "ProseBlock",
	description:
		"One block of player-safe Markdown: a paragraph, preformatted lines, a list, a quote or a heading.",
});

export const ProseSchema = Schema.Array(ProseBlockSchema).annotate({
	identifier: "Prose",
	description: "Player-safe Markdown, parsed into blocks.",
});

export type ProseBlock = typeof ProseBlockSchema.Type;

export type Prose = typeof ProseSchema.Type;

const proseJson = Schema.encodeSync(Schema.fromJsonString(ProseSchema));

export const proseBytes = (prose: Prose): number =>
	new TextEncoder().encode(proseJson(prose)).length;

export const proseStrings = (prose: Prose): ReadonlyArray<string> =>
	prose.flatMap((block): ReadonlyArray<string> => {
		switch (block.kind) {
			case "pre": {
				return block.lines;
			}

			case "list": {
				return block.items;
			}

			case "para":
			case "quote":
			case "heading": {
				return [block.text];
			}

			default: {
				return [];
			}
		}
	});

export const proseSafe = (prose: Prose): boolean =>
	!proseStrings(prose).some(hasTerminalControls);

const blockLines = (block: ProseBlock): ReadonlyArray<string> => {
	switch (block.kind) {
		case "pre": {
			return block.lines.map((line) => `  ${line}`);
		}

		case "list": {
			return block.items.map((item, i) =>
				block.ordered ? `${i + 1}. ${item}` : `• ${item}`
			);
		}

		case "quote": {
			return [`│ ${block.text}`];
		}

		case "heading": {
			return [block.text.toUpperCase()];
		}

		case "para": {
			return [block.text];
		}

		default: {
			return [];
		}
	}
};

export const proseLines = (prose: Prose): ReadonlyArray<string> =>
	prose.flatMap((block, i) =>
		i === 0 ? blockLines(block) : ["", ...blockLines(block)]
	);
