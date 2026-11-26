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
					[h.Href(docHref(other)), h.Class(`turn-card ${side}`)],
					[
						h.span([h.Class("turn-label")], [label]),
						h.span([h.Class("turn-title")], [other.title]),
					]
				),
			];

export const docsHubView = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	h.div(
		[h.Class("container")],
		[
			h.div(
				[h.Class("column wide")],
				[
					h.h1([], ["Sit down, host a table, connect an agent"]),
					h.p(
						[h.Class("lede")],
						[
							"Players need a terminal and ssh. GMs keep their campaign in plain files and run one local binary. These guides cover sitting down, hosting, rulesets, agents, and how the pieces fit.",
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
											h.span([h.Class("hub-arrow"), h.AriaHidden(true)], ["→"]),
										]
									),
								]
							)
						)
					),
				]
			),
		]
	),
];

export const docView = (
	page: Page,
	h: HtmlBuilder<Message>,
	copiedBlock = ""
): ReadonlyArray<Html> => {
	const at = DOCS.findIndex((other) => other.slug === page.slug);
	const anchors = anchorsOf(page.document);

	const columns: Array<Html> = [
		h.nav(
			[h.Class("docs-list wide"), h.AriaLabel("Docs")],
			[
				h.a([h.Href(docsRouter()), h.Class("rail-heading")], ["Documentation"]),
				listView(page.slug, h),
			]
		),
		h.details(
			[h.Class("docs-list narrow")],
			[
				h.summary(
					[h.Class("rail-heading")],
					[
						h.span([h.Class("summary-chevron"), h.AriaHidden(true)], ["▸"]),
						"All documentation",
					]
				),
				listView(page.slug, h),
			]
		),
		h.article(
			[h.Class("doc-sheet")],
			[
				h.header(
					[h.Class("doc-head")],
					[h.h1([], [page.title]), h.p([h.Class("lede")], [page.summary])]
				),
				proseView(page.document, h, copiedBlock),
				h.nav(
					[h.Class("turns"), h.AriaLabel("Next and previous")],
					[
						...turnView(h, DOCS[at - 1], "← Previous", "back"),
						...turnView(h, DOCS[at + 1], "Next →", "on"),
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
					h.p([h.Class("rail-heading")], ["On this page"]),
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

	return [h.div([h.Class("container")], [h.div([h.Class("docs")], columns)])];
};
