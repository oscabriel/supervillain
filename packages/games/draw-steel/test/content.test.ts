/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import {
	independenceNotice,
	intake,
	snapshotCharacter,
	template,
	validate,
} from "../src/content.js";

const encode = (value: unknown): Uint8Array =>
	new TextEncoder().encode(JSON.stringify(value));
const valid = () => ({
	abilities: [{ cost: "3 Drama", name: "Encore", text: "Act again." }],
	ancestry: "Human",
	characteristics: {
		agility: 1,
		intuition: -5,
		might: 10,
		presence: 0,
		reason: 2,
	},
	class: "Troubadour",
	heroicResource: "Drama",
	kit: "Prowler",
	name: "Coda",
	recoveries: 8,
	stamina: 20,
	surges: 1,
	unknown: true,
	victories: 2,
});
const firstError = (value: unknown): string => {
	const result = validate(encode(value));
	return result.ok
		? "accepted"
		: (result.errors[0]?.message ?? "missing error");
};

describe("Draw Steel content", () => {
	test("carries the verbatim independence notice and generic intake", () => {
		expect(independenceNotice).toBe(
			"supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026 MCDM Productions, LLC."
		);
		expect(intake.directory).toBe("characters");
		expect(intake.command("coda.json", "{}")).toEqual({
			fileName: "coda.json",
			text: "{}",
			type: "ds.load-character",
		});
	});

	test("provides a valid, verbatim-named character template", () => {
		const text = template("Coda");
		expect(validate(new TextEncoder().encode(text))).toEqual({ ok: true });
		expect(JSON.parse(text).name).toBe("Coda");
		expect(text.endsWith("\n")).toBe(true);
	});

	test("nominates strings-only character sections and card content", () => {
		const snapshot = snapshotCharacter(encode(valid()));
		expect(snapshot.card).toMatchObject({
			description: "Human Troubadour",
			glyph: "◆",
			title: "Coda",
		});
		expect(snapshot.sections).toContainEqual({
			fields: [
				{ label: "Might", value: "+10" },
				{ label: "Agility", value: "+1" },
				{ label: "Reason", value: "+2" },
				{ label: "Intuition", value: "−5" },
				{ label: "Presence", value: "+0" },
			],
			title: "Characteristics",
		});
	});

	test("accepts the full schema, omitted optionals, and unknown top-level fields", () => {
		expect(validate(encode(valid()))).toEqual({ ok: true });
		const {
			abilities: _,
			kit: _kit,
			surges: _surges,
			victories: _victories,
			...minimal
		} = valid();
		expect(validate(encode(minimal))).toEqual({ ok: true });
	});

	test("rejects malformed top-level, names, and characteristics fields", () => {
		expect(firstError([])).toBe("Character file must be an object.");
		for (const field of [
			"name",
			"ancestry",
			"class",
			"heroicResource",
		] as const) {
			expect(firstError({ ...valid(), [field]: " " })).toBe(
				`Field '${field}' must be a non-empty string of at most 60 characters.`
			);
			expect(firstError({ ...valid(), [field]: "x".repeat(61) })).toContain(
				`Field '${field}'`
			);
		}
		expect(firstError({ ...valid(), kit: "" })).toContain("Field 'kit'");
		expect(firstError({ ...valid(), characteristics: [] })).toBe(
			"Field 'characteristics' must be an object."
		);
		for (const [field, value] of [
			["might", 11],
			["agility", -6],
			["reason", 1.5],
		] as const) {
			const candidate = valid();
			candidate.characteristics[field] = value;
			expect(firstError(candidate)).toContain(`characteristics.${field}`);
		}
		const missing = valid() as ReturnType<typeof valid> & {
			characteristics: Partial<ReturnType<typeof valid>["characteristics"]>;
		};
		delete missing.characteristics.presence;
		expect(firstError(missing)).toContain("characteristics.presence");
		const extra = valid() as ReturnType<typeof valid> & {
			characteristics: ReturnType<typeof valid>["characteristics"] & {
				speed?: number;
			};
		};
		extra.characteristics.speed = 1;
		expect(firstError(extra)).toBe(
			"Field 'characteristics.speed' is not one of the five characteristics."
		);
	});

	test("rejects invalid required and optional counters", () => {
		for (const stamina of [undefined, 0, 1.5]) {
			expect(firstError({ ...valid(), stamina })).toBe(
				"Field 'stamina' must be a positive integer."
			);
		}
		for (const field of ["recoveries", "surges", "victories"] as const) {
			for (const value of [-1, 1.5]) {
				expect(firstError({ ...valid(), [field]: value })).toBe(
					`Field '${field}' must be a non-negative integer.`
				);
			}
		}
		expect(firstError({ ...valid(), recoveries: undefined })).toContain(
			"recoveries"
		);
	});

	test("returns exact indexed ability field errors", () => {
		expect(firstError({ ...valid(), abilities: "Encore" })).toBe(
			"Field 'abilities' must be an array of at most 30 entries."
		);
		expect(
			firstError({ ...valid(), abilities: Array.from({ length: 31 }) })
		).toBe("Field 'abilities' must be an array of at most 30 entries.");
		expect(
			firstError({ ...valid(), abilities: [valid().abilities[0], null] })
		).toBe("Field 'abilities[1]' must be an object.");
		for (const [field, value, maximum] of [
			["name", "", 60],
			["text", "x".repeat(2001), 2000],
			["cost", " ", 60],
		] as const) {
			const ability = { ...valid().abilities[0], [field]: value };
			expect(
				firstError({
					...valid(),
					abilities: [valid().abilities[0], valid().abilities[0], ability],
				})
			).toBe(
				`Field 'abilities[2].${field}' must be a non-empty string of at most ${maximum} characters.`
			);
		}
	});
});
