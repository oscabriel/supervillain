import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
	CORE_ACTOR_LINKED,
	CORE_CHARACTER_BOUND,
	CORE_CHAT_POSTED,
	CORE_DICE_ROLLED,
	CORE_MAP_CLEARED,
	CORE_MAP_LOADED,
	CORE_ROOM_CREATED,
	CORE_SEAT_CLAIMED,
	CORE_TOKEN_MOVED,
	CORE_TOKEN_PLACED,
	CORE_TOKEN_REMOVED,
	createActorLinks,
	foldTokenMoved,
	foldTokenPlaced,
	foldTokenRemoved,
	isTrustedRoomCommand,
	isValidMapName,
	isValidTokenGlyph,
	isValidTokenId,
	mapFilePath,
	parseMapFile,
	readActorLinkedPayload,
	readMapLoadedPayload,
	TOKEN_LABEL_MAX_LENGTH,
} from "@supervillain/core";
import type {
	ActorLinkedPayload,
	ActorLinks,
	AuthorityEntry,
	BattleMap,
	CharacterBoundPayload,
	ChatPostedPayload,
	DiceRolledPayload,
	Envelope,
	HostRegistry,
	MapClearedPayload,
	MapLoadedPayload,
	MapToken,
	NamespacedType,
	Rejection,
	RoomCommand,
	RoomCreatedPayload,
	RoomSubmission,
	SeatClaimedPayload,
	SeatView,
	TableView,
	TokenFold,
	TokenMovedPayload,
	TokenPlacedPayload,
	TokenRemovedPayload,
	ValidationIssue,
} from "@supervillain/core";

import { Latch } from "./latch.js";

const LOG_FILE = "events.jsonl";
const DICE_NOTATION =
	/^(?<count>\d*)d(?<sides>\d+)(?:(?<sign>[+-])(?<modifier>\d+))?$/iu;

const TOKEN_COMMANDS: ReadonlySet<string> = new Set([
	"core.place-token",
	"core.move-token",
	"core.remove-token",
]);

export interface RoomHostOptions {
	readonly campaignFolder: string;
	readonly registry: HostRegistry;
	readonly gameId?: string;
	readonly actor?: string;
	readonly clock?: () => string;
	readonly random?: () => number;
}

export interface RoomSnapshot {
	readonly gameId: string;
	readonly game: unknown;
	readonly table: TableView;
	readonly map: BattleMap | null;
	readonly tokens: readonly MapToken[];
	readonly seq: number;
}

interface Subscriber {
	readonly afterSeq: number;
	readonly push: (envelope: Envelope) => void;
}

const isRejection = (
	value: readonly unknown[] | Rejection
): value is Rejection => !Array.isArray(value);

const splitEvent = (
	event: unknown
): {
	readonly type: NamespacedType;
	readonly payload: unknown;
} => {
	if (typeof event !== "object" || event === null || !("type" in event)) {
		throw new Error(
			"Game authority emitted an event without a namespaced type."
		);
	}
	const { type, ...payload } = event as {
		readonly type: unknown;
		readonly [key: string]: unknown;
	};
	if (typeof type !== "string" || !type.includes(".")) {
		throw new Error(
			"Game authority emitted an event without a namespaced type."
		);
	}
	return { payload, type: type as NamespacedType };
};

const joinEvent = (envelope: Envelope): unknown => {
	if (typeof envelope.payload !== "object" || envelope.payload === null) {
		throw new Error(
			`Event '${envelope.type}' at line ${envelope.seq} must carry an object payload.`
		);
	}
	return { type: envelope.type, ...envelope.payload };
};

const isNodeError = (
	error: unknown
): error is Error & { readonly code: string } =>
	error instanceof Error && "code" in error && typeof error.code === "string";

/** Drafts the move or removal a token command names. Both carry only an id and
 * a destination, so neither needs the room's state to take shape. */
const draftTokenChange = (
	command: Record<string, unknown> & { readonly type: string }
):
	| Rejection
	| {
			readonly type: NamespacedType;
			readonly payload: TokenMovedPayload | TokenRemovedPayload;
	  } => {
	const { id } = command;
	if (typeof id !== "string" || !isValidTokenId(id)) {
		return { message: "That is not a token id.", rejected: true };
	}
	return command.type === "core.remove-token"
		? { payload: { id }, type: CORE_TOKEN_REMOVED }
		: {
				payload: { id, x: Number(command.x), y: Number(command.y) },
				type: CORE_TOKEN_MOVED,
			};
};

