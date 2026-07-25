export type NamespacedType = `${string}.${string}`;

/** Returns whether a value is a non-array object with string keys. */
export const isRecord = (
	value: unknown
): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const CORE_ROOM_CREATED = "core.room-created";
export const CORE_SEAT_CLAIMED = "core.seat-claimed";
export const CORE_CHARACTER_BOUND = "core.character-bound";
export const CORE_CHAT_POSTED = "core.chat-posted";
export const CORE_DICE_ROLLED = "core.dice-rolled";

/* The five constants above are the core event vocabulary. Each fold has one
 * arm per type and treats any other `core.*` type as unknown (ADR-0010). */

export interface RoomCreatedPayload {
	readonly gameId: string;
}

export interface SeatClaimedPayload {
	readonly seatId: string;
}

export interface CharacterBoundPayload {
	readonly seatId: string;
	readonly characterId: string | null;
}

export interface ChatPostedPayload {
	readonly text: string;
}

export interface DiceRolledPayload {
	readonly notation: string;
	readonly rolls: readonly number[];
	readonly modifier: number;
	readonly total: number;
}

/** Commands the core decides itself — never routed to a game authority. */
export type CoreCommand =
	| { readonly type: "core.chat"; readonly text: string }
	| { readonly type: "core.roll"; readonly notation: string }
	| { readonly type: "core.claim-seat" }
	| {
			readonly type: "core.bind-character";
			readonly characterId: string | null;
	  };

export interface Envelope<
	TType extends NamespacedType = NamespacedType,
	TPayload = unknown,
> {
	readonly actor: string;
	readonly seq: number;
	readonly timestamp: string;
	readonly type: TType;
	readonly payload: TPayload;
}

export interface LogReader<TEnvelope extends Envelope = Envelope> {
	readonly read: () => AsyncIterable<TEnvelope>;
}

export interface LogWriter<TEnvelope extends Envelope = Envelope> {
	readonly append: (envelope: TEnvelope) => Promise<void>;
}

export interface Log<TEnvelope extends Envelope = Envelope>
	extends LogReader<TEnvelope>, LogWriter<TEnvelope> {}

export interface SeatView {
	readonly id: string;
	readonly actor: string | null;
	readonly characterId: string | null;
}

export interface TableView {
	readonly actor: string;
	readonly seats: readonly SeatView[];
	readonly gmSeatId: string;
}

export interface Rejection {
	readonly rejected: true;
	readonly message: string;
}

export interface RoomCommand<C = unknown> {
	readonly actor: string;
	readonly command: C;
}

export type RoomSubmission =
	| { readonly accepted: true; readonly envelopes: readonly Envelope[] }
	| Rejection;

export interface RoomStore<C = unknown> {
	readonly submit: (command: RoomCommand<C>) => Promise<RoomSubmission>;
	readonly stream: (fromSeq: number) => AsyncIterable<Envelope>;
}

export interface GameAuthority<S, C, E> {
	readonly init: () => S;
	readonly decide: (
		state: Readonly<S>,
		command: C,
		table: TableView
	) => E[] | Rejection;
	readonly apply: (state: Readonly<S>, event: E) => S;
}

export type ThemeToken = "accent" | "danger" | "muted" | "primary" | "success";

export interface TextRun {
	readonly text: string;
	readonly token: ThemeToken;
}

export interface FeedLine {
	readonly runs: readonly TextRun[];
}

export type LayoutSlot = "sidebar";

export interface GamePanelInput<S, C> {
	readonly state: Readonly<S>;
	readonly table: TableView;
	readonly focused: boolean;
	readonly dispatch: (command: C) => void;
}

export interface PanelKey {
	readonly name: string;
	readonly text?: string;
}

export interface GamePanel<S, C> {
	readonly id: string;
	readonly slot: LayoutSlot;
	readonly render: (input: GamePanelInput<S, C>) => readonly FeedLine[];
	readonly onKey?: (key: PanelKey, input: GamePanelInput<S, C>) => boolean;
}

export interface GameView<S, C, E> {
	readonly renderEvent: (event: E, state: Readonly<S>) => FeedLine | null;
	readonly createPanels: () => readonly GamePanel<S, C>[];
	readonly notices?: readonly FeedLine[];
}

export interface ValidationIssue {
	readonly message: string;
}

export type ValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export type ContentValidator = (bytes: Uint8Array) => ValidationResult;

export interface GameContent {
	readonly validate: ContentValidator;
}

/** A module's declared event grammar: every event type its fold recognizes,
 * legacy shapes included (they are recognized-and-valid forever, normalized by
 * upgrade-on-read). The writer fold asks the grammar to tell *unknown* from
 * *known-invalid* — a game event type outside this list makes the host refuse
 * to open the log (ADR-0010). It is a declaration, not a derivation: a module
 * that forgets to list a type it emits strands its own logs, so the module's
 * own conformance test is where the list is held to `apply`. */
export interface EventGrammar {
	readonly eventTypes: readonly NamespacedType[];
}

export interface AuthorityEntry<S, C, E> {
	readonly model: Pick<GameAuthority<S, C, E>, "init" | "apply">;
	readonly authority: Pick<GameAuthority<S, C, E>, "decide">;
	readonly grammar: EventGrammar;
}

export interface ViewEntry<S, C, E> {
	readonly model: Pick<GameAuthority<S, C, E>, "init" | "apply">;
	readonly view: GameView<S, C, E>;
}

export interface HostRegistry {
	readonly get: (
		gameId: string
	) => AuthorityEntry<unknown, unknown, unknown> | undefined;
}

export interface GatewayRegistry {
	readonly get: (
		gameId: string
	) => ViewEntry<unknown, unknown, unknown> | undefined;
}
