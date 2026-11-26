import { describe, expect, test } from "bun:test";

import { Option } from "effect";
import { fromString } from "foldkit/url";

import { acknowledgmentsView } from "../src/Acknowledgments.ts";
import { pageView } from "../src/Layout.ts";
import {
	acknowledgmentsRouter,
	AppRoute,
	docRouter,
	urlToAppRoute,
} from "../src/Route.ts";
import { htmlOf } from "./render.ts";

const routeOf = (path: string) =>
	Option.map(
		fromString(`https://supervillain.example.com${path}`),
		urlToAppRoute
	);

describe("the site's addresses", () => {
	test("are the front page, the docs, a doc, and acknowledgments", () => {
		expect(routeOf("/")).toStrictEqual(Option.some(AppRoute.Home()));
		expect(routeOf("/docs")).toStrictEqual(Option.some(AppRoute.Docs()));
		expect(routeOf("/docs/hosting")).toStrictEqual(
			Option.some(AppRoute.Doc({ slug: "hosting" }))
		);
		expect(routeOf("/acknowledgments")).toStrictEqual(
			Option.some(AppRoute.Acknowledgments())
		);
	});

	test("send anything else to not found", () => {
		expect(routeOf("/nowhere/at/all")).toStrictEqual(
			Option.some(AppRoute.NotFound({ path: "/nowhere/at/all" }))
		);
		expect(routeOf("/blog")).toStrictEqual(
			Option.some(AppRoute.NotFound({ path: "/blog" }))
		);
	});

	test("are the same page with a slash at the end", () => {
		expect(routeOf("/acknowledgments/")).toStrictEqual(
			Option.some(AppRoute.Acknowledgments())
		);
		expect(routeOf("/docs/playing/")).toStrictEqual(
			Option.some(AppRoute.Doc({ slug: "playing" }))
		);
	});

	test("are written the way they are read", () => {
		expect(docRouter({ slug: "rulesets" })).toBe("/docs/rulesets");
		expect(acknowledgmentsRouter()).toBe("/acknowledgments");
	});
});

describe("the layout and acknowledgments", () => {
	test("uses the favicon SVG in the header, omits the blog, and links acknowledgments from the footer", async () => {
		const html = await htmlOf((model, h) => pageView(model.route, h, []));

		expect(html).toContain('class="g-brand"');
		expect(html).toContain('src="/icon.svg"');
		expect(html).toContain('alt="supervillain"');
		expect(html).not.toContain("/blog");
		expect(html).not.toContain("MIT License");
		expect(html).not.toContain("DRAW STEEL Creator License");
		expect(html).toContain('href="/acknowledgments"');
		expect(html).toContain("Acknowledgments");
	});

	test("credits Michael Micasso for MEKMODE dings and includes license notices on the acknowledgments page", async () => {
		const html = await htmlOf((_model, h) =>
			pageView(AppRoute.Acknowledgments(), h, acknowledgmentsView(h))
		);

		expect(html).toContain("Michael Micasso");
		expect(html).toContain("https://mektxt.com/fonts/mekmode");
		expect(html).toContain("DRAW STEEL Creator License");
		expect(html).toContain("Open RPG Creative (ORC) License");
		expect(html).not.toContain("Pathfinder");
		expect(html).not.toContain("—");
	});
});
