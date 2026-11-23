import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import type { Dice } from "./rules/engine.ts";

export const Seed = Schema.Struct({ seed: Schema.Int });

export type Seed = typeof Seed.Type;

export class Entropy extends Domain.RequestContext<Entropy>()(
	"Supervillain/Entropy",
	Seed
) {}

const M1 = 2_147_483_563;

const A1 = 40_014;

const M2 = 2_147_483_399;

const A2 = 40_692;

const MASK_64 = 18_446_744_073_709_551_616n;

const SHIFT_30 = 1_073_741_824n;

const SHIFT_27 = 134_217_728n;

const SHIFT_31 = 2_147_483_648n;

const modulo = (n: number, m: number): number => ((n % m) + m) % m;

const mix64 = (value: bigint): bigint => {
	let z = (value + 0x9e_37_79_b9_7f_4a_7c_15n) % MASK_64;

	if (z < 0n) {
		z += MASK_64;
	}

	z = ((z + z / SHIFT_30) * 0xbf_58_47_6d_1c_e4_e5_b9n) % MASK_64;
	z = ((z + z / SHIFT_27) * 0x94_d0_49_bb_13_31_11_ebn) % MASK_64;

	return (z + z / SHIFT_31) % MASK_64;
};

export const diceOf = (seed: number): Dice => {
	const raw = BigInt(Math.trunc(seed));
	const h1 = mix64(raw);
	const h2 = mix64(h1);
	let s1 = Number(h1 % BigInt(M1 - 1)) + 1;
	let s2 = Number(h2 % BigInt(M2 - 1)) + 1;

	const draw = (): number => {
		s1 = (A1 * s1) % M1;
		s2 = (A2 * s2) % M2;

		const z = modulo(s1 - s2, M1 - 1);

		return z / (M1 - 1);
	};

	return (sides) => 1 + Math.floor(draw() * sides);
};
