/* oxlint-disable promise/avoid-new -- a TLS connection is event-shaped; the one promise here is its handshake. */
import { connect } from "node:tls";

import { CertificateMismatchError } from "./errors.js";
import { fingerprintOfDer } from "./fingerprint.js";

const DEFAULT_TLS_PORT = 443;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/u;

/** SNI carries a name, and a homelab gateway is often reached by bare address.
 * An IP there is a TypeError, not a warning. */
const serverName = (hostname: string): string | undefined =>
	IP_LITERAL.test(hostname) ? undefined : hostname;

/** The certificate a gateway is actually serving, read before anything of ours
 * is sent to it. */
export interface ServedCertificate {
	readonly fingerprint: string;
	readonly certificatePem: string;
}

const toPem = (der: Uint8Array): string => {
	const lines =
		Buffer.from(der)
			.toString("base64")
			.match(/.{1,64}/gu) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
};

/**
 * Reads the certificate a `wss:` endpoint serves, over its own throwaway TLS
 * connection with verification off — the only way to see a certificate that
 * chains to nothing. Nothing is trusted on the strength of this connection: the
 * caller compares the fingerprint, and the *real* dial then trusts this exact
 * certificate and nothing else, so a second certificate swapped in afterwards
 * fails the handshake rather than sneaking through.
 *
 * `getPeerCertificate().raw` is the one certificate surface Bun and Node agree
 * on; the WebSocket clients do not agree, which is why this is a separate step.
 */
export const readServedCertificate = async (
	url: string
): Promise<ServedCertificate> => {
	const parsed = new URL(url);
	const port = parsed.port === "" ? DEFAULT_TLS_PORT : Number(parsed.port);
	const raw = await new Promise<Uint8Array>((resolve, reject) => {
		const socket = connect(
			{
				host: parsed.hostname,
				port,
				rejectUnauthorized: false,
				servername: serverName(parsed.hostname),
			},
			() => {
				const peer = socket.getPeerCertificate();
				socket.destroy();
				if (peer.raw === undefined) {
					reject(new Error(`No certificate was served by ${url}.`));
					return;
				}
				resolve(new Uint8Array(peer.raw));
			}
		);
		socket.setTimeout(PREFLIGHT_TIMEOUT_MS, () => {
			socket.destroy(new Error(`Reading the certificate of ${url} timed out.`));
		});
		socket.on("error", reject);
	});
	return { certificatePem: toPem(raw), fingerprint: fingerprintOfDer(raw) };
};

/**
 * Trust-on-first-use, enforced. Returns the certificate to hand the dial as its
 * one trust anchor; throws loudly when the gateway's certificate is not the
 * pinned one.
 */
export const certificateForPin = async (
	url: string,
	expectedFingerprint: string
): Promise<ServedCertificate> => {
	const served = await readServedCertificate(url);
	if (served.fingerprint !== expectedFingerprint) {
		throw new CertificateMismatchError(
			url,
			expectedFingerprint,
			served.fingerprint
		);
	}
	return served;
};
