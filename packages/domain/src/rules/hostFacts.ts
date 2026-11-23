import type { MapGeneration, MapGrid } from "./board/grid.ts";
import type { HeroSheet, StatBlock } from "./drawSteel/sheets.ts";
import type { PfSheet } from "./pf2e/sheets.ts";
import type { SetCharacter } from "./setWorld/state.ts";

export type HostNeed =
	| { readonly kind: "hero"; readonly id: string }
	| { readonly kind: "monster"; readonly id: string }
	| { readonly kind: "pf-hero"; readonly id: string }
	| { readonly kind: "pf-monster"; readonly id: string }
	| { readonly kind: "player"; readonly label: string }
	| { readonly kind: "seated" }
	| { readonly kind: "map"; readonly id: string }
	| { readonly kind: "generate"; readonly generation: MapGeneration }
	| { readonly kind: "character"; readonly seed?: number };

export type HostFact =
	| { readonly kind: "hero"; readonly sheet: HeroSheet }
	| { readonly kind: "monster"; readonly sheet: StatBlock }
	| { readonly kind: "pf-hero"; readonly sheet: PfSheet }
	| { readonly kind: "pf-monster"; readonly sheet: PfSheet }
	| { readonly kind: "player"; readonly actor: string }
	| { readonly kind: "seated"; readonly seated: ReadonlyArray<string> }
	| { readonly kind: "map"; readonly id: string; readonly grid: MapGrid }
	| { readonly kind: "generated"; readonly id: string }
	| { readonly kind: "character"; readonly character: SetCharacter };
