import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { canonicalOf, headOf, SEARCH_ABOUT, SHARE_ABOUT } from "../src/Meta.ts";
import { AppRoute } from "../src/Route.ts";

const ORIGIN = "https://supervillain.example.com";

const written = (slug: string): boolean => slug === "playing";

describe("the page's share metadata", () => {
	test("names every page for a share card and stays short enough to show whole", () => {
		const head = headOf("Guide · supervillain", ORIGIN);

		expect(head).toContain(
			'<meta property="og:title" content="Guide · supervillain" />'
		);
		expect(head).toContain(
			'<meta name="twitter:title" content="Guide · supervillain" />'
		);
		expect(head).toContain(
			`<meta property="og:description" content="${SHARE_ABOUT}" />`
		);
		expect(head).toContain(
			`<meta name="description" content="${SEARCH_ABOUT}" />`
		);
		expect(SHARE_ABOUT.length).toBeLessThanOrEqual(125);
		expect(SEARCH_ABOUT.length).toBeLessThanOrEqual(155);
		expect(head).not.toContain("—");
	});

	test("offers the still image and the ripple video from the site's own origin", () => {
		const head = headOf("supervillain", ORIGIN);

		expect(head).toContain(
			`<meta property="og:image" content="${ORIGIN}/og.png" />`
		);
		expect(head).toContain(
			`<meta property="og:video" content="${ORIGIN}/og.mp4" />`
		);
		expect(head).toContain(
			'<meta property="og:video:type" content="video/mp4" />'
		);
		expect(head).toContain(
			'<meta name="twitter:card" content="summary_large_image" />'
		);
		expect(existsSync(`${import.meta.dirname}/../public/og.png`)).toBe(true);
		expect(existsSync(`${import.meta.dirname}/../public/og.mp4`)).toBe(true);
	});

	test("escapes a title before it lands in an attribute", () => {
		expect(headOf('a "b" & <c>', ORIGIN)).toContain(
			'content="a &quot;b&quot; &amp; &lt;c&gt;"'
		);
	});

	test("gives each real page one canonical address and a missing page none", () => {
		expect(canonicalOf(AppRoute.Home(), ORIGIN, written)).toBe(`${ORIGIN}/`);
		expect(canonicalOf(AppRoute.Docs(), ORIGIN, written)).toBe(
			`${ORIGIN}/guide`
		);
		expect(canonicalOf(AppRoute.Protocol(), ORIGIN, written)).toBe(
			`${ORIGIN}/guide/protocol`
		);
		expect(
			canonicalOf(AppRoute.Doc({ slug: "playing" }), ORIGIN, written)
		).toBe(`${ORIGIN}/guide/playing`);
		expect(canonicalOf(AppRoute.Acknowledgments(), ORIGIN, written)).toBe(
			`${ORIGIN}/acknowledgments`
		);
		expect(
			canonicalOf(AppRoute.Doc({ slug: "no-such-page" }), ORIGIN, written)
		).toBeUndefined();
		expect(
			canonicalOf(AppRoute.NotFound({ path: "/nowhere" }), ORIGIN, written)
		).toBeUndefined();
		expect(canonicalOf(AppRoute.Home(), "", written)).toBeUndefined();
	});
});
