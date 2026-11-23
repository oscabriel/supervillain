import type { Footprint } from "./footprint.ts";

export type BoardSide = "heroes" | "director";

export interface MapToken {
	readonly id: string;
	readonly mark: string;
	readonly name: string;
	readonly x: number;
	readonly y: number;
	readonly side: BoardSide;
	readonly figure?: string;
	readonly footprint?: Footprint;
	readonly tiny?: boolean;
	readonly mine: boolean;
	readonly acting: boolean;
	readonly dead: boolean;
}

export interface MapView {
	readonly name: string;
	readonly width: number;
	readonly height: number;
	readonly terrain: ReadonlyArray<string>;
	readonly dressing?: ReadonlyArray<string>;
	readonly tokens: ReadonlyArray<MapToken>;
	readonly reach: ReadonlyArray<{ readonly x: number; readonly y: number }>;
	readonly reachLabel?: string;
}
