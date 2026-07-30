import { readFileSync } from "node:fs";

import { Resvg } from "@resvg/resvg-js";
import type {
	SnapshotCardV1,
	SnapshotDocument,
	SnapshotDocumentV1,
	SnapshotFieldV1,
	SnapshotMapGridV1,
	SnapshotThemeTokenV1,
} from "@supervillain/core";
import satori from "satori";

import boldFontSource from "./fonts/JetBrainsMono-Bold.ttf?inline";
import regularFontSource from "./fonts/JetBrainsMono-Regular.ttf?inline";

const WIDTH = 1200;
const HEIGHT = 630;
const BACKGROUND = "#0d0d11";
const FOREGROUND = "#e6e6e6";
const BORDER = "#3b3b48";
const FONT_FAMILY = "JetBrains Mono";

const PALETTE: Readonly<Record<SnapshotThemeTokenV1, string>> = {
	accent: "#d99cff",
	danger: "#ff8f94",
	muted: "#a3a3ad",
	primary: "#e6e6e6",
	success: "#8fe0ae",
};

// JetBrains Mono 2.304, JetBrains s.r.o.; OFL-1.1.
// Source: https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/ttf
// Retrieved 2026-07-30. Renderer inputs stay private to the server, not public/.
const fontBytes = (source: string): Buffer => {
	if (!source.startsWith("data:")) {
		return readFileSync(source);
	}
	const encoded = source.slice(source.indexOf(",") + 1);
	return Buffer.from(encoded, "base64");
};

// Vite embeds these server-only assets in the production chunk; Bun resolves
// the same imports to local paths in direct renderer tests.
const REGULAR_FONT = fontBytes(regularFontSource);
const BOLD_FONT = fontBytes(boldFontSource);

interface ElementNode {
	readonly props: {
		readonly children?: ElementChild | readonly ElementChild[];
		readonly style?: Readonly<Record<string, string | number>>;
	};
	readonly type: string;
}
type ElementChild = ElementNode | string;

const element = (
	type: string,
	style: Readonly<Record<string, string | number>>,
	children?: ElementChild | readonly ElementChild[]
): ElementNode => ({ props: { children, style }, type });

const text = (
	value: string,
	style: Readonly<Record<string, string | number>> = {}
): ElementNode => element("div", style, value);

const accentFor = (
	card: SnapshotCardV1,
	fallback: SnapshotThemeTokenV1
): string => PALETTE[card.accentHint ?? fallback];

const fieldNodes = (
	fields: readonly SnapshotFieldV1[],
	accent: string
): readonly ElementNode[] =>
	fields.slice(0, 4).map((field) =>
		element(
			"div",
			{
				borderLeft: `3px solid ${accent}`,
				display: "flex",
				flexDirection: "column",
				paddingLeft: 18,
				width: "24%",
			},
			[
				text(field.label.toUpperCase(), { color: "#a3a3ad", fontSize: 17 }),
				text(field.value, { color: FOREGROUND, fontSize: 25, marginTop: 8 }),
			]
		)
	);

const chrome = (kind: string, accent: string, body: ElementNode): ElementNode =>
	element(
		"div",
		{
			backgroundColor: BACKGROUND,
			color: FOREGROUND,
			display: "flex",
			fontFamily: FONT_FAMILY,
			height: "100%",
			padding: 48,
			width: "100%",
		},
		element(
			"div",
			{
				border: `2px solid ${BORDER}`,
				display: "flex",
				flexDirection: "column",
				height: "100%",
				padding: 38,
				position: "relative",
				width: "100%",
			},
			[
				element("div", {
					backgroundColor: accent,
					height: 8,
					left: 0,
					position: "absolute",
					top: 0,
					width: "100%",
				}),
				element(
					"div",
					{
						alignItems: "center",
						display: "flex",
						justifyContent: "space-between",
					},
					[
						text(`SV://ARTIFACT/${kind.toUpperCase()}`, {
							color: accent,
							fontSize: 19,
							fontWeight: 700,
							letterSpacing: 2,
						}),
						text("supervillain", { color: "#a3a3ad", fontSize: 18 }),
					]
				),
				body,
			]
		)
	);

const characterTemplate = (document: SnapshotDocumentV1): ElementNode => {
	if (document.artifactType !== "character") {
		throw new Error("Character card template received another artifact type");
	}
	const accent = accentFor(document.card, "accent");
	return chrome(
		"character",
		accent,
		element("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
			element("div", { alignItems: "center", display: "flex", flexGrow: 1 }, [
				document.card.glyph === undefined
					? text("//", { color: accent, fontSize: 72, fontWeight: 700 })
					: element(
							"div",
							{
								alignItems: "center",
								backgroundColor: accent,
								color: BACKGROUND,
								display: "flex",
								fontSize: 68,
								fontWeight: 700,
								height: 112,
								justifyContent: "center",
								marginRight: 32,
								width: 112,
							},
							document.card.glyph
						),
				element("div", { display: "flex", flexDirection: "column" }, [
					text(document.card.title, { fontSize: 54, fontWeight: 700 }),
					text(document.card.description, {
						color: "#a3a3ad",
						fontSize: 24,
						marginTop: 12,
					}),
				]),
			]),
			element(
				"div",
				{ display: "flex", gap: 20, justifyContent: "space-between" },
				fieldNodes(document.card.fields, accent)
			),
		])
	);
};

