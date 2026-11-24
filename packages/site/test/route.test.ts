import { describe, expect, test } from "bun:test";

import { Option } from "effect";
import { fromString } from "foldkit/url";

import {
	AppRoute,
	docRouter,
	postRouter,
	urlToAppRoute,
} from "../src/Route.ts";

const routeOf = (path: string) =>
	Option.map(
		fromString(`https://supervillain.example.com${path}`),
		urlToAppRoute
	);

describe("the site's addresses", () => {
	test("are the front page, the docs, a doc, the blog and a post", () => {
		expect(routeOf("/")).toStrictEqual(Option.some(AppRoute.Home()));
		expect(routeOf("/docs")).toStrictEqual(Option.some(AppRoute.Docs()));
		expect(routeOf("/docs/hosting")).toStrictEqual(
			Option.some(AppRoute.Doc({ slug: "hosting" }))
		);
		expect(routeOf("/blog")).toStrictEqual(Option.some(AppRoute.Blog()));
		expect(routeOf("/blog/cloudflare-tcp-vs-vps")).toStrictEqual(
			Option.some(AppRoute.Post({ slug: "cloudflare-tcp-vs-vps" }))
		);
	});

	test("send anything else to not found", () => {
		expect(routeOf("/nowhere/at/all")).toStrictEqual(
			Option.some(AppRoute.NotFound({ path: "/nowhere/at/all" }))
		);
	});

	test("are the same page with a slash at the end", () => {
		expect(routeOf("/blog/")).toStrictEqual(Option.some(AppRoute.Blog()));
		expect(routeOf("/docs/playing/")).toStrictEqual(
			Option.some(AppRoute.Doc({ slug: "playing" }))
		);
	});

	test("are written the way they are read", () => {
		expect(docRouter({ slug: "rulesets" })).toBe("/docs/rulesets");
		expect(postRouter({ slug: "cloudflare-tcp-vs-vps" })).toBe(
			"/blog/cloudflare-tcp-vs-vps"
		);
	});
});
