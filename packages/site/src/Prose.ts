import * as Markdown from "@foldkit/markdown";
import type { Inline, MarkdownDocument } from "@foldkit/markdown";
import { Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./Model.ts";

export interface Anchor {
	readonly id: string;
	readonly text: string;
}

const isHeading = Predicate.isTagged("Heading");

const plain = (inline: Inline): string => {
	if ("value" in inline) {
		return inline.value;
	}

	return "content" in inline ? inline.content.map(plain).join("") : "";
};

const anchorOf = (content: ReadonlyArray<Inline>): Anchor => {
	const text = content.map(plain).join("");

	return {
		id: text
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/gu, "-")
			.replaceAll(/^-|-$/gu, ""),
		text,
	};
};

export const anchorsOf = (document: MarkdownDocument): Array<Anchor> =>
	document.blocks.flatMap((block) =>
		isHeading(block) && block.level === 2 ? [anchorOf(block.content)] : []
	);

export const proseView = (
	document: MarkdownDocument,
	h: HtmlBuilder<Message>
): Html =>
	h.div(
		[h.Class("prose")],
		Markdown.viewBlocks(document, {
			views: {
				Heading: ({ level, content }, children) =>
					level <= 2
						? h.h2([h.Id(anchorOf(content).id)], children)
						: h.h3([h.Id(anchorOf(content).id)], children),
				Table: (_table, headerRow, bodyRows) =>
					h.div(
						[h.Class("table")],
						[h.table([], [h.thead([], [headerRow]), h.tbody([], bodyRows)])]
					),
			},
		})
	);
