/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import { independenceNotice, intake, validate } from "../src/content.js";

const encode = (value: unknown): Uint8Array =>
	new TextEncoder().encode(JSON.stringify(value));
const valid = () => ({
	characteristics: {
		agility: 1,
		intuition: -5,
		might: 10,
		presence: 0,
		reason: 2,
	},
	name: "Coda",
	stamina: 20,
	unknown: true,
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

	test("accepts exactly five bounded integer characteristics and optional stamina", () => {
		expect(validate(encode(valid()))).toEqual({ ok: true });
		const withoutStamina = valid();
		delete (withoutStamina as { stamina?: number }).stamina;
		expect(validate(encode(withoutStamina))).toEqual({ ok: true });
	});

	test("rejects malformed top-level, name, and characteristics fields", () => {
		expect(firstError([])).toContain("object");
		expect(firstError({ ...valid(), name: " " })).toContain("name");
		expect(firstError({ ...valid(), name: "x".repeat(61) })).toContain("name");
		expect(firstError({ ...valid(), characteristics: [] })).toContain(
			"characteristics"
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
	});

	test("rejects missing, extra, and invalid stamina fields", () => {
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
		expect(firstError(extra)).toContain("characteristics.speed");
		expect(firstError({ ...valid(), stamina: 0 })).toContain("stamina");
		expect(firstError({ ...valid(), stamina: 1.5 })).toContain("stamina");
	});
});
