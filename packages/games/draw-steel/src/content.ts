import type { DsCharacteristic, DsCommand } from "./model.js";

export const independenceNotice =
	"supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026 MCDM Productions, LLC.";

export const terminology = {
	characteristics: {
		agility: "Agility",
		intuition: "Intuition",
		might: "Might",
		presence: "Presence",
		reason: "Reason",
	},
	panelTitle: "Initiative",
	sides: { enemies: "Enemies", heroes: "Heroes" },
	tiers: { 1: "tier 1", 2: "tier 2", 3: "tier 3" },
} as const;

const CHARACTERISTICS: readonly DsCharacteristic[] = [
	"might",
	"agility",
	"reason",
	"intuition",
	"presence",
];

const issue = (message: string) =>
	({ errors: [{ message }], ok: false }) as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const validate = (bytes: Uint8Array) => {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return issue("Character file must contain valid UTF-8 JSON.");
	}
	if (!isRecord(value)) {
		return issue("Character file must be an object.");
	}
	if (
		typeof value.name !== "string" ||
		value.name.trim().length === 0 ||
		value.name.length > 60
	) {
		return issue(
			"Field 'name' must be a non-empty string of at most 60 characters."
		);
	}
	if (!isRecord(value.characteristics)) {
		return issue("Field 'characteristics' must be an object.");
	}
	const keys = Object.keys(value.characteristics);
	for (const characteristic of CHARACTERISTICS) {
		const score = value.characteristics[characteristic];
		if (!Number.isInteger(score) || Number(score) < -5 || Number(score) > 10) {
			return issue(
				`Field 'characteristics.${characteristic}' must be an integer from -5 to 10.`
			);
		}
	}
	const unknownCharacteristic = keys.find(
		(key) => !CHARACTERISTICS.includes(key as DsCharacteristic)
	);
	if (keys.length !== CHARACTERISTICS.length || unknownCharacteristic) {
		return issue(
			`Field 'characteristics.${unknownCharacteristic ?? "keys"}' is not one of the five characteristics.`
		);
	}
	if (
		value.stamina !== undefined &&
		(!Number.isInteger(value.stamina) || Number(value.stamina) <= 0)
	) {
		return issue("Field 'stamina' must be a positive integer.");
	}
	return { ok: true } as const;
};

export const intake = {
	command: (fileName: string, text: string): DsCommand => ({
		fileName,
		text,
		type: "ds.load-character",
	}),
	directory: "characters",
} as const;

export const content = { validate };
