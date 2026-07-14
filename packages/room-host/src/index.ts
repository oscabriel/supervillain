import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AuthorityEntry,
  Envelope,
  HostRegistry,
  NamespacedType,
  Rejection,
  RoomCommand,
  RoomStore,
  RoomSubmission,
  TableView,
} from "@supervillain/core";

const LOG_FILE = "events.jsonl";
const ROOM_CREATED = "core.room-created";

interface RoomCreatedPayload {
  readonly gameId: string;
}

export interface RoomHostOptions {
  readonly campaignFolder: string;
  readonly registry: HostRegistry;
  readonly table: TableView;
  readonly gameId?: string;
  readonly actor?: string;
  readonly clock?: () => string;
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

export class RoomHost {
  readonly #logPath: string;
  readonly #registry: HostRegistry;
  readonly #table: TableView;
  readonly #clock: () => string;
  readonly #envelopes: Envelope[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #authority: AuthorityEntry<unknown, unknown, unknown> | undefined;
  #gameId: string | undefined;
  #game: unknown;
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(options: RoomHostOptions) {
    this.#logPath = join(options.campaignFolder, LOG_FILE);
    this.#registry = options.registry;
    this.#table = options.table;
    this.#clock = options.clock ?? (() => new Date().toISOString());
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
        throw new Error(`No game authority is registered for '${options.gameId}'.`);
      }
      await host.#append({
        actor: options.actor,
        seq: 1,
        timestamp: host.#clock(),
        type: ROOM_CREATED,
        payload: { gameId: options.gameId } satisfies RoomCreatedPayload,
      });
    } else if (options.gameId !== undefined && options.gameId !== host.#gameId) {
      throw new Error(
        `Campaign folder is bound to game '${host.#gameId}', not '${options.gameId}'.`,
      );
    }

    return host;
  }

  snapshot(): RoomSnapshot {
    if (this.#gameId === undefined) {
      throw new Error("Room has not been created.");
    }
    return {
      gameId: this.#gameId,
      game: this.#game,
      table: this.#table,
      seq: this.#envelopes.length,
    };
  }

  submit(command: RoomCommand): Promise<RoomSubmission> {
    const result = this.#writeTail.then(() => this.#submit(command));
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
        let wake: (() => void) | undefined;
        let stopped = false;
        const subscriber: Subscriber = {
          afterSeq: envelopes.length,
          push(envelope) {
            pending.push(envelope);
            wake?.();
            wake = undefined;
          },
        };
        subscribers.add(subscriber);

        try {
          for (const envelope of envelopes) {
            if (envelope.seq >= fromSeq && envelope.seq <= subscriber.afterSeq) {
              yield envelope;
            }
          }
          while (!stopped) {
            if (pending.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            while (pending.length > 0) {
              const envelope = pending.shift();
              if (envelope !== undefined && envelope.seq >= fromSeq) yield envelope;
            }
          }
        } finally {
          stopped = true;
          subscribers.delete(subscriber);
          wake?.();
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
    const decide = this.#authority.authority.decide as (
      state: unknown,
      command: unknown,
      table: TableView,
    ) => unknown[] | Rejection;
    const decided = decide(this.#game, command, this.#table);
    if (isRejection(decided)) return decided;

    const envelopes: Envelope[] = [];
    for (const event of decided) {
      const { type, payload } = splitEvent(event);
      if (!type.startsWith(`${this.#gameId}.`)) {
        throw new Error(`Game '${this.#gameId}' emitted event '${type}'.`);
      }
      const envelope: Envelope = {
        actor,
        seq: this.#envelopes.length + 1,
        timestamp: this.#clock(),
        type,
        payload,
      };
      await this.#append(envelope);
      envelopes.push(envelope);
    }
    return { accepted: true, envelopes };
  }

  async #append(envelope: Envelope): Promise<void> {
    const file = await open(this.#logPath, "a");
    try {
      await file.write(`${JSON.stringify(envelope)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    this.#fold(envelope);
    this.#envelopes.push(envelope);
    for (const subscriber of this.#subscribers) subscriber.push(envelope);
  }

  #fold(envelope: Envelope): void {
    if (envelope.type === ROOM_CREATED) {
      if (this.#gameId !== undefined) throw new Error("Log creates the room more than once.");
      const payload = envelope.payload as Partial<RoomCreatedPayload>;
      if (typeof payload.gameId !== "string") {
        throw new Error("Room creation event has no game id.");
      }
      this.#bind(payload.gameId);
      return;
    }
    if (envelope.type.startsWith("core.")) return;
    if (this.#authority === undefined || this.#gameId === undefined) {
      throw new Error("Game event appears before room creation.");
    }
    if (!envelope.type.startsWith(`${this.#gameId}.`)) {
      throw new Error(`Log contains event '${envelope.type}' for room game '${this.#gameId}'.`);
    }
    const apply = this.#authority.model.apply as (state: unknown, event: unknown) => unknown;
    this.#game = apply(this.#game, joinEvent(envelope));
  }

  async #replay(): Promise<void> {
    let bytes: string;
    try {
      bytes = await readFile(this.#logPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    const lines = bytes.split("\n");
    if (lines.at(-1) !== "") throw new Error("Log must end with a newline.");
    lines.pop();
    for (const [index, line] of lines.entries()) {
      if (line === "") throw new Error(`Log contains an empty line at ${index + 1}.`);
      const envelope = JSON.parse(line) as Envelope;
      if (envelope.seq !== index + 1) {
        throw new Error(`Log sequence is invalid at line ${index + 1}.`);
      }
      this.#fold(envelope);
      this.#envelopes.push(envelope);
    }
  }
}

export class InProcessRoomStore implements RoomStore {
  readonly #host: RoomHost;

  constructor(host: RoomHost) {
    this.#host = host;
  }

  submit(command: RoomCommand): Promise<RoomSubmission> {
    return this.#host.submit(command);
  }

  stream(fromSeq: number): AsyncIterable<Envelope> {
    return this.#host.stream(fromSeq);
  }
}

function isRejection(value: readonly unknown[] | Rejection): value is Rejection {
  return !Array.isArray(value);
}

function splitEvent(event: unknown): { readonly type: NamespacedType; readonly payload: unknown } {
  if (typeof event !== "object" || event === null || !("type" in event)) {
    throw new Error("Game authority emitted an event without a namespaced type.");
  }
  const { type, ...payload } = event as { readonly type: unknown; readonly [key: string]: unknown };
  if (typeof type !== "string" || !type.includes(".")) {
    throw new Error("Game authority emitted an event without a namespaced type.");
  }
  return { type: type as NamespacedType, payload };
}

function joinEvent(envelope: Envelope): unknown {
  if (typeof envelope.payload !== "object" || envelope.payload === null) {
    throw new Error(`Event '${envelope.type}' payload must be an object.`);
  }
  return { type: envelope.type, ...envelope.payload };
}

function isNodeError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
