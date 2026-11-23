import { Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal, slash, string } from "foldkit/route";
import type { Url } from "foldkit/url";

export const AppRoute = defineRouteUnion({
	Home: {},
	Docs: {},
	Doc: { slug: Schema.String },
	Blog: {},
	Post: { slug: Schema.String },
	NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

export const docsRouter = pipe(literal("docs"), Route.mapTo(AppRoute.Docs));

export const docRouter = pipe(
	literal("docs"),
	slash(string("slug")),
	Route.mapTo(AppRoute.Doc)
);

export const blogRouter = pipe(literal("blog"), Route.mapTo(AppRoute.Blog));

export const postRouter = pipe(
	literal("blog"),
	slash(string("slug")),
	Route.mapTo(AppRoute.Post)
);

const parse = Route.parseUrlWithFallback(
	Route.oneOf(docRouter, docsRouter, postRouter, blogRouter, homeRouter),
	AppRoute.NotFound
);

export const urlToAppRoute = (url: Url): AppRoute =>
	parse({ ...url, pathname: url.pathname.replace(/(?<=.)\/$/u, "") });
