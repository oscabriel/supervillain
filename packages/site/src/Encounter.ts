export interface Square {
	readonly x: number;
	readonly y: number;
}

export type Side = "heroes" | "director";

export type Tiers = readonly [number, number, number];

export interface Ability {
	readonly name: string;
	readonly distance: string;
	readonly reach: number;
	readonly letter: string;
	readonly characteristic: number;
	readonly cost: number;
	readonly base: Tiers;
	readonly push: Tiers;
	readonly type: string;
	readonly rider: string;
}

export interface Fighter {
	readonly id: string;
	readonly name: string;
	readonly mark: string;
	readonly side: Side;
	readonly kind: string;
	readonly level: number;
	readonly minion: boolean;
	readonly stamina: number;
	readonly speed: number;
	readonly stability: number;
	readonly start: Square;
	readonly abilities: ReadonlyArray<Ability>;
}

export const MAP_ID = "ford-road";

export const MAP_NAME = "The Ford Road";

export const TERRAIN: ReadonlyArray<string> = [
	"..............",
	".##.......~~..",
	".#........~~..",
	"..........~~..",
	"..........~~.#",
	"....~.....~~.#",
	"..............",
];

export const HERO = "brann";

export const BRANN: Fighter = {
	id: HERO,
	name: "Brann",
	mark: "B",
	side: "heroes",
	kind: "Censor, level 1 · might 2 · presence 2",
	level: 1,
	minion: false,
	stamina: 24,
	speed: 5,
	stability: 1,
	start: { x: 1, y: 3 },
	abilities: [
		{
			name: "Driving Blow",
			distance: "Melee 1",
			reach: 1,
			letter: "M",
			characteristic: 2,
			cost: 0,
			base: [3, 5, 8],
			push: [0, 1, 2],
			type: "",
			rider: "",
		},
		{
			name: "Accusing Glare",
			distance: "Ranged 10",
			reach: 10,
			letter: "P",
			characteristic: 2,
			cost: 3,
			base: [3, 5, 8],
			push: [0, 0, 0],
			type: "holy",
			rider: "taunted (EoT)",
		},
	],
};

export const BRUISER: Fighter = {
	id: "bandit-bruiser",
	name: "Bandit Bruiser",
	mark: "b",
	side: "director",
	kind: "Brute, level 1 platoon",
	level: 1,
	minion: false,
	stamina: 20,
	speed: 5,
	stability: 1,
	start: { x: 7, y: 3 },
	abilities: [
		{
			name: "Cudgel",
			distance: "Melee 1",
			reach: 1,
			letter: "",
			characteristic: 2,
			cost: 0,
			base: [4, 6, 7],
			push: [0, 1, 2],
			type: "",
			rider: "",
		},
	],
};

export const SLINGER: Fighter = {
	id: "bandit-slinger",
	name: "Bandit Slinger",
	mark: "s",
	side: "director",
	kind: "Artillery, level 1 minion",
	level: 1,
	minion: true,
	stamina: 3,
	speed: 5,
	stability: 0,
	start: { x: 12, y: 2 },
	abilities: [
		{
			name: "Sling Stone",
			distance: "Ranged 10",
			reach: 10,
			letter: "",
			characteristic: 2,
			cost: 0,
			base: [2, 4, 5],
			push: [0, 0, 0],
			type: "",
			rider: "",
		},
	],
};

export const FIGHTERS: ReadonlyArray<Fighter> = [BRANN, BRUISER, SLINGER];

export const RECOVERIES = 12;

export const RECOVERY_VALUE = 8;

export const WRATH_PER_TURN = 2;

export const COLUMNS = TERRAIN[0]?.length ?? 0;

export const ROWS = TERRAIN.length;

export const fighterOf = (id: string): Fighter =>
	FIGHTERS.find((fighter) => fighter.id === id) ?? BRANN;

export const damageOf = (ability: Ability, tier: number): number =>
	(ability.base[tier - 1] ?? 0) +
	(ability.letter === "" ? 0 : ability.characteristic);

export const pushOf = (ability: Ability, tier: number): number =>
	ability.push[tier - 1] ?? 0;

export const tierOf = (total: number): 1 | 2 | 3 => {
	if (total >= 17) {
		return 3;
	}

	return total >= 12 ? 2 : 1;
};

export const windedAt = (fighter: Fighter): number =>
	Math.floor(fighter.stamina / 2);

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export const nameOfSquare = (square: Square): string =>
	`${LETTERS[square.x] ?? "?"}${square.y + 1}`;

export const squareOfName = (name: string): Square | undefined => {
	const found = /^(?<column>[a-z])(?<row>\d{1,2})$/u.exec(name.toLowerCase());
	const column = found?.groups?.column ?? "";
	const row = Number(found?.groups?.row ?? "0");
	const x = LETTERS.indexOf(column);

	if (found === null || x === -1 || x >= COLUMNS || row < 1 || row > ROWS) {
		return undefined;
	}

	return { x, y: row - 1 };
};

export const terrainAt = (
	terrain: ReadonlyArray<string>,
	square: Square
): string => terrain[square.y]?.[square.x] ?? " ";

export const isSame = (a: Square, b: Square): boolean =>
	a.x === b.x && a.y === b.y;

export const apart = (a: Square, b: Square): number =>
	Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
