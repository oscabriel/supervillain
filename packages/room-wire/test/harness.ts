/* oxlint-disable promise/avoid-new, promise/param-names, eslint/no-unused-private-class-members, eslint/require-await, eslint/max-classes-per-file, eslint/prefer-const -- the deterministic duplex transport fake needs explicit deferreds, paired connection/endpoint classes, and interface-shaped async methods. */
import type {
	TransportAddress,
	TransportConnection,
	TransportEndpoint,
} from "@supervillain/transport-iroh";

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
	readonly route = "direct" as const;

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

class MemoryEndpoint implements TransportEndpoint {
	readonly #accepted: MemoryConnection[] = [];
	readonly #acceptors: Deferred<TransportConnection>[] = [];
	readonly #connections = new Set<MemoryConnection>();
	readonly #network: Map<string, MemoryEndpoint>;
	readonly #id: string;
	#closed = false;
	readonly address: TransportAddress;

	constructor(id: string, network: Map<string, MemoryEndpoint>) {
		this.#id = id;
		this.#network = network;
		this.address = `memory:${id}` as TransportAddress;
		network.set(this.address, this);
	}

	async dial(address: TransportAddress): Promise<TransportConnection> {
		if (this.#closed) {
			throw new Error("Fake transport endpoint is closed.");
		}
		const remote = this.#network.get(address);
		if (remote === undefined || remote.#closed) {
			throw new Error("Fake transport address is unreachable.");
		}
		let outbound!: MemoryConnection;
		let inbound!: MemoryConnection;
		outbound = new MemoryConnection(remote.#id, () =>
			this.#connections.delete(outbound)
		);
		inbound = new MemoryConnection(this.#id, () =>
			remote.#connections.delete(inbound)
		);
		outbound.pair(inbound);
		inbound.pair(outbound);
		this.#connections.add(outbound);
		remote.#connections.add(inbound);
		remote.#enqueue(inbound);
		return outbound;
	}

	accept(): Promise<TransportConnection> {
		const connection = this.#accepted.shift();
		if (connection !== undefined) {
			return Promise.resolve(connection);
		}
		if (this.#closed) {
			return Promise.reject(
				new Error("Transport endpoint closed while accepting")
			);
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
		this.#network.delete(this.address);
		await Promise.all(
			[...this.#connections].map((connection) => connection.close())
		);
		for (const acceptor of this.#acceptors.splice(0)) {
			acceptor.reject(new Error("Transport endpoint closed while accepting"));
		}
	}

	async dropConnections(): Promise<void> {
		await Promise.all(
			[...this.#connections].map((connection) => connection.close())
		);
	}

	#enqueue(connection: MemoryConnection): void {
		const acceptor = this.#acceptors.shift();
		if (acceptor === undefined) {
			this.#accepted.push(connection);
		} else {
			acceptor.resolve(connection);
		}
	}
}

export interface MemoryEndpointPair {
	readonly client: TransportEndpoint & {
		readonly dropConnections: () => Promise<void>;
	};
	readonly server: TransportEndpoint & {
		readonly dropConnections: () => Promise<void>;
	};
}

export const createMemoryEndpointPair = (
	clientId = "client-id",
	serverId = "server-id"
): MemoryEndpointPair => {
	const network = new Map<string, MemoryEndpoint>();
	return {
		client: new MemoryEndpoint(clientId, network),
		server: new MemoryEndpoint(serverId, network),
	};
};
