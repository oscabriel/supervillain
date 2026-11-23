import type { Html, HtmlBuilder } from "foldkit/html";

import { POSTS, postHref } from "./Content.ts";
import type { Message } from "./Model.ts";
import type { Page } from "./Pages.ts";
import { proseView } from "./Prose.ts";
import { blogRouter } from "./Route.ts";

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export const dayOf = (date: string): string => {
	if (date.trim() === "") {
		return "";
	}

	const [year, month, day] = date.split("-").map(Number);

	if (year === undefined || Number.isNaN(year)) {
		return date;
	}

	return `${day ?? 1} ${MONTHS[(month ?? 1) - 1] ?? ""} ${year}`;
};

export const blogView = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	h.div(
		[h.Class("column")],
		[
			h.p([h.Class("label")], ["blog"]),
			h.h1([], ["Notes from the build"]),
			h.p(
				[h.Class("lede")],
				[
					"How supervillain is made, what it costs to run, and what each choice traded away.",
				]
			),
			h.ol(
				[h.Class("posts")],
				POSTS.map((post) =>
					h.li(
						[],
						[
							h.p([h.Class("label")], [dayOf(post.date)]),
							h.h2([], [h.a([h.Href(postHref(post))], [post.title])]),
							h.p([], [post.summary]),
						]
					)
				)
			),
		]
	),
];

export const postView = (
	post: Page,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => [
	h.article(
		[h.Class("column")],
		[
			h.p([h.Class("label")], [dayOf(post.date)]),
			h.h1([], [post.title]),
			h.p([h.Class("lede")], [post.summary]),
			proseView(post.document, h),
			h.p([h.Class("turns")], [h.a([h.Href(blogRouter())], ["← all posts"])]),
		]
	),
];
