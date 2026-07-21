import { isRecord } from "./model.js";
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

const isBoundedString = (value: unknown, maximumLength: number): boolean =>
	typeof value === "string" &&
	value.trim().length > 0 &&
	value.length <= maximumLength;

type ValidationIssue = ReturnType<typeof issue>;

const validateNames = (
	value: Readonly<Record<string, unknown>>
): ValidationIssue | undefined => {
	for (const field of ["name", "ancestry", "class"] as const) {
		if (!isBoundedString(value[field], 60)) {
			return issue(
				`Field '${field}' must be a non-empty string of at most 60 characters.`
			);
		}
	}
	if (value.kit !== undefined && !isBoundedString(value.kit, 60)) {
		return issue(
			"Field 'kit' must be a non-empty string of at most 60 characters."
		);
	}
	return undefined;
};

const validateCharacteristics = (
	value: Readonly<Record<string, unknown>>
): ValidationIssue | undefined => {
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
	return undefined;
};

const validateResources = (
	value: Readonly<Record<string, unknown>>
): ValidationIssue | undefined => {
	if (!Number.isInteger(value.stamina) || Number(value.stamina) <= 0) {
		return issue("Field 'stamina' must be a positive integer.");
	}
	if (!Number.isInteger(value.recoveries) || Number(value.recoveries) < 0) {
		return issue("Field 'recoveries' must be a non-negative integer.");
	}
	if (!isBoundedString(value.heroicResource, 60)) {
		return issue(
			"Field 'heroicResource' must be a non-empty string of at most 60 characters."
		);
	}
	for (const field of ["surges", "victories"] as const) {
		if (
			value[field] !== undefined &&
			(!Number.isInteger(value[field]) || Number(value[field]) < 0)
		) {
			return issue(`Field '${field}' must be a non-negative integer.`);
		}
	}
	return undefined;
};

const validateAbilities = (
	value: Readonly<Record<string, unknown>>
): ValidationIssue | undefined => {
	if (value.abilities === undefined) {
		return undefined;
	}
	if (!Array.isArray(value.abilities) || value.abilities.length > 30) {
		return issue("Field 'abilities' must be an array of at most 30 entries.");
	}
	for (const [index, ability] of value.abilities.entries()) {
		if (!isRecord(ability)) {
			return issue(`Field 'abilities[${index}]' must be an object.`);
		}
		for (const [field, maximumLength] of [
			["name", 60],
			["text", 2000],
		] as const) {
			if (!isBoundedString(ability[field], maximumLength)) {
				return issue(
					`Field 'abilities[${index}].${field}' must be a non-empty string of at most ${maximumLength} characters.`
				);
			}
		}
		if (ability.cost !== undefined && !isBoundedString(ability.cost, 60)) {
			return issue(
				`Field 'abilities[${index}].cost' must be a non-empty string of at most 60 characters.`
			);
		}
	}
	return undefined;
};

export const template = (name: string): string =>
	`${JSON.stringify(
		{
			abilities: [],
			ancestry: "Human",
			characteristics: {
				agility: 1,
				intuition: 0,
				might: 2,
				presence: 0,
				reason: 1,
			},
			class: "Tactician",
			heroicResource: "Focus",
			kit: "Sword and Board",
			name,
			recoveries: 8,
			stamina: 21,
			surges: 0,
			victories: 0,
		},
		null,
		"\t"
	)}\n`;

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
	return (
		validateNames(value) ??
		validateCharacteristics(value) ??
		validateResources(value) ??
		validateAbilities(value) ??
		({ ok: true } as const)
	);
};

export const intake = {
	command: (fileName: string, text: string): DsCommand => ({
		fileName,
		text,
		type: "ds.load-character",
	}),
	directory: "characters",
} as const;

export const content = { template, validate };
