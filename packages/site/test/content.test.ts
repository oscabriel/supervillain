import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { parseMarkdownWithFrontmatter } from "@foldkit/markdown/vite";
import { Option } from "effect";

import { Frontmatter } from "../src/Frontmatter.ts";
import { slugOf } from "../src/Pages.ts";
import { anchorsOf, proseView } from "../src/Prose.ts";
import { htmlOf } from "./render.ts";

const CONTENT = `${import.meta.dirname}/../content`;

const written = (folder: string) =>
	readdirSync(`${CONTENT}/${folder}`)
		.toSorted()
		.map((file) => {
			const source = readFileSync(`${CONTENT}/${folder}/${file}`, "utf-8");

			return {
				slug: slugOf(file),
				source,
				parsed: parseMarkdownWithFrontmatter(source, {
					frontmatter: Frontmatter,
				}),
			};
		});

const docs = written("docs");

const paths = new Set([
	"/",
	"/docs",
	"/acknowledgments",
	"/install",
	...docs.map(({ slug }) => `/docs/${slug}`),
]);

const linksIn = (source: string): Array<string> =>
	[...source.matchAll(/\]\((?<path>\/[^)#]*)/gu)].map(
		(found) => found.groups?.path ?? ""
	);

const fieldOf = (page: (typeof docs)[number], field: string): string =>
	Option.match(page.parsed.maybeFrontmatter, {
		onNone: () => "",
		onSome: (fields) => fields[field] ?? "",
	});

describe("the site's pages", () => {
	test("are the five docs the site promises", () => {
		expect(docs.map(({ slug }) => slug)).toStrictEqual([
			"agents",
			"architecture",
			"hosting",
			"playing",
			"rulesets",
		]);
	});

	test("each say what they are, in words the build accepts", () => {
		for (const page of docs) {
			expect(fieldOf(page, "title")).not.toBe("");
			expect(fieldOf(page, "summary")).not.toBe("");
		}
	});

	test("give every doc its own place in the list", () => {
		const orders = docs.map((page) => fieldOf(page, "order"));

		expect(new Set(orders).size).toBe(docs.length);
		expect(orders.every((order) => /^\d+$/u.test(order))).toBeTruthy();
	});

	test("link only to pages that exist", () => {
		const broken = docs.flatMap(({ slug, source }) =>
			linksIn(source).flatMap((path) =>
				paths.has(path) ? [] : [`${slug}: ${path}`]
			)
		);

		expect(broken).toStrictEqual([]);
	});

	test("are written without a dash for a pause", () => {
		const dashed = docs.flatMap(({ slug, source }) =>
			source.includes("—") ? [slug] : []
		);

		expect(dashed).toStrictEqual([]);
	});

	test("render to HTML with an anchor for each section", async () => {
		const rendered = await Promise.all(
			docs.map(async (page) => ({
				anchors: anchorsOf(page.parsed.document),
				html: await htmlOf((_model, h) => proseView(page.parsed.document, h)),
			}))
		);

		for (const { anchors, html } of rendered) {
			for (const anchor of anchors) {
				expect(html).toContain(`id="${anchor.id}"`);
			}

			expect(html).toContain('class="prose"');
		}
	});
});

describe("a page's address", () => {
	test("is its file name without any leading order prefix", () => {
		expect(slugOf("../content/docs/01-playing.md")).toBe("playing");
		expect(slugOf("../content/docs/hosting.md")).toBe("hosting");
	});
});
