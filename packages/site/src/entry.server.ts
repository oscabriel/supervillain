import { Effect, Option } from "effect";
import { Server } from "foldkit/experimental";
import { fromString } from "foldkit/url";

import { DOCS, docHref } from "./Content.ts";
import { init, routeOf, view } from "./Main.ts";
import { headOf, SITE_ORIGIN } from "./Meta.ts";
import {
	acknowledgmentsRouter,
	AppRoute,
	docsRouter,
	homeRouter,
	protocolRouter,
} from "./Route.ts";

const SOURCE_STYLESHEET = "/src/style.css";

const linkedAssets = (assets: Server.DocumentAssets): Server.DocumentAssets =>
	import.meta.env.DEV
		? { ...assets, stylesheets: [SOURCE_STYLESHEET] }
		: assets;

export const renderDocument: Server.DocumentRenderer = (application, assets) =>
	Server.renderDocument(application, linkedAssets(assets), {
		head: headOf(application.title, SITE_ORIGIN),
	});

export const prerenderPaths: ReadonlyArray<string> = [
	homeRouter(),
	docsRouter(),
	...DOCS.map(docHref),
	protocolRouter(),
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
