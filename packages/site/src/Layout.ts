import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./Model.ts";
import {
	acknowledgmentsRouter,
	AppRoute,
	docRouter,
	docsRouter,
	homeRouter,
} from "./Route.ts";

export const SOURCE = "https://github.com/oscabriel/supervillain";

const HOSTING = docRouter({ slug: "hosting" });

const isDocs = (route: AppRoute): boolean =>
	AppRoute.guards.Docs(route) ||
	AppRoute.guards.Doc(route) ||
	AppRoute.guards.Protocol(route);

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
					h.a(
						[h.Href(homeRouter()), h.Class("g-brand")],
						[
							h.img([
								h.Src("/icon.svg"),
								h.Alt("supervillain"),
								h.Width("36"),
								h.Height("36"),
							]),
						]
					),
					h.nav(
						[h.Class("g-links"), h.AriaLabel("Site")],
						[
							linkView(h, docsRouter(), "Docs", isDocs(route)),
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

const footView = (route: AppRoute, h: HtmlBuilder<Message>): Html =>
	h.footer(
		[h.Class("g-foot-bar")],
		[
			h.div(
				[h.Class("g-foot")],
				[
					h.span([], ["supervillain"]),
					linkView(
						h,
						acknowledgmentsRouter(),
						"Acknowledgments",
						AppRoute.guards.Acknowledgments(route)
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
		[
			headView(route, h),
			h.main([h.Class("page-main")], content),
			footView(route, h),
		]
	);
