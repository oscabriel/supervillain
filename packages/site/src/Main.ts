import { Data, Effect, Match, Option, Schema, Stream } from "effect";
import { Command, Subscription } from "foldkit";
import type { Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { load, pushUrl } from "foldkit/navigation";
import type { Url } from "foldkit/url";
import { toString as urlToString } from "foldkit/url";

import { advanceAutoplay, delayOfStep } from "./Autoplay.ts";
import { blogView, postView } from "./Blog.ts";
import { docOf, postOf } from "./Content.ts";
import { docsHubView, docView } from "./Docs.ts";
import { homeView, JOIN_COMMAND } from "./Home.ts";
import { pageView } from "./Layout.ts";
import { Message, ranLine } from "./Model.ts";
import type { Key, Model } from "./Model.ts";
import { AppRoute, homeRouter, urlToAppRoute } from "./Route.ts";
import type { Demo } from "./Table.ts";
import {
	actedSquare,
	actedToken,
	closedReply,
	DEMO,
	escaped,
	recalled,
	restarted,
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

export const init = (url: Url): Return => {
	const route = routeOf(url);

	return {
		model: {
			route,
			demo: DEMO,
			copied: false,
			copiedBlock: "",
			copyToken: 0,
			mapMode: "pictures",
			autoplay: AppRoute.guards.Home(route),
			autoplayStep: 0,
			autoplayLine: "",
		},
	};
};

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
				input.focus({ preventScroll: true });
				input.setSelectionRange(input.value.length, input.value.length);
			}
		}).pipe(Effect.as(Message.CompletedNavigate())),
});

class ClipboardUnavailable extends Data.TaggedError("ClipboardUnavailable")<{
	readonly cause: unknown;
}> {}

const writeClipboard = (text: string) =>
	Effect.tryPromise({
		try: async () => {
			await navigator.clipboard.writeText(text);
		},
		catch: (cause) => new ClipboardUnavailable({ cause }),
	}).pipe(Effect.ignore);

const CopyCommand = Command.define("CopyCommand", {
	args: { text: Schema.String, token: Schema.Int },
	messages: [Message.ResetCopyCommand],
	execute: ({ text, token }) =>
		writeClipboard(text).pipe(
			Effect.andThen(Effect.sleep("1800 millis")),
			Effect.as(Message.ResetCopyCommand({ token }))
		),
});

const CopyCode = Command.define("CopyCode", {
	args: { id: Schema.String, text: Schema.String, token: Schema.Int },
	messages: [Message.ResetCopyCode],
	execute: ({ id, text, token }) =>
		writeClipboard(text).pipe(
			Effect.andThen(Effect.sleep("1800 millis")),
			Effect.as(Message.ResetCopyCode({ id, token }))
		),
});

const stopped = (model: Model): Model => ({
	...model,
	autoplay: false,
	autoplayLine: "",
});

const playing = (model: Model, demo: Demo): Return => ({
	model: { ...stopped(model), demo },
});

const playingClick = (model: Model, demo: Demo): Return =>
	demo.line === ""
		? { model: { ...stopped(model), demo } }
		: {
				model: { ...stopped(model), demo },
				commands: [FocusLine({ selector: "#demo-line" })],
			};

const prefersReducedMotion = (): boolean =>
	globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	autoplay: entry(
		{ active: Schema.Boolean, step: Schema.Int },
		{
			modelToDependencies: (model) => ({
				active: AppRoute.guards.Home(model.route) && model.autoplay,
				step: model.autoplayStep,
			}),
			dependenciesToStream: ({ active, step }) => {
				if (!active) {
					return Stream.empty;
				}

				if (prefersReducedMotion()) {
					return Stream.make(Message.PausedAutoplay());
				}

				return Stream.fromEffect(
					Effect.sleep(`${delayOfStep(step)} millis`).pipe(
						Effect.as(Message.AutoplayStepped({ step }))
					)
				);
			},
		}
	),
}));

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
			model: {
				...model,
				route: routeOf(url),
				copied: false,
				copiedBlock: "",
				copyToken: model.copyToken + 1,
			},
			commands: [Settle({ anchor: Option.getOrElse(url.hash, () => "") })],
		}),
		CompletedNavigate: () => ({ model }),
		TypedLine: ({ line }) => playing(model, typed(model.demo, line)),
		SubmittedLine: () => ({ model: ranLine(stopped(model), model.demo.line) }),
		ClickedSuggestion: ({ line }) => ({ model: ranLine(stopped(model), line) }),
		ClickedSquare: ({ square }) =>
			playingClick(model, actedSquare(model.demo, square)),
		ClickedToken: ({ id }) => playingClick(model, actedToken(model.demo, id)),
		PressedKey: ({ key }) => playing(model, pressed(model.demo, key)),
		ClickedCloseReply: () => playing(model, closedReply(model.demo)),
		ClickedLogToggle: () => playing(model, toggledLog(model.demo)),
		ClickedRestart: () => playing(model, restarted(model.demo)),
		ClickedMapMode: ({ mode }) => ({
			model: {
				...stopped(model),
				mapMode: mode,
				demo: { ...model.demo, refusal: "" },
			},
		}),
		AutoplayStepped: ({ step }) => {
			if (!model.autoplay || model.autoplayStep !== step) {
				return { model };
			}

			const next = advanceAutoplay(model.demo, step);

			return {
				model: {
					...model,
					demo: next.demo,
					autoplayLine: next.autoplayLine,
					autoplayStep: next.nextStep,
				},
			};
		},
		PausedAutoplay: () => ({ model: stopped(model) }),
		StartedAutoplay: () => ({
			model: {
				...model,
				demo: restarted(model.demo),
				autoplay: true,
				autoplayStep: 0,
				autoplayLine: "",
			},
		}),
		MountedHeroWaves: () => ({ model }),
		ClickedCopyCommand: () => {
			const token = model.copyToken + 1;

			return {
				model: { ...model, copied: true, copyToken: token },
				commands: [CopyCommand({ text: JOIN_COMMAND, token })],
			};
		},
		ResetCopyCommand: ({ token }) => ({
			model: model.copyToken === token ? { ...model, copied: false } : model,
		}),
		ClickedCopyCode: ({ id, text }) => {
			const token = model.copyToken + 1;

			return {
				model: { ...model, copiedBlock: id, copyToken: token },
				commands: [CopyCode({ id, text, token })],
			};
		},
		ResetCopyCode: ({ id, token }) => ({
			model:
				model.copyToken === token && model.copiedBlock === id
					? { ...model, copiedBlock: "" }
					: model,
		}),
	});

const notFoundView = (h: HtmlBuilder<Message>) => [
	h.div(
		[h.Class("container")],
		[
			h.div(
				[h.Class("column")],
				[
					h.h1([], ["There's no table called that here"]),
					h.p(
						[h.Class("lede")],
						[
							"This page doesn't exist. ",
							h.a(
								[h.Href(homeRouter()), h.Class("call-link")],
								["Back to the front page →"]
							),
						]
					),
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
			body: pageView(route, h, docView(doc, h, model.copiedBlock)),
		};
	}

	if (post !== undefined) {
		return {
			title: `${post.title} · supervillain`,
			body: pageView(route, h, postView(post, h, model.copiedBlock)),
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
