import { Data, Effect, Match, Option, Schema } from "effect";
import { Command } from "foldkit";
import type { Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { load, pushUrl } from "foldkit/navigation";
import type { Url } from "foldkit/url";
import { toString as urlToString } from "foldkit/url";

import { blogView, postView } from "./Blog.ts";
import { docOf, postOf } from "./Content.ts";
import { docsHubView, docView } from "./Docs.ts";
import { homeView, JOIN_COMMAND } from "./Home.ts";
import { pageView } from "./Layout.ts";
import { Message } from "./Model.ts";
import type { Key, Model } from "./Model.ts";
import { AppRoute, homeRouter, urlToAppRoute } from "./Route.ts";
import type { Demo } from "./Table.ts";
import {
	clickedSquare,
	clickedToken,
	closedReply,
	DEMO,
	escaped,
	recalled,
	restarted,
	sent,
	submitted,
	toggledLog,
	typed,
} from "./Table.ts";

type Return = Update.Return<Model, Message>;

export const routeOf = (url: Url): AppRoute => {
	const route = urlToAppRoute(url);

	const isMissing =
		(AppRoute.guards.Doc(route) && docOf(route.slug) === undefined) ||
		(AppRoute.guards.Post(route) && postOf(route.slug) === undefined);

	return isMissing ? AppRoute.NotFound({ path: url.pathname }) : route;
};

export const init = (url: Url): Return => ({
	model: { route: routeOf(url), demo: DEMO, copied: false },
});

const Navigate = Command.define("Navigate", {
	args: { url: Schema.String },
	messages: [Message.CompletedNavigate],
	execute: ({ url }) =>
		pushUrl(url).pipe(Effect.as(Message.CompletedNavigate())),
});

const Leave = Command.define("Leave", {
	args: { href: Schema.String },
	messages: [Message.CompletedNavigate],
	execute: ({ href }) =>
		load(href).pipe(Effect.as(Message.CompletedNavigate())),
});

const Settle = Command.define("Settle", {
	args: { anchor: Schema.String },
	messages: [Message.CompletedNavigate],
	execute: ({ anchor }) =>
		Effect.sync(() => {
			const heading =
				anchor === "" ? null : document.querySelector(`#${CSS.escape(anchor)}`);

			if (heading === null) {
				window.scrollTo({ top: 0 });
			} else {
				heading.scrollIntoView();
			}
		}).pipe(Effect.as(Message.CompletedNavigate())),
});

const FocusLine = Command.define("FocusLine", {
	args: { selector: Schema.String },
	messages: [Message.CompletedNavigate],
	execute: ({ selector }) =>
		Effect.sync(() => {
			const input = document.querySelector(selector);

			if (input instanceof HTMLInputElement) {
				input.focus();
				input.setSelectionRange(input.value.length, input.value.length);
			}
		}).pipe(Effect.as(Message.CompletedNavigate())),
});

class ClipboardUnavailable extends Data.TaggedError("ClipboardUnavailable")<{
	readonly cause: unknown;
}> {}

const CopyCommand = Command.define("CopyCommand", {
	args: { text: Schema.String },
	messages: [Message.ResetCopyCommand],
	execute: ({ text }) =>
		Effect.tryPromise({
			try: async () => {
				await navigator.clipboard.writeText(text);
			},
			catch: (cause) => new ClipboardUnavailable({ cause }),
		}).pipe(
			Effect.ignore,
			Effect.andThen(Effect.sleep("1800 millis")),
			Effect.as(Message.ResetCopyCommand())
		),
});

const playing = (model: Model, demo: Demo): Return => ({
	model: { ...model, demo },
});

const playingFocused = (model: Model, demo: Demo): Return => ({
	model: { ...model, demo },
	commands: [FocusLine({ selector: "#demo-line" })],
});

const pressed = (demo: Demo, key: Key): Demo =>
	Match.value(key).pipe(
		Match.when("ArrowUp", () => recalled(demo, 1)),
		Match.when("ArrowDown", () => recalled(demo, -1)),
		Match.when("Escape", () => escaped(demo)),
		Match.exhaustive
	);

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedLink: ({ request }) => ({
			model,
			commands: [
				Match.value(request).pipe(
					Match.tagsExhaustive({
						Internal: ({ url }) => Navigate({ url: urlToString(url) }),
						External: ({ href }) => Leave({ href }),
					})
				),
			],
		}),
		ChangedUrl: ({ url }) => ({
			model: { ...model, route: routeOf(url), copied: false },
			commands: [Settle({ anchor: Option.getOrElse(url.hash, () => "") })],
		}),
		CompletedNavigate: () => ({ model }),
		TypedLine: ({ line }) => playing(model, typed(model.demo, line)),
		SubmittedLine: () => playing(model, submitted(model.demo)),
		ClickedSuggestion: ({ line }) =>
			playingFocused(model, sent(model.demo, line)),
		ClickedSquare: ({ square }) =>
			playingFocused(model, clickedSquare(model.demo, square)),
		ClickedToken: ({ id }) =>
			playingFocused(model, clickedToken(model.demo, id)),
		PressedKey: ({ key }) => playing(model, pressed(model.demo, key)),
		ClickedCloseReply: () => playing(model, closedReply(model.demo)),
		ClickedLogToggle: () => playing(model, toggledLog(model.demo)),
		ClickedRestart: () => playing(model, restarted(model.demo)),
		ClickedCopyCommand: () => ({
			model: { ...model, copied: true },
			commands: [CopyCommand({ text: JOIN_COMMAND })],
		}),
		ResetCopyCommand: () => ({
			model: { ...model, copied: false },
		}),
	});

const notFoundView = (h: HtmlBuilder<Message>) => [
	h.div(
		[h.Class("column")],
		[
			h.p([h.Class("label")], ["404"]),
			h.h1([], ["There's no table called that here"]),
			h.p(
				[h.Class("lede")],
				[
					"This page doesn't exist. ",
					h.a([h.Href(homeRouter())], ["Back to the front page →"]),
				]
			),
		]
	),
];

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
	const { route } = model;
	const doc = docOf(AppRoute.guards.Doc(route) ? route.slug : "");
	const post = postOf(AppRoute.guards.Post(route) ? route.slug : "");

	if (doc !== undefined) {
		return {
			title: `${doc.title} · supervillain`,
			body: pageView(route, h, docView(doc, h)),
		};
	}

	if (post !== undefined) {
		return {
			title: `${post.title} · supervillain`,
			body: pageView(route, h, postView(post, h)),
		};
	}

	if (AppRoute.guards.Docs(route)) {
		return {
			title: "Docs · supervillain",
			body: pageView(route, h, docsHubView(h)),
		};
	}

	if (AppRoute.guards.Blog(route)) {
		return {
			title: "Blog · supervillain",
			body: pageView(route, h, blogView(h)),
		};
	}

	return AppRoute.guards.Home(route)
		? {
				title: "supervillain: a virtual tabletop you join with ssh",
				body: pageView(route, h, homeView(model, h)),
			}
		: {
				title: "Not found · supervillain",
				body: pageView(route, h, notFoundView(h)),
			};
};
