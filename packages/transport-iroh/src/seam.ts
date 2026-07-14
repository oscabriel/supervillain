declare const transportAddressBrand: unique symbol;

/** An opaque, serializable address for dialing a transport endpoint. */
export type TransportAddress = string & {
	readonly [transportAddressBrand]: true;
};

export type TransportRoute = "direct" | "relay" | "unknown";

/** A framed, bidirectional message connection. */
export interface TransportConnection {
	readonly route: TransportRoute;
	readonly send: (message: Uint8Array) => Promise<void>;
	readonly receive: () => Promise<Uint8Array>;
	readonly close: () => Promise<void>;
}

/** A local transport endpoint which can dial and accept peer connections. */
export interface TransportEndpoint {
	readonly address: TransportAddress;
	readonly dial: (address: TransportAddress) => Promise<TransportConnection>;
	readonly accept: () => Promise<TransportConnection>;
	readonly close: () => Promise<void>;
}

export interface IrohEndpointOptions {
	/**
	 * `direct` disables relays. `relay` publishes no direct addresses so the initial
	 * connection must use a relay. `adaptive` lets iroh choose and is the default.
	 */
	readonly routing?: "adaptive" | "direct" | "relay";
}
