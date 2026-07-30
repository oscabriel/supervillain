/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; apps/web ships as nitro's bun preset (ADR-0020). */
import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { SnapshotDocumentRenderer } from "../src/artifact/document";
import { characterDocument, logDocument, mapDocument } from "./fixtures";

const render = (
	document: typeof characterDocument | typeof logDocument | typeof mapDocument
): string =>
	renderToStaticMarkup(<SnapshotDocumentRenderer document={document} />);

describe("the versioned snapshot document renderer", () => {
	test("SSRs semantic character sections and fields", () => {
		const html = render(characterDocument);

		expect(html).toContain("<h1>Doctor Malignant</h1>");
		expect(html).toContain("<h2>Characteristics</h2>");
		expect(html).toContain("<dt>Might</dt>");
		expect(html).toContain("<dd>4</dd>");
	});

	test("SSRs a map artifact as selectable terrain text", () => {
		const html = render(mapDocument);

		expect(html).toContain("<h1>Clockwork Vault</h1>");
		expect(html).toContain('class="map-grid"');
		expect(html).toContain("##+##");
		expect(html).not.toContain("token");
	});

	test("maps every v1 FeedLine theme token and text attribute to classes", () => {
		const html = render(logDocument);

		for (const token of ["accent", "danger", "muted", "primary", "success"]) {
			expect(html).toContain(`theme-${token}`);
		}
		for (const attribute of ["bold", "dim", "italic", "reverse", "underline"]) {
			expect(html).toContain(`text-${attribute}`);
		}
	});

	test("emits UTC day breaks in document order with repeated-date suffixes", () => {
		const html = render(logDocument);
		const first = html.indexOf('id="2026-07-21"');
		const second = html.indexOf('id="2026-07-22"');
		const repeated = html.indexOf('id="2026-07-21-2"');

		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		expect(repeated).toBeGreaterThan(second);
	});

	test("renders inline map-grid blocks as collapsed semantic details", () => {
		const html = render(logDocument);

		expect(html).toContain("<details>");
		expect(html).not.toContain("<details open");
		expect(html).toContain("<summary>Clockwork Vault</summary>");
		expect(html).toContain("#...#");
	});
});
