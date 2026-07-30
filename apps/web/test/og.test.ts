/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the renderer's native resvg dependency runs under Bun. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SnapshotDocument } from "@supervillain/core";

import { renderArtifactCard } from "../src/server/og";
import { characterDocument, logDocument, mapDocument } from "./fixtures";

const pngDimensions = (png: Uint8Array) => ({
	height: Buffer.from(png).readUInt32BE(20),
	width: Buffer.from(png).readUInt32BE(16),
});

const renderInChild = async (document: SnapshotDocument): Promise<Buffer> => {
	const root = await mkdtemp(path.join(tmpdir(), "supervillain-og-child-"));
	try {
		const input = path.join(root, "snapshot.json");
		await writeFile(input, JSON.stringify(document));
		const child = Bun.spawn(
			["bun", path.join(import.meta.dir, "og-render-child.ts"), input],
			{
				stderr: "pipe",
				stdout: "pipe",
			}
		);
		const bytes = Buffer.from(await new Response(child.stdout).arrayBuffer());
		if ((await child.exited) !== 0) {
			throw new Error(await new Response(child.stderr).text());
		}
		return bytes;
	} finally {
		await rm(root, { force: true, recursive: true });
	}
};

describe("publish-time OG card rendering", () => {
	test("dispatches all artifact types to distinct 1200 by 630 PNG templates", async () => {
		const cards = await Promise.all([
			renderArtifactCard(characterDocument),
			renderArtifactCard(logDocument),
			renderArtifactCard(mapDocument),
		]);

		for (const card of cards) {
			expect(pngDimensions(card)).toEqual({ height: 630, width: 1200 });
			expect(card.byteLength).toBeGreaterThan(10_000);
			expect(card.byteLength).toBeLessThan(250_000);
		}
		expect(Buffer.from(cards[0]).equals(cards[1] ?? new Uint8Array())).toBe(
			false
		);
		expect(Buffer.from(cards[1]).equals(cards[2] ?? new Uint8Array())).toBe(
			false
		);
	});

	test("is byte-identical across separate process invocations", async () => {
		const first = await renderInChild(characterDocument);
		const second = await renderInChild(characterDocument);

		expect(first.equals(second)).toBe(true);
	});
});
