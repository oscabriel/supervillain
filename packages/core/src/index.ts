import type { MapLegend } from "./map.js";
import type { FeedLine } from "./text.js";
import { isRecord } from "./validation.js";
import type { ContentValidator } from "./validation.js";

export type { ActorLinks } from "./actors.js";
export { createActorLinks } from "./actors.js";
export type {
	BattleMap,
	MapLegend,
	MapParseResult,
	MapTile,
	MapToken,
	TokenFold,
} from "./map.js";
export {
	DEFAULT_MAP_LEGEND,
	foldTokenMoved,
	foldTokenPlaced,
	foldTokenRemoved,
	isInsideMap,
	isValidMapName,
	isValidTokenGlyph,
	isValidTokenId,
	MAP_DIRECTORY,
	MAP_FILE_EXTENSION,
	MAP_MAX_HEIGHT,
	MAP_MAX_LEGEND_ENTRIES,
	MAP_MAX_TOKENS,
	MAP_MAX_WIDTH,
	MAP_NAME_MAX_LENGTH,
	MAP_SEPARATOR,
	MAP_TILES,
	mapDimensions,
	mapFilePath,
	mapGlyphAt,
	mapTileAt,
	parseMapFile,
	readMapLoadedPayload,
	readTokenMovedPayload,
	readTokenPlacedPayload,
	readTokenRemovedPayload,
	TOKEN_ID_MAX_LENGTH,
	TOKEN_LABEL_MAX_LENGTH,
	tokenAt,
	validateMapFile,
} from "./map.js";
export type {
	CharacterSnapshotDocumentV1,
	LogSnapshotDocumentV1,
	MapSnapshotDocumentV1,
	SnapshotArtifactType,
	SnapshotCardV1,
	SnapshotDocument,
	SnapshotDocumentV1,
	SnapshotFieldV1,
	SnapshotLogBlockV1,
	SnapshotLogEntryV1,
	SnapshotMapGridV1,
	SnapshotMapLegendV1,
	SnapshotMapTileV1,
	SnapshotSectionV1,
	SnapshotTextAttributeV1,
	SnapshotTextBlockV1,
	SnapshotTextRunV1,
	SnapshotThemeTokenV1,
	SnapshotValidationResult,
} from "./snapshot.js";
export {
	SNAPSHOT_ARTIFACT_TYPES,
	SNAPSHOT_MAP_TILES_V1,
	SNAPSHOT_SCHEMA_VERSION,
	SNAPSHOT_TEXT_ATTRIBUTES_V1,
	SNAPSHOT_THEME_TOKENS_V1,
	validateSnapshotDocument,
} from "./snapshot.js";
export type { FeedLine, TextAttribute, TextRun, ThemeToken } from "./text.js";
export { TEXT_ATTRIBUTES, THEME_TOKENS } from "./text.js";
export type {
	ContentValidator,
	ValidationIssue,
	ValidationResult,
} from "./validation.js";
export { isRecord } from "./validation.js";

export type NamespacedType = `${string}.${string}`;

export const CORE_ROOM_CREATED = "core.room-created";
export const CORE_SEAT_CLAIMED = "core.seat-claimed";
export const CORE_CHARACTER_BOUND = "core.character-bound";
export const CORE_CHAT_POSTED = "core.chat-posted";
export const CORE_DICE_ROLLED = "core.dice-rolled";
export const CORE_MAP_LOADED = "core.map-loaded";
export const CORE_MAP_CLEARED = "core.map-cleared";
export const CORE_TOKEN_PLACED = "core.token-placed";
export const CORE_TOKEN_MOVED = "core.token-moved";
export const CORE_TOKEN_REMOVED = "core.token-removed";
export const CORE_ACTOR_LINKED = "core.actor-linked";

/* The eleven constants above are the core event vocabulary. Each fold has one
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

/** The whole validated map file — replay never reads the file itself. */
export interface MapLoadedPayload {
	readonly name: string;
	readonly legend: MapLegend;
	readonly rows: readonly string[];
}

export type MapClearedPayload = Readonly<Record<string, never>>;

/** The whole token: placing onto an id already on the surface replaces it,
 * which is how a re-glyph rides the pinned three-event vocabulary. */
export interface TokenPlacedPayload {
	readonly id: string;
	readonly glyph: string;
	readonly label: string;
	readonly seatId: string | null;
	readonly x: number;
	readonly y: number;
}

export interface TokenMovedPayload {
	readonly id: string;
	readonly x: number;
	readonly y: number;
}

export interface TokenRemovedPayload {
	readonly id: string;
}

/**
 * Two actors are one person (ADR-0005). The envelope's actor is the redeeming
 * key; `linked` is the actor it absorbed — a second machine's `<64hex>` key or
 * an adopted `guest:X`. One event type serves device linking and guest adoption
 * alike, and the fold unions the two strings rather than rewriting history.
 */
