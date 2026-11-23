import type { Html, HtmlBuilder } from "foldkit/html";

import { DOCS, docHref } from "./Content.ts";
import type { Message } from "./Model.ts";
import type { Page } from "./Pages.ts";
import { anchorsOf, proseView } from "./Prose.ts";
import { docsRouter } from "./Route.ts";

const listView = (here: string, h: HtmlBuilder<Message>): Html =>
	h.ol(
		[],
		DOCS.map((other) =>
			h.li(
				[],
				[
					h.a(
						[
							h.Href(docHref(other)),
							h.AriaCurrent(other.slug === here ? "page" : "false"),
						],
						[other.title]
					),
				]
			)
		)
	);

const turnView = (
	h: HtmlBuilder<Message>,
	other: Page | undefined,
	label: string,
	side: string
): ReadonlyArray<Html> =>
	other === undefined
		? []
		: [
				h.a(
					[h.Href(docHref(other)), h.Class(side)],
					[h.span([h.Class("label")], [label]), h.span([], [other.title])]
				),
			];

export const docsHubView = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	h.div(
		[h.Class("column wide")],
		[
			h.p([h.Class("label")], ["docs"]),
			h.h1([], ["Sit down, host a table, read the rules"]),
			h.p(
				[h.Class("lede")],
				[
					"Players need a terminal and ssh. GMs need one binary and a folder. These pages cover both, the rulesets a campaign can play, and how the pieces fit.",
				]
			),
			h.ol(
				[h.Class("hub")],
				DOCS.map((page, index) =>
					h.li(
						[],
						[
							h.a(
								[h.Href(docHref(page))],
								[
									h.span(
										[h.Class("hub-index"), h.AriaHidden(true)],
										[String(index + 1).padStart(2, "0")]
									),
									h.span([h.Class("hub-title")], [page.title]),
									h.span([h.Class("hub-summary")], [page.summary]),
								]
							),
						]
					)
				)
			),
		]
	),
];

export const docView = (
	page: Page,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
	const at = DOCS.findIndex((other) => other.slug === page.slug);
	const anchors = anchorsOf(page.document);

	const columns: Array<Html> = [
		h.nav(
			[h.Class("docs-list wide"), h.AriaLabel("Docs")],
			[
				h.a([h.Href(docsRouter()), h.Class("label")], ["docs"]),
				listView(page.slug, h),
			]
		),
		h.details(
			[h.Class("docs-list narrow")],
			[
				h.summary([h.Class("label")], ["all of the docs"]),
				listView(page.slug, h),
			]
		),
		h.article(
			[],
			[
				h.h1([], [page.title]),
				h.p([h.Class("lede")], [page.summary]),
				proseView(page.document, h),
				h.nav(
					[h.Class("turns"), h.AriaLabel("Next and previous")],
					[
						...turnView(h, DOCS[at - 1], "before", "back"),
						...turnView(h, DOCS[at + 1], "next", "on"),
					]
				),
			]
		),
	];

	if (anchors.length >= 2) {
		columns.push(
			h.nav(
				[h.Class("docs-here"), h.AriaLabel("On this page")],
				[
					h.p([h.Class("label")], ["on this page"]),
					h.ol(
						[],
						anchors.map((anchor) =>
							h.li([], [h.a([h.Href(`#${anchor.id}`)], [anchor.text])])
						)
					),
				]
			)
		);
	}

	return [h.div([h.Class("docs")], columns)];
};
