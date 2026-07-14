import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
	CORE_CHAT_POSTED,
	CORE_DICE_ROLLED,
	CORE_ROOM_CREATED,
	CORE_SEAT_CLAIMED,
} from "@supervillain/core";
import type {
	AuthorityEntry,
	ChatPostedPayload,
	DiceRolledPayload,
	Envelope,
	HostRegistry,
	NamespacedType,
	Rejection,
	RoomCommand,
	RoomCreatedPayload,
	RoomSubmission,
	SeatClaimedPayload,
	TableView,
} from "@supervillain/core";

import { Latch } from "./latch.js";

const LOG_FILE = "events.jsonl";
const DICE_NOTATION =
	/^(?<count>\d*)d(?<sides>\d+)(?:(?<sign>[+-])(?<modifier>\d+))?$/iu;

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
		throw new Error(`Event '${envelope.type}' payload must be an object.`);
	}
	return { type: envelope.type, ...envelope.payload };
};

const isNodeError = (
	error: unknown
): error is Error & { readonly code: string } =>
	error instanceof Error && "code" in error && typeof error.code === "string";

export class RoomHost {
	readonly #logPath: string;
	readonly #registry: HostRegistry;
	readonly #table: TableView = { gmSeatId: "gm", seats: [] };
	readonly #clock: () => string;
	readonly #random: () => number;
	readonly #envelopes: Envelope[] = [];
	readonly #subscribers = new Set<Subscriber>();
	#authority: AuthorityEntry<unknown, unknown, unknown> | undefined;
	#gameId: string | undefined;
	#game: unknown;
	#writeTail: Promise<void> = Promise.resolve();

	private constructor(options: RoomHostOptions) {
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
			seq: this.#envelopes.length,
			table: this.#table,
		};
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
		this.#game = authority.model.init();
	}

	async #submit({ actor, command }: RoomCommand): Promise<RoomSubmission> {
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
				command as Record<string, unknown> & { type: string }
			);
		}
		const decide = this.#authority.authority.decide as (
			state: unknown,
			command: unknown,
			table: TableView
		) => unknown[] | Rejection;
		const decided = decide(this.#game, command, this.#table);
		if (isRejection(decided)) {
			return decided;
		}

		const envelopes: Envelope[] = [];
		for (const event of decided) {
			const { type, payload } = splitEvent(event);
			if (!type.startsWith(`${this.#gameId}.`)) {
				throw new Error(`Game '${this.#gameId}' emitted event '${type}'.`);
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
		command: Record<string, unknown> & { readonly type: string }
	): Promise<RoomSubmission> {
		if (command.type === "core.claim-seat") {
			if (this.#table.seats.some((seat) => seat.actor === actor)) {
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
		if (!this.#table.seats.some((seat) => seat.actor === actor)) {
			return {
				message: "You do not hold a seat at this table.",
				rejected: true,
			};
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

	#fold(envelope: Envelope): void {
		if (envelope.type === CORE_ROOM_CREATED) {
			if (this.#gameId !== undefined) {
				throw new Error("Log creates the room more than once.");
			}
			const payload = envelope.payload as Partial<RoomCreatedPayload>;
			if (typeof payload.gameId !== "string") {
				throw new TypeError("Room creation event has no game id.");
			}
			this.#bind(payload.gameId);
			return;
		}
		if (envelope.type === CORE_SEAT_CLAIMED) {
			const payload = envelope.payload as Partial<SeatClaimedPayload>;
			if (typeof payload.seatId !== "string") {
				throw new TypeError("Seat claim event has no seat id.");
			}
			if (this.#table.seats.some((seat) => seat.id === payload.seatId)) {
				throw new Error(`Log claims seat '${payload.seatId}' more than once.`);
			}
			if (this.#table.seats.some((seat) => seat.actor === envelope.actor)) {
				throw new Error(
					`Log gives actor '${envelope.actor}' more than one seat.`
				);
			}
			(this.#table.seats as { actor: string; id: string }[]).push({
				actor: envelope.actor,
				id: payload.seatId,
			});
			return;
		}
		if (envelope.type.startsWith("core.")) {
			return;
		}
		if (this.#authority === undefined || this.#gameId === undefined) {
			throw new Error("Game event appears before room creation.");
		}
		if (!envelope.type.startsWith(`${this.#gameId}.`)) {
			throw new Error(
				`Log contains event '${envelope.type}' for room game '${this.#gameId}'.`
			);
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