const logTemplate = (document: SnapshotDocumentV1): ElementNode => {
	if (document.artifactType !== "log") {
		throw new Error("Log card template received another artifact type");
	}
	const accent = accentFor(document.card, "success");
	return chrome(
		"log",
		accent,
		element("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
			text(document.card.title, {
				fontSize: 50,
				fontWeight: 700,
				marginTop: 64,
			}),
			text(document.card.description, {
				color: "#a3a3ad",
				fontSize: 23,
				marginTop: 14,
			}),
			element("div", { display: "flex", flexGrow: 1, marginTop: 55 }, [
				text("$ replay --whole-artifact", {
					color: accent,
					fontSize: 23,
					marginRight: 45,
				}),
				element(
					"div",
					{ display: "flex", flexGrow: 1, gap: 20, justifyContent: "flex-end" },
					fieldNodes(document.card.fields, accent)
				),
			]),
		])
	);
};

const mapGrid = (map: SnapshotMapGridV1, accent: string): ElementNode => {
	const width = [...(map.rows[0] ?? "")].length;
	const height = map.rows.length;
	const fontSize = Math.min(42, Math.floor(370 / Math.max(width, height)));
	return element("div", { display: "flex", flexGrow: 1, marginTop: 28 }, [
		text(map.rows.join("\n"), {
			backgroundColor: "#15151c",
			border: `1px solid ${BORDER}`,
			color: accent,
			fontSize,
			lineHeight: 1,
			padding: 24,
			whiteSpace: "pre",
			width: "68%",
		}),
		element(
			"div",
			{ display: "flex", flexDirection: "column", paddingLeft: 34 },
			[
				text(`${width} × ${height}`, {
					color: accent,
					fontSize: 42,
					fontWeight: 700,
				}),
				text("TERRAIN GRID", { color: "#a3a3ad", fontSize: 18, marginTop: 10 }),
				text(map.name, { fontSize: 23, marginTop: 38 }),
			]
		),
	]);
};

const mapTemplate = (document: SnapshotDocumentV1): ElementNode => {
	if (document.artifactType !== "map") {
		throw new Error("Map card template received another artifact type");
	}
	const accent = accentFor(document.card, "danger");
	return chrome(
		"map",
		accent,
		element("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
			text(document.card.title, {
				fontSize: 38,
				fontWeight: 700,
				marginTop: 24,
			}),
			mapGrid(document.map, accent),
		])
	);
};

const unsupportedArtifactType = (_document: never): never => {
	throw new Error("Snapshot document has an unsupported artifact type");
};

const templateFor = (document: SnapshotDocumentV1): ElementNode => {
	switch (document.artifactType) {
		case "character": {
			return characterTemplate(document);
		}
		case "log": {
			return logTemplate(document);
		}
		case "map": {
			return mapTemplate(document);
		}
		default: {
			return unsupportedArtifactType(document);
		}
	}
};

let renderQueue: Promise<void> = Promise.resolve();

const serialized = async <Result>(
	operation: () => Promise<Result>
): Promise<Result> => {
	// The #43 spike measured roughly 150–270 MB RSS high-water per render.
	// Serialize in-process so publish traffic cannot multiply that footprint.
	const preceding = renderQueue;
	let releaseQueue: (() => void) | undefined;
	// oxlint-disable-next-line promise/avoid-new -- the resolver is the mutex handoff signal, not wrapped async work.
	renderQueue = new Promise((resolve) => {
		releaseQueue = resolve;
	});
	await preceding;
	try {
		return await operation();
	} finally {
		releaseQueue?.();
	}
};

/** Renders the game-blind v1 card section (plus only a map document's grid). */
export const renderArtifactCard = (
	document: SnapshotDocument
): Promise<Uint8Array> =>
	serialized(async () => {
		if (document.schemaVersion !== 1) {
			throw new Error(
				`No OG renderer exists for snapshot schema version ${String(document.schemaVersion)}`
			);
		}
		const svg = await satori(
			templateFor(document) as Parameters<typeof satori>[0],
			{
				fonts: [
					{ data: REGULAR_FONT, name: FONT_FAMILY, weight: 400 },
					{ data: BOLD_FONT, name: FONT_FAMILY, weight: 700 },
				],
				height: HEIGHT,
				width: WIDTH,
			}
		);
		return new Resvg(svg, {
			font: { loadSystemFonts: false },
			shapeRendering: 2,
			textRendering: 2,
		})
			.render()
			.asPng();
	});
