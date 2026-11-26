import * as Markdown from "@foldkit/markdown";
import type { MarkdownDocument } from "@foldkit/markdown";
import { Schema } from "effect";

import { Frontmatter } from "./Frontmatter.ts";

export interface Written {
	readonly default: unknown;
	readonly frontmatter: unknown;
}

export interface Page {
	readonly slug: string;
	readonly title: string;
	readonly summary: string;
	readonly order: number;
	readonly document: MarkdownDocument;
}

const about = Schema.decodeUnknownSync(Frontmatter);

export const slugOf = (path: string): string =>
	path
		.slice(path.lastIndexOf("/") + 1)
		.replace(/\.md$/u, "")
		.replace(/^\d+-/u, "");

export const pageOf = (path: string, file: Written): Page => {
	const { title, summary, order } = about(file.frontmatter);

	return {
		slug: slugOf(path),
		title,
		summary,
		order: order ?? 0,
		document: Markdown.decodeDocument(file.default),
	};
};

export const inOrder = (pages: ReadonlyArray<Page>): Array<Page> =>
	pages.toSorted((a, b) => a.order - b.order);
