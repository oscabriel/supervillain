import type {
	CombatView,
	FeedLine,
	PartyMember,
	PrepItem,
	PrepSection,
	PrepView,
	Prose,
	StageView,
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
	CodexEntry,
	Combatant,
	CombatView,
	FeedLine,
	MapGrid,
	PartyHealth,
	PartyMember,
	PrepFigure,
	PrepItem,
	PrepKind,
	PrepSection,
	PrepStep,
	PrepToken,
	PrepView,
	Prose,
	ProseBlock,
	StageCardView,
	StageView,
	TokenAction,
	TrackerView,
} from "@supervillain/domain";

export interface PrepSource {
	readonly view: Accessor<PrepView | undefined>;
	readonly reload: () => Promise<string | undefined>;
	readonly stage?: Accessor<ReadonlyArray<PrepSection>>;
	readonly sync?: Accessor<PrepItem | undefined>;
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

export interface KnockShown {
	readonly actor: string;
	readonly name: string;
	readonly short: string;
}

export type KnockStatus =
	| {
			readonly kind: "naming";
			readonly invited: boolean;
			readonly said?: string;
	  }
	| { readonly kind: "waiting"; readonly name: string }
	| { readonly kind: "turned"; readonly text: string };

export interface KnockView {
	readonly room: string;
	readonly me: string;
	readonly status: Accessor<KnockStatus>;
	readonly knock: (name: string) => Promise<string | undefined>;
	readonly leave: () => void;
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
	readonly knocks?: Accessor<ReadonlyArray<KnockShown>>;
	readonly stage?: Accessor<StageView | undefined>;
	readonly party?: Accessor<ReadonlyArray<PartyMember>>;
	readonly gmNotes?: (key: string) => Prose | undefined;
	readonly contentProblems?: Accessor<ReadonlyArray<string>>;
}
