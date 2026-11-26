export type Tone =
	| "ground"
	| "grass"
	| "tree"
	| "rock"
	| "water"
	| "stone"
	| "wood"
	| "roof"
	| "floor"
	| "iron";

export interface Ding {
	readonly terrain: "." | "#" | "~";
	readonly tone: Tone;
	readonly depicts: string;
}

const d = (terrain: Ding["terrain"], tone: Tone, depicts: string): Ding => ({
	terrain,
	tone,
	depicts,
});

export const LEGEND: ReadonlyMap<string, Ding> = new Map(
	Object.entries({
		q: d(".", "ground", "bare ground, sparse"),
		Q: d(".", "ground", "bare ground"),
		w: d(".", "grass", "low scrub"),
		W: d("~", "grass", "thick scrub"),
		e: d(".", "ground", "hillocks"),
		E: d("~", "ground", "rough mounds"),
		r: d("~", "rock", "scree"),
		R: d("~", "rock", "rubble"),
		t: d("~", "rock", "boulders"),
		T: d("#", "rock", "rock outcrop"),
		y: d(".", "ground", "furrowed field"),
		Y: d("#", "tree", "cypress"),
		u: d(".", "grass", "grass"),
		U: d("~", "grass", "tall grass and reeds"),
		i: d("#", "tree", "broadleaf tree"),
		I: d("~", "tree", "sapling"),
		o: d("#", "tree", "conifer"),
		O: d("~", "tree", "young conifer"),
		p: d("#", "tree", "trees"),
		P: d("#", "tree", "deep wood"),
		a: d(".", "floor", "cobbled road"),
		A: d(".", "floor", "flagstones"),
		s: d("#", "stone", "brick wall"),
		S: d("#", "wood", "plank wall"),
		f: d("#", "roof", "tiled roof"),
		F: d("~", "water", "still water"),
		d: d(".", "stone", "archway"),
		D: d("#", "stone", "colonnade"),
		g: d("#", "stone", "doorway front"),
		G: d("#", "stone", "house"),
		h: d("#", "wood", "house"),
		H: d("#", "wood", "cottage"),
		j: d("#", "wood", "hut"),
		J: d("#", "stone", "statue"),
		k: d("#", "stone", "pillar"),
		K: d("#", "stone", "obelisk"),
		l: d("#", "stone", "twin columns"),
		L: d("~", "stone", "fallen column"),
		z: d("~", "water", "shallow water"),
		Z: d("~", "water", "water"),
		x: d("~", "water", "rapids"),
		X: d("~", "water", "deep water"),
		c: d(".", "floor", "dirt floor"),
		C: d(".", "floor", "packed floor"),
		v: d(".", "floor", "tiled floor"),
		V: d(".", "floor", "mosaic floor"),
		b: d(".", "floor", "chequered floor"),
		B: d("#", "iron", "iron grate"),
		n: d("#", "wood", "latticed window"),
		N: d("#", "wood", "door, shut"),
		m: d("#", "wood", "fence"),
		M: d("~", "stone", "stairs"),
	})
);

export const terrainOf = (letter: string): string | undefined =>
	letter === " " ? " " : LEGEND.get(letter)?.terrain;
