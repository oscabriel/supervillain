import { Effect, Option } from "effect";
import { Server } from "foldkit/experimental";
import { fromString } from "foldkit/url";

import { DOCS, docHref, POSTS, postHref } from "./Content.ts";
import { init, routeOf, view } from "./Main.ts";
import { AppRoute, blogRouter, docsRouter, homeRouter } from "./Route.ts";

const ABOUT =
	"supervillain is a terminal-first virtual tabletop. Players type ssh room@host and sit at a live table, with nothing to install and no account to make. The GM's machine runs the rules and keeps the campaign as a plain append-only log.";

const HEAD = [
	`<meta name="description" content="${ABOUT}" />`,
	`<meta property="og:site_name" content="supervillain" />`,
	`<meta property="og:description" content="${ABOUT}" />`,
	`<meta name="color-scheme" content="dark" />`,
	`<meta name="theme-color" content="#0c0e12" />`,
	`<link rel="icon" href="/icon.svg" type="image/svg+xml" />`,
].join("");

export const renderDocument: Server.DocumentRenderer = (application, assets) =>
	Server.renderDocument(application, assets, { head: HEAD });

export const prerenderPaths: ReadonlyArray<string> = [
	homeRouter(),
	docsRouter(),
	...DOCS.map(docHref),
	blogRouter(),
	...POSTS.map(postHref),
];

const statusOf = (request: Request): number =>
	Option.match(fromString(request.url), {
		onNone: () => 404,
		onSome: (url) => (AppRoute.guards.NotFound(routeOf(url)) ? 404 : 200),
	});

export const renderPage = async (
	request: Request
): Promise<Server.EntryResult> => {
	const application = await Effect.runPromise(
		Server.renderToString({ routing: {}, init, view }, { url: request.url })
	);

	return Server.Rendered(application, { status: statusOf(request) });
};
