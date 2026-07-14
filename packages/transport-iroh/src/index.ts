import type { Connection as NativeConnection, Endpoint as NativeEndpoint } from "@number0/iroh";

import { loadIrohNative } from "./native.js";

const ALPN = Array.from(new TextEncoder().encode("supervillain/transport/1"));
const CLOSE_CODE = 0n;
const CLOSE_REASON = Array.from(new TextEncoder().encode("closed"));
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

declare const transportAddressBrand: unique symbol;

/** An opaque, serializable address for dialing a transport endpoint. */
export type TransportAddress = string & {
  readonly [transportAddressBrand]: true;
};

export type TransportRoute = "direct" | "relay" | "unknown";

/** A framed, bidirectional message connection. */
export interface TransportConnection {
  readonly route: TransportRoute;
  send(message: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** A local transport endpoint which can dial and accept peer connections. */
export interface TransportEndpoint {
  readonly address: TransportAddress;
  dial(address: TransportAddress): Promise<TransportConnection>;
  accept(): Promise<TransportConnection>;
  close(): Promise<void>;
}

export interface IrohEndpointOptions {
  /**
   * `direct` disables relays. `relay` publishes no direct addresses so the initial
   * connection must use a relay. `adaptive` lets iroh choose and is the default.
   */
  readonly routing?: "adaptive" | "direct" | "relay";
}

class IrohConnection implements TransportConnection {
  readonly #connection: NativeConnection;
  readonly #onClose: () => void;
  #closed = false;

  constructor(connection: NativeConnection, onClose: () => void) {
    this.#connection = connection;
    this.#onClose = onClose;
  }

  get route(): TransportRoute {
    const selected = this.#connection.paths().find((path) => path.isSelected);
    if (selected?.isRelay === true) return "relay";
    if (selected?.isIp === true) return "direct";
    return "unknown";
  }

  async send(message: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("Transport connection is closed");
    if (message.byteLength > MAX_MESSAGE_BYTES) {
      throw new RangeError(`Transport message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }

    const frame = new Uint8Array(4 + message.byteLength);
    new DataView(frame.buffer).setUint32(0, message.byteLength, false);
    frame.set(message, 4);

    const stream = await this.#connection.openUni();
    await stream.writeAll(Array.from(frame));
    await stream.finish();
  }

  async receive(): Promise<Uint8Array> {
    if (this.#closed) throw new Error("Transport connection is closed");

    const stream = await this.#connection.acceptUni();
    const header = Uint8Array.from(await stream.readExact(4));
    const length = new DataView(header.buffer).getUint32(0, false);
    if (length > MAX_MESSAGE_BYTES) {
      await stream.stop(1n);
      throw new RangeError(`Transport message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
    if (length === 0) return new Uint8Array();
    return Uint8Array.from(await stream.readExact(length));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close(CLOSE_CODE, CLOSE_REASON);
    try {
      await this.#connection.closed();
    } finally {
      this.#onClose();
    }
  }
}

class IrohEndpoint implements TransportEndpoint {
  readonly #endpoint: NativeEndpoint;
  readonly #connections = new Set<IrohConnection>();
  readonly address: TransportAddress;
  #closed = false;

  constructor(endpoint: NativeEndpoint, address: TransportAddress) {
    this.#endpoint = endpoint;
    this.address = address;
  }

  async dial(address: TransportAddress): Promise<TransportConnection> {
    this.#assertOpen();
    const { EndpointTicket } = loadIrohNative();
    let remoteAddress;
    try {
      remoteAddress = EndpointTicket.fromString(address).endpointAddr();
    } catch (cause) {
      throw new Error("Invalid transport address", { cause });
    }

    const connection = await this.#endpoint.connect(remoteAddress, ALPN);
    return this.#track(connection);
  }

  async accept(): Promise<TransportConnection> {
    this.#assertOpen();
    const incoming = await this.#endpoint.acceptNext();
    if (incoming === null) throw new Error("Transport endpoint closed while accepting");
    const connection = await (await incoming.accept()).connect();
    return this.#track(connection);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#connections].map(async (connection) => connection.close()));
    this.#connections.clear();
    await this.#endpoint.close();
  }

  #track(connection: NativeConnection): IrohConnection {
    const wrapped = new IrohConnection(connection, () => this.#connections.delete(wrapped));
    this.#connections.add(wrapped);
    return wrapped;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Transport endpoint is closed");
  }
}

/** Opens an iroh-backed endpoint behind the transport seam. */
export async function openIrohEndpoint(
  options: IrohEndpointOptions = {},
): Promise<TransportEndpoint> {
  const { Endpoint, EndpointAddr, EndpointTicket, RelayMode } = loadIrohNative();
  const routing = options.routing ?? "adaptive";
  const builder = Endpoint.builder();
  if (routing === "adaptive") builder.applyN0();
  else builder.applyMinimal();
  builder.alpns([ALPN]);
  builder.relayMode(routing === "direct" ? RelayMode.disabled() : RelayMode.defaultMode());
  const endpoint = await builder.bind();

  try {
    if (routing === "relay") await endpoint.online();
    const boundAddress = endpoint.addr();
    const relayUrl = boundAddress.relayUrl();
    if (routing === "relay" && relayUrl === null) {
      throw new Error("Iroh endpoint came online without a home relay");
    }
    const advertisedAddress =
      routing === "relay" ? new EndpointAddr(boundAddress.id(), relayUrl, []) : boundAddress;
    const address = EndpointTicket.fromAddr(advertisedAddress).toString() as TransportAddress;
    return new IrohEndpoint(endpoint, address);
  } catch (error) {
    await endpoint.close();
    throw error;
  }
}
