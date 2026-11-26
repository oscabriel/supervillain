export interface PartyHealth {
	readonly label: string;
	readonly value: number;
	readonly max: number;
}

export interface PartyMember {
	readonly id: string;
	readonly name: string;
	readonly player?: string;
	readonly mine: boolean;
	readonly free: boolean;
	readonly down: boolean;
	readonly health?: PartyHealth;
	readonly summary: string;
	readonly tags: ReadonlyArray<string>;
}

export interface EncounterSpec {
	readonly map?: string;
	readonly monsters: ReadonlyArray<{
		readonly id: string;
		readonly count?: number;
	}>;
}

export const playerOf = (
	player: string | undefined,
	actor: string,
	label: (actor: string) => string
): { readonly player?: string } =>
	player === undefined || player === actor ? {} : { player: label(player) };
