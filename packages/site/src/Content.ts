import { inOrder, pageOf } from "./Pages.ts";
import type { Page, Written } from "./Pages.ts";
import { docRouter } from "./Route.ts";

const pagesIn = (written: Record<string, Written>): Array<Page> =>
	Object.entries(written).map(([path, file]) => pageOf(path, file));

export const DOCS = inOrder(
	pagesIn(import.meta.glob<Written>("../content/docs/*.md", { eager: true }))
);

export const docOf = (slug: string): Page | undefined =>
	DOCS.find((page) => page.slug === slug);

export const docHref = (page: Page): string => docRouter({ slug: page.slug });
