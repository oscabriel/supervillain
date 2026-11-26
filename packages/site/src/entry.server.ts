import { Effect, Option } from "effect";
import { Server } from "foldkit/experimental";
import { fromString } from "foldkit/url";

import { DOCS, docHref } from "./Content.ts";
import { init, routeOf, view } from "./Main.ts";
import {
	acknowledgmentsRouter,
	AppRoute,
	docsRouter,
	homeRouter,
} from "./Route.ts";

const ABOUT =
	"supervillain is a terminal-first virtual tabletop. Players type one ssh command to join a live campaign stage and tactical board, with nothing to install, no accounts, and MCP support for agents.";

const FONTS =
	"https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600&display=swap";

const HEAD = [
	`<meta name="description" content="${ABOUT}" />`,
	`<meta property="og:site_name" content="supervillain" />`,
	`<meta property="og:description" content="${ABOUT}" />`,
	`<meta name="color-scheme" content="dark" />`,
	`<meta name="theme-color" content="#09090b" />`,
	`<link rel="preconnect" href="https://fonts.googleapis.com" />`,
	`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
	`<link rel="stylesheet" href="${FONTS}" />`,
	`<link rel="icon" href="/icon.svg" type="image/svg+xml" />`,
].join("");

export const renderDocument: Server.DocumentRenderer = (application, assets) =>
	Server.renderDocument(application, assets, { head: HEAD });

export const prerenderPaths: ReadonlyArray<string> = [
	homeRouter(),
	docsRouter(),
	...DOCS.map(docHref),
	acknowledgmentsRouter(),
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
