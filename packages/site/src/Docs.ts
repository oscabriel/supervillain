import type { Html, HtmlBuilder } from "foldkit/html";

import { DOCS, docHref } from "./Content.ts";
import type { Message, Model } from "./Model.ts";
import type { Page } from "./Pages.ts";
import { proseView, anchorsOf } from "./Prose.ts";
import {
	PROTOCOL_ANCHORS,
	PROTOCOL_SUMMARY,
	PROTOCOL_TITLE,
	protocolContentView,
} from "./Protocol.ts";
import { docsRouter, protocolRouter } from "./Route.ts";

interface DocNavItem {
	readonly slug: string;
	readonly title: string;
	readonly summary: string;
	readonly href: string;
}

const PROTOCOL_ITEM: DocNavItem = {
	slug: "protocol",
	title: PROTOCOL_TITLE,
	summary: PROTOCOL_SUMMARY,
	href: protocolRouter(),
};

const navItems = (): ReadonlyArray<DocNavItem> => [
	...DOCS.map((page) => ({
		slug: page.slug,
		title: page.title,
		summary: page.summary,
		href: docHref(page),
	})),
	PROTOCOL_ITEM,
];

const listView = (here: string, h: HtmlBuilder<Message>): Html =>
	h.ol(
		[],
		navItems().map((other) =>
			h.li(
				[],
				[
					h.a(
						[
							h.Href(other.href),
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
	other: DocNavItem | undefined,
	label: string,
	side: string
): ReadonlyArray<Html> =>
	other === undefined
		? []
		: [
				h.a(
					[h.Href(other.href), h.Class(`turn-card ${side}`)],
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
							"Players need a terminal and ssh. GMs keep their campaign in plain files and run one local binary. These guides cover sitting down, hosting, rulesets, agents, and the protocol reference.",
						]
					),
					h.ol(
						[h.Class("hub")],
						navItems().map((page, index) =>
							h.li(
								[],
								[
									h.a(
										[h.Href(page.href)],
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

const shellDocView = (
	slug: string,
	title: string,
	summary: string,
	anchors: ReadonlyArray<{ readonly id: string; readonly text: string }>,
	body: ReadonlyArray<Html>,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
	const items = navItems();
	const at = items.findIndex((other) => other.slug === slug);

	const columns: Array<Html> = [
		h.nav(
			[h.Class("docs-list wide"), h.AriaLabel("Docs")],
			[
				h.a([h.Href(docsRouter()), h.Class("rail-heading")], ["Documentation"]),
				listView(slug, h),
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
				listView(slug, h),
			]
		),
		h.article(
			[h.Class("doc-sheet")],
			[
				h.header(
					[h.Class("doc-head")],
					[h.h1([], [title]), h.p([h.Class("lede")], [summary])]
				),
				...body,
				h.nav(
					[h.Class("turns"), h.AriaLabel("Next and previous")],
					[
						...turnView(h, items[at - 1], "← Previous", "back"),
						...turnView(h, items[at + 1], "Next →", "on"),
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

export const docView = (
	page: Page,
	h: HtmlBuilder<Message>,
	copiedBlock = ""
): ReadonlyArray<Html> =>
	shellDocView(
		page.slug,
		page.title,
		page.summary,
		anchorsOf(page.document),
		[proseView(page.document, h, copiedBlock)],
		h
	);

export const protocolDocView = (
	model: Model,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> =>
	shellDocView(
		"protocol",
		PROTOCOL_TITLE,
		PROTOCOL_SUMMARY,
		PROTOCOL_ANCHORS,
		[h.div([h.Class("proto-root")], protocolContentView(model, h))],
		h
	);
