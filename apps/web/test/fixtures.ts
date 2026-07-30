import type { SnapshotDocumentV1 } from "@supervillain/core";

export const characterDocument = {
	artifactType: "character",
	card: {
		description: "A sovereign of static",
		fields: [{ label: "Role", value: "Controller" }],
		title: "Doctor Malignant",
	},
	schemaVersion: 1,
	sections: [
		{
			fields: [
				{ label: "Might", value: "4" },
				{ label: "Weakness", value: "Careful planning" },
			],
			title: "Characteristics",
		},
	],
} as const satisfies SnapshotDocumentV1;

export const inlineMap = {
	legend: { "#": "wall", "+": "door", ".": "floor" },
	name: "Clockwork Vault",
	rows: ["##+##", "#...#", "#####"],
	type: "map-grid",
} as const;

export const logDocument = {
	artifactType: "log",
	card: {
		description: "Three days out of order",
		fields: [],
		title: "The impossible heist",
	},
	entries: [
		{
			block: {
				runs: [
					{ attrs: ["bold", "underline"], text: "Alarm", token: "danger" },
					{ text: " disabled", token: "success" },
				],
				type: "text",
			},
			timestamp: "2026-07-21T23:59:59.000Z",
		},
		{
			block: inlineMap,
			timestamp: "2026-07-22T00:00:00.000Z",
		},
		{
			block: {
				runs: [
					{
						attrs: ["dim", "italic", "reverse"],
						text: "Earlier: ",
						token: "muted",
					},
					{ text: "the door opens", token: "accent" },
					{ text: ".", token: "primary" },
				],
				type: "text",
			},
			timestamp: "2026-07-21T12:00:00.000Z",
		},
	] as const,
	schemaVersion: 1,
} as const satisfies SnapshotDocumentV1;

export const mapDocument = {
	artifactType: "map",
	card: {
		description: "Terrain for the final confrontation",
		fields: [],
		title: "Clockwork Vault",
	},
	map: inlineMap,
	schemaVersion: 1,
} as const satisfies SnapshotDocumentV1;
