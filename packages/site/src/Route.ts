import { Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal, slash, string } from "foldkit/route";
import type { Url } from "foldkit/url";

export const AppRoute = defineRouteUnion({
	Home: {},
	Docs: {},
	Protocol: {},
	Doc: { slug: Schema.String },
	Acknowledgments: {},
	NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

export const docsRouter = pipe(literal("docs"), Route.mapTo(AppRoute.Docs));

export const protocolRouter = pipe(
	literal("docs"),
	slash(literal("protocol")),
	Route.mapTo(AppRoute.Protocol)
);

export const docRouter = pipe(
	literal("docs"),
	slash(string("slug")),
	Route.mapTo(AppRoute.Doc)
);

export const acknowledgmentsRouter = pipe(
	literal("acknowledgments"),
	Route.mapTo(AppRoute.Acknowledgments)
);

const parse = Route.parseUrlWithFallback(
	Route.oneOf(
		protocolRouter,
		docRouter,
		docsRouter,
		acknowledgmentsRouter,
		homeRouter
	),
	AppRoute.NotFound
);

export const urlToAppRoute = (url: Url): AppRoute =>
	parse({ ...url, pathname: url.pathname.replace(/(?<=.)\/$/u, "") });
