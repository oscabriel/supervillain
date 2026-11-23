import type {
	CombatView,
	FeedLine,
	PrepView,
	TokenAction,
} from "@supervillain/domain";
import type { Accessor } from "solid-js";

export interface Present {
	readonly actor: string;
	readonly label: string;
	readonly gm: boolean;
}

export type {
	ActionPick,
	Combatant,
	CombatView,
	FeedLine,
	PrepFigure,
	PrepItem,
	PrepKind,
	PrepSection,
	PrepStep,
	PrepToken,
	PrepView,
	TokenAction,
} from "@supervillain/domain";

export interface PrepSource {
	readonly view: Accessor<PrepView | undefined>;
	readonly reload: () => Promise<string | undefined>;
}

export interface MapToken {
	readonly id: string;
	readonly mark: string;
	readonly name: string;
	readonly x: number;
	readonly y: number;
	readonly side: "heroes" | "director";
	readonly figure?: string;
	readonly footprint?: 1 | 2 | 3 | 4;
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

export interface TableView {
	readonly me: string;
	readonly room: string;
	readonly feed: Accessor<ReadonlyArray<FeedLine>>;
	readonly present: Accessor<ReadonlyArray<Present>>;
	readonly myName: Accessor<string | undefined>;
	readonly submit: (line: string) => Promise<string | undefined>;
	readonly complete: (line: string) => ReadonlyArray<string>;
	readonly debug: () => string;
	readonly leave: () => void;
	readonly joinHint?: string;
	readonly joinNote?: Accessor<string>;
	readonly alert?: Accessor<string | undefined>;
	readonly combat?: Accessor<CombatView | undefined>;
	readonly map?: Accessor<MapView | undefined>;
	readonly actions?: (id: string) => ReadonlyArray<TokenAction> | undefined;
	readonly prep?: PrepSource;
}
