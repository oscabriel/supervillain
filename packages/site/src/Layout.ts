import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./Model.ts";
import {
	AppRoute,
	blogRouter,
	docRouter,
	docsRouter,
	homeRouter,
} from "./Route.ts";

export const SOURCE = "https://github.com/oscabriel/supervillain";

const HOSTING = docRouter({ slug: "hosting" });

const isDocs = (route: AppRoute): boolean =>
	AppRoute.guards.Docs(route) || AppRoute.guards.Doc(route);

const isBlog = (route: AppRoute): boolean =>
	AppRoute.guards.Blog(route) || AppRoute.guards.Post(route);

const linkView = (
	h: HtmlBuilder<Message>,
	href: string,
	text: string,
	isHere: boolean
): Html =>
	h.a([h.Href(href), h.AriaCurrent(isHere ? "page" : "false")], [text]);

const headView = (route: AppRoute, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("g-nav-bar")],
		[
			h.header(
				[h.Class("g-nav")],
				[
					h.a([h.Href(homeRouter()), h.Class("g-brand")], ["supervillain"]),
					h.nav(
						[h.Class("g-links"), h.AriaLabel("Site")],
						[
							linkView(h, docsRouter(), "Docs", isDocs(route)),
							linkView(h, blogRouter(), "Blog", isBlog(route)),
							h.a([h.Href(SOURCE)], ["GitHub"]),
						]
					),
					h.div(
						[h.Class("g-nav-right")],
						[h.a([h.Href(HOSTING), h.Class("g-pill")], ["Host a table"])]
					),
				]
			),
		]
	);

const footView = (h: HtmlBuilder<Message>): Html =>
	h.footer(
		[h.Class("g-foot-bar")],
		[
			h.div(
				[h.Class("g-foot")],
				[
					h.span([], ["supervillain · MIT License"]),
					h.span(
						[h.Class("g-foot-legal")],
						[
							"Independent product published under the DRAW STEEL Creator License, not affiliated with MCDM Productions, LLC (DRAW STEEL © 2024 MCDM Productions, LLC). pf2e uses the ORC License.",
						]
					),
				]
			),
		]
	);

export const pageView = (
	route: AppRoute,
	h: HtmlBuilder<Message>,
	content: ReadonlyArray<Html>
): Html =>
	h.div(
		[h.Class("shell-page")],
		[headView(route, h), h.main([h.Class("page-main")], content), footView(h)]
	);
