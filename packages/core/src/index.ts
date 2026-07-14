export type NamespacedType = `${string}.${string}`;

export const CORE_ROOM_CREATED = "core.room-created";
export const CORE_SEAT_CLAIMED = "core.seat-claimed";
export const CORE_CHAT_POSTED = "core.chat-posted";
export const CORE_DICE_ROLLED = "core.dice-rolled";

export interface RoomCreatedPayload {
	readonly gameId: string;
}

export interface SeatClaimedPayload {
	readonly seatId: string;
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
	| { readonly type: "core.claim-seat" };

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
}

export interface TableView {
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
	readonly dispatch: (command: C) => void;
}

export interface GamePanel<S, C> {
	readonly id: string;
	readonly slot: LayoutSlot;
	readonly render: (input: GamePanelInput<S, C>) => FeedLine;
}

export interface GameView<S, C, E> {
	readonly renderEvent: (event: E, state: Readonly<S>) => FeedLine | null;
	readonly panels: readonly GamePanel<S, C>[];
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

export interface AuthorityEntry<S, C, E> {
	readonly model: Pick<GameAuthority<S, C, E>, "init" | "apply">;
	readonly authority: Pick<GameAuthority<S, C, E>, "decide">;
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
