/**
 * The CLI's half of `supervillain key link` (ADR-0005, re-targeted at the
 * gateway by ADR-0013). It is the Host pipe with no rooms on it: the same dial,
 * the same challenge-signature authentication, the same version handshake, one
 * `link` stream per command.
 *
 * That reuse is the point. The connection's authenticated identity *is* the key
 * being minted for or redeeming, so no request on this wire ever names a key —
 * you cannot mint a code for, or link, somebody else's.
 */
import { handshake } from "./host-pipe.js";
import {
	decodeJson,
	encodeJson,
	LINK_ROOM,
	parseLinkCodeOutcome,
	parseLinkRedemptionOutcome,
	parseRevocationOutcome,
} from "./messages.js";
import type {
	LinkCodeOutcome,
	LinkRedemptionOutcome,
	RevocationOutcome,
} from "./messages.js";
import { MultiplexPipe } from "./pipe.js";
import type { TransportConnection, TransportDialer } from "./seam.js";

export interface GatewayLinkOptions {
	readonly dialer: TransportDialer;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatMisses?: number;
}

/** One short-lived conversation with a gateway about keys. */
export interface GatewayLink {
	/** Mints a device-link code for this machine's identity. */
	readonly mintDeviceCode: () => Promise<LinkCodeOutcome>;
	/** Redeems a code of either kind — the gateway knows what a code maps to. */
	readonly redeem: (code: string) => Promise<LinkRedemptionOutcome>;
	/** Retires another key of this identity — the retire half of rotation
	 * (ADR-0012, NQ-3). Run from a machine you still control. */
	readonly revoke: (key: string) => Promise<RevocationOutcome>;
	readonly close: () => Promise<void>;
}

const closeQuietly = async (connection: TransportConnection): Promise<void> => {
	try {
		await connection.close();
	} catch {
		// The gateway may already have dropped the connection.
	}
};

export const openGatewayLink = async (
	options: GatewayLinkOptions
): Promise<GatewayLink> => {
	const connection = await options.dialer.dial();
	try {
		await handshake(connection);
	} catch (error) {
		await closeQuietly(connection);
		throw error;
	}
	const pipe = new MultiplexPipe({
		connection,
		heartbeatIntervalMs: options.heartbeatIntervalMs,
		heartbeatMisses: options.heartbeatMisses,
		initiator: true,
		onClosed: (): void => undefined,
		// A gateway has nothing to ask a room-less pipe; refuse rather than hang.
		onStream: (stream) => stream.fail("This pipe carries no rooms."),
	});

	const ask = async <T>(
		request: unknown,
		parse: (value: unknown) => T
	): Promise<T> => {
		const stream = pipe.open(LINK_ROOM, "link");
		try {
			await stream.send(encodeJson(request));
			return parse(decodeJson(await stream.receive()));
		} finally {
			stream.close();
		}
	};

	return {
		close: () => pipe.close(),
		mintDeviceCode: () =>
			ask({ mint: "device" } as const, parseLinkCodeOutcome),
		redeem: (code) => ask({ redeem: code }, parseLinkRedemptionOutcome),
		revoke: (key) => ask({ revoke: key }, parseRevocationOutcome),
	};
};
