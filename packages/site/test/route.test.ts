import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { Option } from "effect";
import { fromString } from "foldkit/url";

import { acknowledgmentsView } from "../src/Acknowledgments.ts";
import { pageView } from "../src/Layout.ts";
import {
	acknowledgmentsRouter,
	AppRoute,
	docRouter,
	protocolRouter,
	urlToAppRoute,
} from "../src/Route.ts";
import { htmlOf } from "./render.ts";

const routeOf = (path: string) =>
	Option.map(
		fromString(`https://supervillain.example.com${path}`),
		urlToAppRoute
	);

describe("the site's addresses", () => {
	test("are the front page, the guide, protocol reference, a guide page, and acknowledgments", () => {
		expect(routeOf("/")).toStrictEqual(Option.some(AppRoute.Home()));
		expect(routeOf("/guide")).toStrictEqual(Option.some(AppRoute.Docs()));
		expect(routeOf("/guide/protocol")).toStrictEqual(
			Option.some(AppRoute.Protocol())
		);
		expect(routeOf("/guide/protocol/")).toStrictEqual(
			Option.some(AppRoute.Protocol())
		);
		expect(routeOf("/guide/hosting")).toStrictEqual(
			Option.some(AppRoute.Doc({ slug: "hosting" }))
		);
		expect(routeOf("/acknowledgments")).toStrictEqual(
			Option.some(AppRoute.Acknowledgments())
		);
		expect(protocolRouter()).toBe("/guide/protocol");
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
		expect(routeOf("/guide/playing/")).toStrictEqual(
			Option.some(AppRoute.Doc({ slug: "playing" }))
		);
	});

	test("are written the way they are read", () => {
		expect(docRouter({ slug: "rulesets" })).toBe("/guide/rulesets");
		expect(acknowledgmentsRouter()).toBe("/acknowledgments");
	});
});

describe("the layout and acknowledgments", () => {
	test("uses the favicon SVG in the header, omits the blog, and links acknowledgments from the footer", async () => {
		const html = await htmlOf((model, h) => pageView(model.route, h, []));

		expect(html).toContain('class="g-brand"');
		expect(html).toContain('src="/icon.svg"');
		expect(html).toContain('alt="supervillain"');
		expect(html).toContain(">Guide<");
		expect(html).toContain(">Source<");
		expect(html).not.toContain("Host a table");
		expect(html).not.toContain('class="g-pill"');
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

	test("ships the 1200x630 hero og.png asset", () => {
		expect(existsSync(`${import.meta.dirname}/../public/og.png`)).toBe(true);
	});
});
