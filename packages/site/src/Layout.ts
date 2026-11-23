import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./Model.ts";
import { AppRoute, blogRouter, docsRouter, homeRouter } from "./Route.ts";

export const SOURCE = "https://github.com/oscabriel/supervillain";

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
	h.header(
		[h.Class("head")],
		[
			h.a(
				[h.Href(homeRouter()), h.Class("wordmark")],
				[h.span([h.Class("prompt"), h.AriaHidden(true)], ["$"]), "supervillain"]
			),
			h.nav(
				[h.Class("nav"), h.AriaLabel("Site")],
				[
					linkView(h, docsRouter(), "docs", isDocs(route)),
					linkView(h, blogRouter(), "blog", isBlog(route)),
					h.a([h.Href(SOURCE)], ["source"]),
				]
			),
		]
	);

const footView = (h: HtmlBuilder<Message>): Html =>
	h.footer(
		[h.Class("foot")],
		[
			h.p(
				[],
				[
					"supervillain is open-source software under the MIT licence. Independent product published under the DRAW STEEL Creator License, not affiliated with MCDM Productions, LLC (DRAW STEEL © 2024 MCDM Productions, LLC). The pf2e ruleset implements open mechanics under the ORC License.",
				]
			),
			h.nav(
				[h.Class("nav"), h.AriaLabel("More")],
				[
					h.a([h.Href(docsRouter())], ["docs"]),
					h.a([h.Href(blogRouter())], ["blog"]),
					h.a([h.Href(SOURCE)], ["source"]),
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
		[h.Class("site")],
		[headView(route, h), h.main([], content), footView(h)]
	);
