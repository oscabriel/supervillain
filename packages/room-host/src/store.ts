import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import type { RoomHost } from "./room-host.js";

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
