import * as Markdown from "@foldkit/markdown";
import type { Inline, MarkdownDocument } from "@foldkit/markdown";
import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./Model.ts";

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
	h: HtmlBuilder<Message>,
	copiedBlock = ""
): Html =>
	h.div(
		[h.Class("prose")],
		Markdown.viewBlocks(document, {
			views: {
				Heading: ({ level, content }, children) =>
					level <= 2
						? h.h2([h.Id(anchorOf(content).id)], children)
						: h.h3([h.Id(anchorOf(content).id)], children),
				CodeBlock: (block, index) => {
					const id = `code-${index}`;
					const isCopied = copiedBlock === id;
					const language = Option.getOrElse(block.maybeLanguage, () => "");

					return h.div(
						[h.Class("code-block")],
						[
							h.div(
								[h.Class("code-block-bar")],
								[
									h.span(
										[h.Class("code-block-lang")],
										[language === "" ? "snippet" : language]
									),
									h.button(
										[
											h.Type("button"),
											h.Class("code-copy"),
											h.DataAttribute("copied", isCopied ? "true" : "false"),
											h.AriaLabel(
												isCopied ? "Copied code block" : "Copy code block"
											),
											h.OnClick(
												Message.ClickedCopyCode({ id, text: block.value })
											),
										],
										[
											h.span(
												[
													h.Class("copy-label copy-idle"),
													h.AriaHidden(isCopied),
												],
												["Copy"]
											),
											h.span(
												[
													h.Class("copy-label copy-done"),
													h.AriaHidden(!isCopied),
												],
												["Copied"]
											),
										]
									),
								]
							),
							h.pre([], [h.code([], [block.value])]),
						]
					);
				},
				Table: (_table, headerRow, bodyRows) =>
					h.div(
						[h.Class("table")],
						[h.table([], [h.thead([], [headerRow]), h.tbody([], bodyRows)])]
					),
			},
		})
	);