export interface ActorLinkedPayload {
	readonly linked: string;
}

/** The absorbed actor a `core.actor-linked` payload names, or `null` when the
 * payload is not one — known-invalid, in ADR-0010's sense. */
export const readActorLinkedPayload = (payload: unknown): string | null => {
	if (!isRecord(payload) || typeof payload.linked !== "string") {
		return null;
	}
	const linked = payload.linked.trim();
	return linked.length === 0 ? null : linked;
};

/** Commands the core decides itself — never routed to a game authority. */
export type CoreCommand =
	| { readonly type: "core.chat"; readonly text: string }
	| { readonly type: "core.roll"; readonly notation: string }
	| { readonly type: "core.claim-seat" }
	| {
			readonly type: "core.bind-character";
			readonly characterId: string | null;
	  }
	| { readonly type: "core.load-map"; readonly name: string }
	| { readonly type: "core.clear-map" }
	| {
			/** Omitting `id` mints a fresh token; naming one that is already on
			 * the surface replaces it — the re-glyph path. */
			readonly type: "core.place-token";
			readonly id?: string;
			readonly glyph: string;
			readonly label?: string;
			readonly seatId?: string | null;
			readonly x: number;
			readonly y: number;
	  }
	| {
			readonly type: "core.move-token";
			readonly id: string;
			readonly x: number;
			readonly y: number;
	  }
	| { readonly type: "core.remove-token"; readonly id: string }
	| {
			/** Materializes a linking fact the gateway resolved from the graph.
			 * The submitting connection names an actor other than itself, so only
			 * a trusted stamper may send it (ADR-0003/0005). */
			readonly type: "core.link-actor";
			readonly linked: string;
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

/**
 * Process-local provenance for a command admitted by a trusted stamper. The
 * mark lives outside the serialized command, so no wire peer can claim it by
 * adding a field to JSON. Transport adapters apply it only after authenticating
 * the trusted connection; the Host consumes it for commands whose authority is
 * the gateway's identity graph rather than a Seat.
 */
const trustedRoomCommands = new WeakSet<RoomCommand>();

export const markTrustedRoomCommand = <C>(
	command: RoomCommand<C>
): RoomCommand<C> => {
	trustedRoomCommands.add(command);
	return command;
};

export const isTrustedRoomCommand = (command: RoomCommand): boolean =>
	trustedRoomCommands.has(command);

export type RoomSubmission =
	| { readonly accepted: true; readonly envelopes: readonly Envelope[] }
	| Rejection;

/** A disposable reader-fold artifact through one Log sequence. Its payload is
 * deliberately opaque to the RoomStore seam: the fold that produced it is the
 * only module that may interpret it. */
export interface RoomFoldCheckpoint {
	readonly throughSeq: number;
	readonly payload: unknown;
}

/** An atomic late-join starting point: restore the optional checkpoint, then
 * consume `stream` for its contiguous tail and live Envelopes. */
export interface RoomReplay {
	readonly checkpoint?: RoomFoldCheckpoint;
	/** Last sequence in the frozen initial tail. Later Envelopes are live. */
	readonly throughSeq: number;
	readonly stream: AsyncIterable<Envelope>;
}

/** The injected fold adapter a checkpointing RoomStore drives. It contains no
 * authority: applying Envelopes only derives a disposable reader artifact. */
export interface RoomCheckpointProducer {
	readonly apply: (envelope: Envelope) => void;
	readonly capture: () => unknown;
}

export interface RoomStore<C = unknown> {
	readonly submit: (command: RoomCommand<C>) => Promise<RoomSubmission>;
	readonly stream: (fromSeq: number) => AsyncIterable<Envelope>;
	/** Optional acceleration for adapters that share a reader-fold checkpoint.
	 * Calling this captures checkpoint + tail cursor atomically. */
	readonly replay?: () => Promise<RoomReplay>;
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

export type LayoutSlot = "sidebar";

/** A Panel's request to borrow the Table's Message Pane for contextual text. */
export interface MessageTask<C> {
	readonly title: string;
	/** Converts submitted text into the game command the Table dispatches. */
	readonly submit: (value: string) => C;
}

export interface GamePanelInput<S, C> {
	readonly state: Readonly<S>;
	readonly table: TableView;
	readonly focused: boolean;
	readonly dispatch: (command: C) => void;
	readonly requestMessageTask: (task: MessageTask<C>) => void;
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
	/** Handles a click on the corresponding zero-based line returned by render. */
	readonly onRowClick?: (row: number, input: GamePanelInput<S, C>) => boolean;
}

export interface GameView<S, C, E> {
	readonly renderEvent: (event: E, state: Readonly<S>) => FeedLine | null;
	readonly createPanels: () => readonly GamePanel<S, C>[];
	readonly notices?: readonly FeedLine[];
}

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
