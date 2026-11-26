import { Option, Schema } from "effect";

import {
	acknowledgmentsRouter,
	AppRoute,
	docRouter,
	docsRouter,
	homeRouter,
	protocolRouter,
} from "./Route.ts";

export const SEARCH_ABOUT =
	"A terminal-first virtual tabletop. Players join a live campaign stage and tactical board with one ssh command: nothing to install and no accounts.";

export const SHARE_ABOUT =
	"A terminal-first virtual tabletop. Join a live table with one ssh command: nothing to install, no accounts.";

const FONTS =
	"https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600&display=swap";

const SiteEnv = Schema.Struct({
	VITE_SITE_ORIGIN: Schema.optionalKey(Schema.String),
});

export const SITE_ORIGIN: string = Option.match(
	Schema.decodeUnknownOption(SiteEnv)(import.meta.env),
	{
		onNone: () => "",
		onSome: (env) => env.VITE_SITE_ORIGIN ?? "",
	}
);

const pathOf = (
	route: AppRoute,
	written: (slug: string) => boolean
): string | undefined => {
	if (AppRoute.guards.Home(route)) {
		return homeRouter();
	}

	if (AppRoute.guards.Docs(route)) {
		return docsRouter();
	}

	if (AppRoute.guards.Protocol(route)) {
		return protocolRouter();
	}

	if (AppRoute.guards.Acknowledgments(route)) {
		return acknowledgmentsRouter();
	}

	if (AppRoute.guards.Doc(route) && written(route.slug)) {
		return docRouter({ slug: route.slug });
	}

	return undefined;
};

export const canonicalOf = (
	route: AppRoute,
	origin: string,
	written: (slug: string) => boolean
): string | undefined => {
	const path = pathOf(route, written);

	return origin === "" || path === undefined ? undefined : `${origin}${path}`;
};

const ATTRIBUTE_ENTITIES: ReadonlyMap<string, string> = new Map([
	["&", "&amp;"],
	['"', "&quot;"],
	["<", "&lt;"],
	[">", "&gt;"],
]);

const attribute = (text: string): string =>
	text.replaceAll(/[&"<>]/gu, (char) => ATTRIBUTE_ENTITIES.get(char) ?? char);

export const headOf = (title: string, origin: string): string => {
	const shown = attribute(title);
	const image = `${origin}/og.png`;
	const video = `${origin}/og.mp4`;

	return [
		`<meta name="description" content="${SEARCH_ABOUT}" />`,
		`<meta property="og:type" content="website" />`,
		`<meta property="og:site_name" content="supervillain" />`,
		`<meta property="og:title" content="${shown}" />`,
		`<meta property="og:description" content="${SHARE_ABOUT}" />`,
		`<meta property="og:image" content="${image}" />`,
		`<meta property="og:image:type" content="image/png" />`,
		`<meta property="og:image:width" content="1200" />`,
		`<meta property="og:image:height" content="630" />`,
		`<meta property="og:image:alt" content="ssh supervillain.sh" />`,
		`<meta property="og:video" content="${video}" />`,
		`<meta property="og:video:secure_url" content="${video}" />`,
		`<meta property="og:video:type" content="video/mp4" />`,
		`<meta property="og:video:width" content="1200" />`,
		`<meta property="og:video:height" content="630" />`,
		`<meta name="twitter:card" content="summary_large_image" />`,
		`<meta name="twitter:title" content="${shown}" />`,
		`<meta name="twitter:description" content="${SHARE_ABOUT}" />`,
		`<meta name="twitter:image" content="${image}" />`,
		`<meta name="twitter:image:alt" content="ssh supervillain.sh" />`,
		`<meta name="color-scheme" content="dark" />`,
		`<meta name="theme-color" content="#09090b" />`,
		`<link rel="preconnect" href="https://fonts.googleapis.com" />`,
		`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
		`<link rel="stylesheet" href="${FONTS}" />`,
		`<link rel="icon" href="/icon.svg" type="image/svg+xml" />`,
	].join("");
};