/** Turns a fold's lower-case refusal reason into a player-facing sentence. */
const capitalize = (reason: string): string =>
	`${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;

const describeIssues = (errors: readonly ValidationIssue[]): string => {
	const [first, ...rest] = errors;
	const message = first?.message ?? "Map file is invalid.";
	return rest.length === 0 ? message : `${message} (+${rest.length} more)`;
};

/** The authority fold halts on both tiers (ADR-0010): a single writer must
 * never append on top of state it only partially understood. `seq` is the
 * JSONL line number, so the message points at the exact offending line. */
const tooOld = (envelope: Envelope): Error =>
	new Error(
		`Log contains unknown event type '${envelope.type}' at line ${envelope.seq} — this host is too old.`
	);

export class RoomHost {
	readonly #campaignFolder: string;
	readonly #logPath: string;
	readonly #registry: HostRegistry;
	readonly #table: TableView = { actor: "", gmSeatId: "gm", seats: [] };
	readonly #clock: () => string;
	readonly #random: () => number;
	readonly #envelopes: Envelope[] = [];
	readonly #subscribers = new Set<Subscriber>();
	/** This log's slice of the key-equivalence graph (ADR-0005): who is whom,
	 * folded from `core.actor-linked` and consulted by every seat lookup, so
	 * GM roaming falls out of idempotent seat claiming with no mechanism of
	 * its own. */
	readonly #links: ActorLinks = createActorLinks();
	#authority: AuthorityEntry<unknown, unknown, unknown> | undefined;
	#grammar: ReadonlySet<string> = new Set();
	#gameId: string | undefined;
	#game: unknown;
	#map: BattleMap | null = null;
	#tokens: readonly MapToken[] = [];
	/** Monotonic across the whole log, so a minted token id is never reused
	 * after a removal and replay derives the same ids every time. */
	#tokensPlaced = 0;
	#writeTail: Promise<void> = Promise.resolve();

	private constructor(options: RoomHostOptions) {
		this.#campaignFolder = options.campaignFolder;
		this.#logPath = path.join(options.campaignFolder, LOG_FILE);
		this.#registry = options.registry;
		this.#clock = options.clock ?? (() => new Date().toISOString());
		this.#random = options.random ?? Math.random;
	}

	static async open(options: RoomHostOptions): Promise<RoomHost> {
		const host = new RoomHost(options);
		await mkdir(options.campaignFolder, { recursive: true });
		await host.#replay();

		if (host.#gameId === undefined) {
			if (options.gameId === undefined || options.actor === undefined) {
				throw new Error("A new room requires both a gameId and an actor.");
			}
			if (options.registry.get(options.gameId) === undefined) {
				throw new Error(
					`No game authority is registered for '${options.gameId}'.`
				);
			}
			await host.#append([
				{
					actor: options.actor,
					payload: { gameId: options.gameId } satisfies RoomCreatedPayload,
					seq: 1,
					timestamp: host.#clock(),
					type: CORE_ROOM_CREATED,
				},
				{
					actor: options.actor,
					payload: { seatId: "gm" } satisfies SeatClaimedPayload,
					seq: 2,
					timestamp: host.#clock(),
					type: CORE_SEAT_CLAIMED,
				},
			]);
		} else if (
			options.gameId !== undefined &&
			options.gameId !== host.#gameId
		) {
			throw new Error(
				`Campaign folder is bound to game '${host.#gameId}', not '${options.gameId}'.`
			);
		}

		return host;
	}

	snapshot(): RoomSnapshot {
		if (this.#gameId === undefined) {
			throw new Error("Room has not been created.");
		}
		return {
			game: this.#game,
			gameId: this.#gameId,
			map: this.#map,
			seq: this.#envelopes.length,
			table: this.#table,
			tokens: this.#tokens,
		};
	}

	/**
	 * Every actor string this log mentions, first-seen first — including the
	 * ones only a `core.actor-linked` payload names. This is the roster the
	 * Host offers its gateway at registration, which is how a room learns about
	 * linking that happened while it was offline without any queue existing
	 * (ADR-0013).
	 */
	actors(): readonly string[] {
		return this.#links.actors();
	}

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		const previous = this.#writeTail;
		const gate = new Latch();
		this.#writeTail = gate.released;
		try {
			await previous;
			return await this.#submit(command);
		} finally {
			gate.release();
		}
	}

	stream(fromSeq: number): AsyncIterable<Envelope> {
		if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
			throw new RangeError("fromSeq must be a positive safe integer.");
		}

		const envelopes = this.#envelopes;
		const subscribers = this.#subscribers;
		return {
			async *[Symbol.asyncIterator]() {
				const pending: Envelope[] = [];
				let gate = new Latch();
				const subscriber: Subscriber = {
					afterSeq: envelopes.length,
					push(envelope) {
						pending.push(envelope);
						gate.release();
					},
				};
				subscribers.add(subscriber);

				try {
					for (const envelope of envelopes) {
						if (
							envelope.seq >= fromSeq &&
							envelope.seq <= subscriber.afterSeq
						) {
							yield envelope;
						}
					}
					for (;;) {
						if (pending.length === 0) {
							// oxlint-disable-next-line eslint/no-await-in-loop -- streaming: waiting for the next event inside the loop is the feature
							await gate.released;
							gate = new Latch();
						}
						while (pending.length > 0) {
							const envelope = pending.shift();
							if (envelope !== undefined && envelope.seq >= fromSeq) {
								yield envelope;
							}
						}
					}
				} finally {
					subscribers.delete(subscriber);
				}
			},
		};
	}

	#bind(gameId: string): void {
		const authority = this.#registry.get(gameId);
		if (authority === undefined) {
			throw new Error(`No game authority is registered for '${gameId}'.`);
		}
		this.#gameId = gameId;
		this.#authority = authority;
		this.#grammar = new Set(authority.grammar.eventTypes);
		this.#game = authority.model.init();
	}

	async #submit(submission: RoomCommand): Promise<RoomSubmission> {
		const { actor, command } = submission;
		if (this.#authority === undefined || this.#gameId === undefined) {
			throw new Error("Room has no game authority.");
		}
		if (
			typeof command === "object" &&
			command !== null &&
			"type" in command &&
			typeof command.type === "string" &&
			command.type.startsWith("core.")
		) {
			return this.#submitCore(
				actor,
				command as Record<string, unknown> & { type: string },
				isTrustedRoomCommand(submission)
			);
		}
		const decide = this.#authority.authority.decide as (
			state: unknown,
			command: unknown,
			table: TableView
		) => unknown[] | Rejection;
		const decided = decide(this.#game, command, {
			...this.#table,
			actor,
		});
		if (isRejection(decided)) {
			return decided;
		}

		const envelopes: Envelope[] = [];
		for (const event of decided) {
			const { type, payload } = splitEvent(event);
			if (type.startsWith("core.")) {
				throw new Error(`Game '${this.#gameId}' emitted core event '${type}'.`);
			}
			// Caught before the write: an event outside the module's own declared
			// grammar would halt every later replay of this log (ADR-0010).
			if (!this.#grammar.has(type)) {
				throw new Error(
					`Game '${this.#gameId}' emitted event '${type}', which is outside its declared event grammar.`
				);
			}
			envelopes.push({
				actor,
				payload,
				seq: this.#envelopes.length + envelopes.length + 1,
				timestamp: this.#clock(),
				type,
			});
		}
		await this.#append(envelopes);
		return { accepted: true, envelopes };
	}

	// oxlint-disable-next-line eslint/complexity -- validation branches directly mirror the pinned command grammar.
	async #submitCore(
		actor: string,
		command: Record<string, unknown> & { readonly type: string },
		trustedStamper: boolean
	): Promise<RoomSubmission> {
		if (command.type === "core.link-actor") {
			if (!trustedStamper) {
				return {
					message: "Only the gateway may link actors.",
					rejected: true,
				};
			}
			return await this.#submitLink(actor, command.linked);
		}
		if (command.type === "core.claim-seat") {
			if (this.#seatFor(actor) !== undefined) {
				// Idempotent by identity, not by key: a GM whose laptop key was
				// linked to the desktop's gets the GM seat back, not a new one.
				return { accepted: true, envelopes: [] };
			}
			const playerCount = this.#table.seats.filter(
				(seat) => seat.id !== "gm"
			).length;
			const envelope: Envelope = {
				actor,
				payload: {
					seatId: `player-${playerCount + 1}`,
				} satisfies SeatClaimedPayload,
				seq: this.#envelopes.length + 1,
				timestamp: this.#clock(),
				type: CORE_SEAT_CLAIMED,
			};
			await this.#append([envelope]);
			return { accepted: true, envelopes: [envelope] };
		}
		const actorSeat = this.#seatFor(actor);
		if (actorSeat === undefined) {
			return {
				message: "You do not hold a seat at this table.",
				rejected: true,
			};
		}
		if (command.type === "core.load-map" || command.type === "core.clear-map") {
			return await this.#submitMap(actor, actorSeat, command);
		}
		if (TOKEN_COMMANDS.has(command.type)) {
			return await this.#submitToken(actor, actorSeat, command);
		}
		if (command.type === "core.bind-character") {
			const characterId =
				typeof command.characterId === "string"
					? command.characterId.trim()
					: command.characterId;
			if (
				characterId !== null &&
				(typeof characterId !== "string" ||
					characterId.length === 0 ||
					characterId.length > 60)
			) {
				return {
					message:
						"Character id must be a non-empty string of at most 60 characters.",
					rejected: true,
				};
			}
			if (actorSeat.characterId === characterId) {
				return { accepted: true, envelopes: [] };
			}
			const envelope: Envelope = {
				actor,
				payload: {
					characterId,
					seatId: actorSeat.id,
				} satisfies CharacterBoundPayload,
				seq: this.#envelopes.length + 1,
				timestamp: this.#clock(),
				type: CORE_CHARACTER_BOUND,
			};
			await this.#append([envelope]);
			return { accepted: true, envelopes: [envelope] };
		}
		let type: typeof CORE_CHAT_POSTED | typeof CORE_DICE_ROLLED;
		let payload: ChatPostedPayload | DiceRolledPayload;
		if (command.type === "core.chat") {
			const text = typeof command.text === "string" ? command.text.trim() : "";
			if (text.length === 0) {
				return { message: "Chat message is empty.", rejected: true };
			}
			if (text.length > 1000) {
				return { message: "Chat message is too long.", rejected: true };
			}
			type = CORE_CHAT_POSTED;
			payload = { text };
		} else if (command.type === "core.roll") {
			const input =
				typeof command.notation === "string" ? command.notation : "";
			const compact = input.replaceAll(/\s/gu, "").toLowerCase();
			const match = DICE_NOTATION.exec(compact);
			const count =
				match?.groups?.count === "" ? 1 : Number(match?.groups?.count);
			const sides = Number(match?.groups?.sides);
			const modifierMagnitude =
				match?.groups?.modifier === undefined
					? 0
					: Number(match.groups.modifier);
			if (
				!match ||
				count < 1 ||
				count > 20 ||
				sides < 2 ||
				sides > 1000 ||
				modifierMagnitude > 1000
			) {
				return {
					message: `Cannot roll '${input}'. Use NdS or NdS+M, e.g. 2d6+1.`,
					rejected: true,
				};
			}
			const modifier =
				match.groups?.sign === "-" ? -modifierMagnitude : modifierMagnitude;
			const rolls = Array.from(
				{ length: count },
				() => Math.floor(this.#random() * sides) + 1
			);
			const total = rolls.reduce((sum, roll) => sum + roll, modifier);
			type = CORE_DICE_ROLLED;
			payload = { modifier, notation: compact, rolls, total };
		} else {
			return {
				message: `Unknown core command '${command.type}'.`,
				rejected: true,
			};
		}
		const envelope: Envelope = {
			actor,
			payload,
			seq: this.#envelopes.length + 1,
			timestamp: this.#clock(),
			type,
		};
		await this.#append([envelope]);
		return { accepted: true, envelopes: [envelope] };
	}

	/** The seat this actor holds, resolved through the link graph so every key
	 * of one identity finds the same seat. */
	#seatFor(actor: string): SeatView | undefined {
		return this.#table.seats.find(
			(seat) => seat.actor !== null && this.#links.same(seat.actor, actor)
		);
	}

	/**
	 * Materializes one linking fact the gateway derived from its graph. It is
	 * idempotent on purpose: nothing anywhere records that a room was told, so
	 * being told twice must cost nothing (ADR-0013 — derive, never queue).
	 */
	async #submitLink(
		actor: string,
		requested: unknown
	): Promise<RoomSubmission> {
		const linked = typeof requested === "string" ? requested.trim() : "";
		if (linked.length === 0) {
			return { message: "A linking event names no actor.", rejected: true };
		}
		if (this.#links.same(actor, linked)) {
			return { accepted: true, envelopes: [] };
		}
		const envelope: Envelope = {
			actor,
			payload: { linked } satisfies ActorLinkedPayload,
			seq: this.#envelopes.length + 1,
			timestamp: this.#clock(),
			type: CORE_ACTOR_LINKED,
		};
		await this.#append([envelope]);
		return { accepted: true, envelopes: [envelope] };
	}

	async #submitMap(
		actor: string,
		actorSeat: SeatView,
		command: Record<string, unknown> & { readonly type: string }
	): Promise<RoomSubmission> {
		if (actorSeat.id !== this.#table.gmSeatId) {
			return {
				message: "Only the GM can load or clear the battle map.",
				rejected: true,
			};
		}
		return command.type === "core.clear-map"
			? await this.#clearMap(actor)
			: await this.#loadMap(actor, command.name);
	}

	async #clearMap(actor: string): Promise<RoomSubmission> {
		if (this.#map === null) {
			return { accepted: true, envelopes: [] };
		}
		const envelope: Envelope = {
			actor,
			payload: {} satisfies MapClearedPayload,
			seq: this.#envelopes.length + 1,
			timestamp: this.#clock(),
			type: CORE_MAP_CLEARED,
		};
		await this.#append([envelope]);
		return { accepted: true, envelopes: [envelope] };
	}

	async #loadMap(actor: string, requested: unknown): Promise<RoomSubmission> {
		const name = typeof requested === "string" ? requested.trim() : "";
		if (!isValidMapName(name)) {
			return {
				message:
					"Map names are 1-60 letters, digits, hyphens, and underscores.",
				rejected: true,
			};
		}
		const relativePath = mapFilePath(name);
		let bytes: Uint8Array;
		try {
			bytes = await readFile(path.join(this.#campaignFolder, relativePath));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				return { message: `No map file at ${relativePath}.`, rejected: true };
			}
			throw error;
		}
		const parsed = parseMapFile(bytes);
		if (!parsed.ok) {
			return {
				message: `${relativePath}: ${describeIssues(parsed.errors)}`,
				rejected: true,
			};
		}
		const envelope: Envelope = {
			actor,
			payload: {
				legend: parsed.map.legend,
				name: parsed.map.name,
				rows: parsed.map.rows,
			} satisfies MapLoadedPayload,
			seq: this.#envelopes.length + 1,
			timestamp: this.#clock(),
			type: CORE_MAP_LOADED,
		};
		await this.#append([envelope]);
		return { accepted: true, envelopes: [envelope] };
	}

	/**
	 * The one token authority check, against the log-derived seat map: the GM
	 * does everything, and a player may only *move* a token bound to their own
	 * seat (ADR-0006). `#tokens` is folded from this room's own log, so the
	 * binding a player is measured against is the one everyone else can see.
	 */
	#tokenAuthority(
		actorSeat: SeatView,
		command: Record<string, unknown> & { readonly type: string }
	): Rejection | null {
		if (actorSeat.id === this.#table.gmSeatId) {
			return null;
		}
		if (command.type !== "core.move-token") {
			return {
				message: "Only the GM can place or remove tokens.",
				rejected: true,
			};
		}
		const token = this.#tokens.find((candidate) => candidate.id === command.id);
		if (token === undefined) {
			return { message: `No token '${String(command.id)}'.`, rejected: true };
		}
		if (token.seatId !== actorSeat.id) {
			return {
				message: `Token '${token.id}' is not bound to your seat.`,
				rejected: true,
			};
		}
		return null;
	}

	async #submitToken(
		actor: string,
		actorSeat: SeatView,
		command: Record<string, unknown> & { readonly type: string }
	): Promise<RoomSubmission> {
		const refusal = this.#tokenAuthority(actorSeat, command);
		if (refusal !== null) {
			return refusal;
		}
		if (this.#map === null) {
			return { message: "No battle map is loaded.", rejected: true };
		}
		const drafted =
			command.type === "core.place-token"
				? this.#draftPlaced(command)
				: draftTokenChange(command);
		if ("rejected" in drafted) {
			return drafted;
		}
		// Dry-run the writer fold before the write: the host must never append an
		// event its own replay would refuse to apply (ADR-0010).
		const folded = this.#foldToken(drafted.type, drafted.payload);
		if (!folded.ok) {
			return { message: capitalize(folded.reason), rejected: true };
		}
		const envelope: Envelope = {
			actor,
			payload: drafted.payload,
			seq: this.#envelopes.length + 1,
			timestamp: this.#clock(),
			type: drafted.type,
		};
		await this.#append([envelope]);
		return { accepted: true, envelopes: [envelope] };
	}

	#draftPlaced(
		command: Record<string, unknown>
	):
		| Rejection
		| { readonly type: NamespacedType; readonly payload: TokenPlacedPayload } {
		const glyph = typeof command.glyph === "string" ? command.glyph : "";
		if (!isValidTokenGlyph(glyph)) {
			return {
				message: "A token glyph is exactly one printable character.",
				rejected: true,
			};
		}
		const label = typeof command.label === "string" ? command.label.trim() : "";
		if (label.length > TOKEN_LABEL_MAX_LENGTH) {
			return {
				message: `A token label is at most ${TOKEN_LABEL_MAX_LENGTH} characters.`,
				rejected: true,
			};
		}
		const id = command.id === undefined ? this.#mintTokenId() : command.id;
		if (typeof id !== "string" || !isValidTokenId(id)) {
			return {
				message:
					"Token ids are 1-60 letters, digits, hyphens, and underscores.",
				rejected: true,
			};
		}
		const seatId = typeof command.seatId === "string" ? command.seatId : null;
		if (
			command.seatId !== undefined &&
			command.seatId !== null &&
			typeof command.seatId !== "string"
		) {
			return { message: "That is not a seat id.", rejected: true };
		}
		if (
			seatId !== null &&
			!this.#table.seats.some((seat) => seat.id === seatId)
		) {
			return {
				message: `No seat '${seatId}' is at this table.`,
				rejected: true,
			};
		}
		return {
			payload: {
				glyph,
				id,
				label,
				seatId,
				x: Number(command.x),
				y: Number(command.y),
			},
			type: CORE_TOKEN_PLACED,
		};
	}

	/** The next unused `token-<n>`. The counter only ever climbs, and an id a
	 * caller named by hand is stepped over rather than silently replaced. */
	#mintTokenId(): string {
		let next = this.#tokensPlaced + 1;
		while (this.#tokens.some((token) => token.id === `token-${next}`)) {
			next += 1;
		}
		return `token-${next}`;
	}

	/** One fold step over the token set, shared by the dry run and `#fold`. */
	#foldToken(type: NamespacedType, payload: unknown): TokenFold {
		if (type === CORE_TOKEN_PLACED) {
			return foldTokenPlaced(this.#map, this.#tokens, payload);
		}
		if (type === CORE_TOKEN_MOVED) {
			return foldTokenMoved(this.#map, this.#tokens, payload);
		}
		return foldTokenRemoved(this.#tokens, payload);
	}

	async #append(envelopes: readonly Envelope[]): Promise<void> {
		if (envelopes.length === 0) {
			return;
		}
		const file = await open(this.#logPath, "a");
		try {
			await file.write(
				envelopes.map((envelope) => `${JSON.stringify(envelope)}\n`).join("")
			);
			await file.sync();
		} finally {
			await file.close();
		}
		for (const envelope of envelopes) {
			this.#fold(envelope);
			this.#envelopes.push(envelope);
			for (const subscriber of this.#subscribers) {
				subscriber.push(envelope);
			}
		}
	}

	// oxlint-disable-next-line eslint/complexity -- the writer fold's branches are the two-tier posture: one arm per recognized core type, then the halt on anything unknown (ADR-0010).
	#fold(envelope: Envelope): void {
		// Every envelope names its actor, so the roster the Host offers the
		// gateway at registration is a by-product of the fold, never a table.
		this.#links.remember(envelope.actor);
		if (envelope.type === CORE_ACTOR_LINKED) {
			const linked = readActorLinkedPayload(envelope.payload);
			if (linked === null) {
				throw new TypeError(
					`Linking event at line ${envelope.seq} names no actor.`
				);
			}
			this.#links.link(envelope.actor, linked);
			return;
		}
		if (envelope.type === CORE_ROOM_CREATED) {
			if (this.#gameId !== undefined) {
				throw new Error(
					`Log creates the room more than once at line ${envelope.seq}.`
				);
			}
			const payload = envelope.payload as Partial<RoomCreatedPayload>;
			if (typeof payload.gameId !== "string") {
				throw new TypeError(
					`Room creation event at line ${envelope.seq} has no game id.`
				);
			}
			this.#bind(payload.gameId);
			return;
		}
		if (envelope.type === CORE_SEAT_CLAIMED) {
			const payload = envelope.payload as Partial<SeatClaimedPayload>;
			if (typeof payload.seatId !== "string") {
				throw new TypeError(
					`Seat claim event at line ${envelope.seq} has no seat id.`
				);
			}
			if (this.#table.seats.some((seat) => seat.id === payload.seatId)) {
				throw new Error(
					`Log claims seat '${payload.seatId}' more than once at line ${envelope.seq}.`
				);
			}
			if (this.#seatFor(envelope.actor) !== undefined) {
				throw new Error(
					`Log gives actor '${envelope.actor}' more than one seat at line ${envelope.seq}.`
				);
			}
			(
				this.#table.seats as {
					actor: string;
					characterId: string | null;
					id: string;
				}[]
			).push({
				actor: envelope.actor,
				characterId: null,
				id: payload.seatId,
			});
			return;
		}
		if (envelope.type === CORE_CHARACTER_BOUND) {
			const payload = envelope.payload as CharacterBoundPayload;
			const seat = this.#table.seats.find(
				(candidate) => candidate.id === payload.seatId
			);
			if (seat === undefined) {
				throw new Error(
					`Log binds a character to unknown seat '${payload.seatId}' at line ${envelope.seq}.`
				);
			}
			(seat as { characterId: string | null }).characterId =
				payload.characterId;
			return;
		}
		if (envelope.type === CORE_MAP_LOADED) {
			const map = readMapLoadedPayload(envelope.payload);
			if (map === null) {
				throw new Error(
					`Log loads a map with an invalid payload at event ${envelope.seq}.`
				);
			}
			this.#map = map;
			// A token's position means nothing on a different grid, so the surface
			// a load lands on is bare — last-loaded wins (ADR-0006).
			this.#tokens = [];
			return;
		}
		if (envelope.type === CORE_MAP_CLEARED) {
			this.#map = null;
			this.#tokens = [];
			return;
		}
		if (
			envelope.type === CORE_TOKEN_PLACED ||
			envelope.type === CORE_TOKEN_MOVED ||
			envelope.type === CORE_TOKEN_REMOVED
		) {
			const folded = this.#foldToken(envelope.type, envelope.payload);
			if (!folded.ok) {
				throw new Error(
					`Log moves a token at line ${envelope.seq} it cannot apply: ${folded.reason}.`
				);
			}
			if (envelope.type === CORE_TOKEN_PLACED) {
				this.#tokensPlaced += 1;
			}
			this.#tokens = folded.tokens;
			return;
		}
		if (
			envelope.type === CORE_CHAT_POSTED ||
			envelope.type === CORE_DICE_ROLLED
		) {
			// Recognized, and folds to no host state — the table renders them.
			return;
		}
		if (envelope.type.startsWith("core.")) {
			throw tooOld(envelope);
		}
		if (this.#authority === undefined || this.#gameId === undefined) {
			throw new Error(
				`Game event at line ${envelope.seq} appears before room creation.`
			);
		}
		if (!this.#grammar.has(envelope.type)) {
			throw tooOld(envelope);
		}
		const apply = this.#authority.model.apply as (
			state: unknown,
			event: unknown
		) => unknown;
		this.#game = apply(this.#game, joinEvent(envelope));
	}

	async #replay(): Promise<void> {
		let bytes: string;
		try {
			bytes = await readFile(this.#logPath, "utf-8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				return;
			}
			throw error;
		}
		const lines = bytes.split("\n");
		if (lines.at(-1) !== "") {
			throw new Error("Log must end with a newline.");
		}
		lines.pop();
		for (const [index, line] of lines.entries()) {
			if (line === "") {
				throw new Error(`Log contains an empty line at ${index + 1}.`);
			}
			const envelope = JSON.parse(line) as Envelope;
			if (envelope.seq !== index + 1) {
				throw new Error(`Log sequence is invalid at line ${index + 1}.`);
			}
			this.#fold(envelope);
			this.#envelopes.push(envelope);
		}
	}
}
