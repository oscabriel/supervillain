import type {
	Connection as NativeConnection,
	Endpoint as NativeEndpoint,
} from "@number0/iroh";

import { IrohConnection } from "./connection.js";
import { DialTimeoutError, SelfDialError } from "./errors.js";
import { loadIrohNative } from "./native.js";
import type {
	IrohEndpointOptions,
	TransportAddress,
	TransportConnection,
	TransportEndpoint,
} from "./seam.js";

export { DialTimeoutError, SelfDialError } from "./errors.js";
export { provideIrohNative } from "./native.js";
export type { IrohNative } from "./native.js";
export type {
	IrohEndpointOptions,
	TransportAddress,
	TransportConnection,
	TransportEndpoint,
	TransportRoute,
} from "./seam.js";

const ALPN = [...new TextEncoder().encode("supervillain/transport/1")];
const DEFAULT_DIAL_TIMEOUT_MS = 5000;
const HEX_KEY = /^[0-9a-f]{64}$/u;

class IrohEndpoint implements TransportEndpoint {
	readonly #dialTimeoutMs: number;
	readonly #endpoint: NativeEndpoint;
	readonly #connections = new Set<IrohConnection>();
	readonly address: TransportAddress;
	#closed = false;

	constructor(
		endpoint: NativeEndpoint,
		address: TransportAddress,
		dialTimeoutMs: number
	) {
		this.#endpoint = endpoint;
		this.address = address;
		this.#dialTimeoutMs = dialTimeoutMs;
	}

	async dial(address: TransportAddress): Promise<TransportConnection> {
		this.#assertOpen();
		const { EndpointTicket } = loadIrohNative();
		let remoteAddress;
		try {
			remoteAddress = EndpointTicket.fromString(address).endpointAddr();
		} catch (error) {
			throw new Error("Invalid transport address", { cause: error });
		}
		if (remoteAddress.id().equals(this.#endpoint.id())) {
			throw new SelfDialError();
		}

		const pendingConnection = this.#endpoint.connect(remoteAddress, ALPN);
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timeout.reject(new DialTimeoutError(this.#dialTimeoutMs)),
			this.#dialTimeoutMs
		);
		try {
			const connection = await Promise.race([
				pendingConnection,
				timeout.promise,
			]);
			return this.#track(connection);
		} catch (error) {
			if (error instanceof DialTimeoutError) {
				void this.#closeLateConnection(pendingConnection);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async accept(): Promise<TransportConnection> {
		this.#assertOpen();
		const incoming = await this.#endpoint.acceptNext();
		if (incoming === null) {
			throw new Error("Transport endpoint closed while accepting");
		}
		const accepted = await incoming.accept();
		const connection = await accepted.connect();
		return this.#track(connection);
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		await Promise.all(
			[...this.#connections].map((connection) => connection.close())
		);
		this.#connections.clear();
		await this.#endpoint.close();
	}

	async #closeLateConnection(
		pendingConnection: Promise<NativeConnection>
	): Promise<void> {
		try {
			const connection = await pendingConnection;
			await this.#track(connection).close();
		} catch {
			// A connect that eventually fails has no connection to clean up.
		}
	}

	#track(connection: NativeConnection): IrohConnection {
		const wrapped = new IrohConnection(connection, () =>
			this.#connections.delete(wrapped)
		);
		this.#connections.add(wrapped);
		return wrapped;
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new Error("Transport endpoint is closed");
		}
	}
}

/** Opens an iroh-backed endpoint behind the transport seam. */
export const openIrohEndpoint = async (
	options: IrohEndpointOptions = {}
): Promise<TransportEndpoint> => {
	const { Endpoint, EndpointAddr, EndpointTicket, RelayMode } =
		loadIrohNative();
	const routing = options.routing ?? "adaptive";
	const builder = Endpoint.builder();
	if (routing === "adaptive") {
		builder.applyN0();
	} else {
		builder.applyMinimal();
	}
	if (options.secretKeyHex !== undefined) {
		if (!HEX_KEY.test(options.secretKeyHex)) {
			throw new Error("secretKeyHex must be 64 lowercase hex chars.");
		}
		builder.secretKey([...Buffer.from(options.secretKeyHex, "hex")]);
	}
	builder.alpns([ALPN]);
	builder.relayMode(
		routing === "direct" ? RelayMode.disabled() : RelayMode.defaultMode()
	);
	const endpoint = await builder.bind();

	try {
		if (routing === "relay") {
			await endpoint.online();
		}
		const boundAddress = endpoint.addr();
		const relayUrl = boundAddress.relayUrl();
		if (routing === "relay" && relayUrl === null) {
			throw new Error("Iroh endpoint came online without a home relay");
		}
		const advertisedAddress =
			routing === "relay"
				? new EndpointAddr(boundAddress.id(), relayUrl, [])
				: boundAddress;
		const address = EndpointTicket.fromAddr(
			advertisedAddress
		).toString() as TransportAddress;
		return new IrohEndpoint(
			endpoint,
			address,
			options.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS
		);
	} catch (error) {
		await endpoint.close();
		throw error;
	}
};
