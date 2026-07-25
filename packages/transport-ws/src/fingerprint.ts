import { createHash } from "node:crypto";

import { InvalidPairingCodeError, InvalidTransportUrlError } from "./errors.js";

/** The one hash the pairing code speaks. Named on the wire so a future second
 * algorithm is a parse branch rather than a silent reinterpretation. */
export const FINGERPRINT_ALGORITHM = "sha256";

const HEX_FINGERPRINT = /^[0-9a-f]{64}$/u;
const SEPARATORS = /[\s:]/gu;
const PEM_BODY =
	/-----BEGIN CERTIFICATE-----(?<body>[\sA-Za-z0-9+/=]+)-----END CERTIFICATE-----/u;
const WHITESPACE = /\s/gu;

/** How the fingerprint is written wherever a human might type it. */
export const FINGERPRINT_RULE =
	"A certificate fingerprint is 64 hex characters — the SHA-256 of the certificate. Colons and capitals are accepted.";

/** Accepts the shapes a fingerprint arrives in — bare hex, OpenSSL's
 * colon-separated capitals, or an algorithm-prefixed form — and returns the one
 * canonical shape everything downstream compares. */
export const normalizeFingerprint = (value: string): string | undefined => {
	const withoutAlgorithm = value.trim().toLowerCase().startsWith("sha256:")
		? value.trim().slice("sha256:".length)
		: value.trim();
	const canonical = withoutAlgorithm.replaceAll(SEPARATORS, "").toLowerCase();
	return HEX_FINGERPRINT.test(canonical) ? canonical : undefined;
};

/** The SHA-256 of a certificate's DER bytes — the same number OpenSSL prints
 * as `-fingerprint -sha256`, minus the colons. */
export const fingerprintOfDer = (der: Uint8Array): string =>
	createHash("sha256").update(der).digest("hex");

export const fingerprintOfPem = (certificatePem: string): string => {
	const body = PEM_BODY.exec(certificatePem)?.groups?.body;
	if (body === undefined) {
		throw new Error("Certificate is not PEM-encoded.");
	}
	return fingerprintOfDer(
		Buffer.from(body.replaceAll(WHITESPACE, ""), "base64")
	);
};

/** Where a Host is told to dial, and — for a self-hosted gateway with no CA —
 * which certificate it must find there. A hosted gateway's code carries no
 * fingerprint: a real certificate is checked against the machine's CA store. */
export interface GatewayPairing {
	/** The `ws:` or `wss:` URL to dial, fragment stripped. */
	readonly url: string;
	/** 64 lowercase hex chars, or undefined for a CA-checked gateway. */
	readonly fingerprint: string | undefined;
}

const FRAGMENT_KEY = "fp";

/**
 * Writes the Host-onboarding pairing code: the gateway URL with its certificate
 * fingerprint riding in the fragment (ADR-0012, NQ-9). One pasteable string, and
 * a superset of the plain URL `--gateway` already takes — the URL half is #57's,
 * the fingerprint half is this seam's.
 */
export const formatPairingCode = (url: string, fingerprint: string): string => {
	const canonical = normalizeFingerprint(fingerprint);
	if (canonical === undefined) {
		throw new Error(FINGERPRINT_RULE);
	}
	const parsed = new URL(url);
	parsed.hash = "";
	return `${parsed.toString()}#${FRAGMENT_KEY}=${FINGERPRINT_ALGORITHM}:${canonical}`;
};

/**
 * Reads a pairing code, or a bare gateway URL. Rejects a fragment it does not
 * understand rather than dialing on: a fingerprint the reader silently drops is
 * the one failure trust-on-first-use cannot survive.
 */
export const parsePairingCode = (code: string): GatewayPairing => {
	const trimmed = code.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new InvalidTransportUrlError(trimmed);
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new InvalidTransportUrlError(trimmed);
	}
	const fragment = parsed.hash.replace(/^#/u, "");
	parsed.hash = "";
	const url = parsed.toString();
	if (fragment === "") {
		return { fingerprint: undefined, url };
	}
	const [key, ...rest] = fragment.split("=");
	if (key !== FRAGMENT_KEY) {
		throw new InvalidPairingCodeError(
			`'${fragment}' is not a fingerprint. A pairing code ends with '#${FRAGMENT_KEY}=${FINGERPRINT_ALGORITHM}:<64 hex chars>'.`
		);
	}
	const value = rest.join("=");
	if (!value.toLowerCase().startsWith(`${FINGERPRINT_ALGORITHM}:`)) {
		throw new InvalidPairingCodeError(
			`fingerprint algorithm in '${fragment}' is not ${FINGERPRINT_ALGORITHM}.`
		);
	}
	const fingerprint = normalizeFingerprint(value);
	if (fingerprint === undefined) {
		throw new InvalidPairingCodeError(FINGERPRINT_RULE);
	}
	return { fingerprint, url };
};

/** The stable key a pinned fingerprint is filed under: scheme, host, and port,
 * so a path change never silently re-pairs and never loses the pin. */
export const gatewayOrigin = (url: string): string => {
	const parsed = new URL(url);
	return `${parsed.protocol}//${parsed.host}`;
};
