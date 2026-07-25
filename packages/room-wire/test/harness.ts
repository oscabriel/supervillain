/* oxlint-disable promise/avoid-new, promise/param-names, eslint/no-unused-private-class-members, eslint/require-await, eslint/max-classes-per-file, eslint/prefer-const -- the deterministic duplex transport fake needs explicit deferreds, paired connection/listener classes, and interface-shaped async methods. */
import { TransportListenerClosedError } from "../src/index.js";
import type {
	TransportConnection,
	TransportDialer,
	TransportListener,
} from "../src/index.js";

const testHarness = process.versions.bun
	? await import("bun:test")
	: await import("vitest");
export const { describe, expect, test } = testHarness;

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly reject: (error: unknown) => void;
	readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, reject, resolve };
};

class MemoryConnection implements TransportConnection {
	readonly #incoming: Uint8Array[] = [];
	readonly #receivers: Deferred<Uint8Array>[] = [];
	readonly #remove: () => void;
	#closed = false;
	#peer: MemoryConnection | undefined;
	readonly remoteId: string;

	constructor(remoteId: string, remove: () => void) {
		this.remoteId = remoteId;
		this.#remove = remove;
	}

	pair(peer: MemoryConnection): void {
		this.#peer = peer;
	}

	async send(message: Uint8Array): Promise<void> {
		if (this.#closed || this.#peer?.#closed !== false) {
			throw new Error("Fake transport connection is closed.");
		}
		this.#peer.#deliver(Uint8Array.from(message));
	}

	receive(): Promise<Uint8Array> {
		const next = this.#incoming.shift();
		if (next !== undefined) {
			return Promise.resolve(next);
		}
		if (this.#closed) {
			return Promise.reject(new Error("Fake transport connection is closed."));
		}
		const receiver = deferred<Uint8Array>();
		this.#receivers.push(receiver);
		return receiver.promise;
	}

	async close(): Promise<void> {
		this.#drop();
		this.#peer?.#drop();
	}

	#deliver(message: Uint8Array): void {
		const receiver = this.#receivers.shift();
		if (receiver === undefined) {
			this.#incoming.push(message);
		} else {
			receiver.resolve(message);
		}
	}

	#drop(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#remove();
		for (const receiver of this.#receivers.splice(0)) {
			receiver.reject(new Error("Fake transport connection is closed."));
		}
	}
}

class MemoryListener implements TransportListener {
	readonly #accepted: MemoryConnection[] = [];
	readonly #acceptors: Deferred<TransportConnection>[] = [];
	readonly #connections = new Set<MemoryConnection>();
	readonly #id: string;
	#closed = false;

	constructor(id: string) {
		this.#id = id;
	}

	get id(): string {
		return this.#id;
	}

	get isClosed(): boolean {
		return this.#closed;
	}

	accept(): Promise<TransportConnection> {
		const connection = this.#accepted.shift();
		if (connection !== undefined) {
			return Promise.resolve(connection);
		}
		if (this.#closed) {
			return Promise.reject(new TransportListenerClosedError());
		}
		const acceptor = deferred<TransportConnection>();
		this.#acceptors.push(acceptor);
		return acceptor.promise;
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		await this.dropConnections();
		for (const acceptor of this.#acceptors.splice(0)) {
			acceptor.reject(new TransportListenerClosedError());
		}
	}

	async dropConnections(): Promise<void> {
		await Promise.all(
			[...this.#connections].map((connection) => connection.close())
		);
	}

	track(connection: MemoryConnection): void {
		this.#connections.add(connection);
	}

	untrack(connection: MemoryConnection): void {
		this.#connections.delete(connection);
	}

	enqueue(connection: MemoryConnection): void {
		const acceptor = this.#acceptors.shift();
		if (acceptor === undefined) {
			this.#accepted.push(connection);
		} else {
			acceptor.resolve(connection);
		}
	}
}

class MemoryDialer implements TransportDialer {
	readonly #connections = new Set<MemoryConnection>();
	readonly #id: string;
	readonly #listener: MemoryListener;

	constructor(id: string, listener: MemoryListener) {
		this.#id = id;
		this.#listener = listener;
	}

	async dial(): Promise<TransportConnection> {
		if (this.#listener.isClosed) {
			throw new Error("Fake transport address is unreachable.");
		}
		let outbound!: MemoryConnection;
		let inbound!: MemoryConnection;
		outbound = new MemoryConnection(this.#listener.id, () =>
			this.#connections.delete(outbound)
		);
		inbound = new MemoryConnection(this.#id, () =>
			this.#listener.untrack(inbound)
		);
		outbound.pair(inbound);
		inbound.pair(outbound);
		this.#connections.add(outbound);
		this.#listener.track(inbound);
		this.#listener.enqueue(inbound);
		return outbound;
	}

	async dropConnections(): Promise<void> {
		await Promise.all(
			[...this.#connections].map((connection) => connection.close())
		);
	}
}

export interface MemoryTransportPair {
	readonly dialer: TransportDialer & {
		readonly dropConnections: () => Promise<void>;
	};
	readonly listener: TransportListener & {
		readonly dropConnections: () => Promise<void>;
	};
}

/** One dialer wired to one listener — the seam with no sockets underneath. */
export const createMemoryTransportPair = (
	clientId = "client-id",
	serverId = "server-id"
): MemoryTransportPair => {
	const listener = new MemoryListener(serverId);
	return { dialer: new MemoryDialer(clientId, listener), listener };
};
