import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import {
	fingerprintOfPem,
	formatPairingCode,
	mintSelfSignedCertificate,
} from "@supervillain/transport-ws/server";
import type { WsListenerTls } from "@supervillain/transport-ws/server";

const CERTIFICATE_FILE = "pipe-cert.pem";
const PRIVATE_KEY_FILE = "pipe-key.pem";

/** Where the Host pipe's TLS ends (ADR-0014).
 *
 * - `self-signed` — this process terminates TLS with a certificate it minted
 *   itself and keeps in its state directory. No CA, no domain, no proxy: the
 *   self-hosted posture of ADR-0012 NQ-9, and the default, because a gateway
 *   started with no arguments must not carry production traffic in the clear.
 * - `terminated-upstream` — something in front already terminated TLS and
 *   forwards plaintext over loopback. This is the hosted posture: Caddy owns
 *   443 on the one box (#40) and reverse-proxies the pipe.
 * - `files` — this process terminates TLS with a certificate an operator
 *   supplied. Pinning is deliberately absent here: a CA-issued certificate is
 *   verified against the machine's trust store and is expected to be renewed,
 *   and a pinned fingerprint would turn every renewal into a refusal. */
export type GatewayTlsMode = "self-signed" | "terminated-upstream" | "files";

export type GatewayTlsOptions =
	| { readonly mode: "self-signed" }
	| { readonly mode: "terminated-upstream" }
	| {
			readonly mode: "files";
			readonly certificatePath: string;
			readonly privateKeyPath: string;
	  };

/** What the pipe's TLS posture resolved to: what the listener terminates with,
 * and — only where trust comes from a pin rather than a CA — the fingerprint a
 * pairing code must carry. */
export interface ResolvedGatewayTls {
	readonly mode: GatewayTlsMode;
	readonly listenerTls: WsListenerTls | undefined;
	readonly fingerprint: string | undefined;
	/** True when this process is the TLS edge, which is also when its pipe port
	 * is the one an operator forwards. */
	readonly terminatesHere: boolean;
}

const readIfPresent = async (file: string): Promise<string | undefined> => {
	try {
		return await readFile(file, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
};

/**
 * Loads the gateway's own certificate, minting one on first start. It is kept
 * because a Host pins it: a certificate re-minted every restart would refuse
 * every Host that had ever paired, which is the loud failure TOFU exists to
 * raise and exactly the wrong thing to raise at ourselves.
 */
export const loadOrMintPipeCertificate = async (
	stateDir: string
): Promise<WsListenerTls> => {
	const certificateFile = path.join(stateDir, CERTIFICATE_FILE);
	const privateKeyFile = path.join(stateDir, PRIVATE_KEY_FILE);
	const [certificatePem, privateKeyPem] = await Promise.all([
		readIfPresent(certificateFile),
		readIfPresent(privateKeyFile),
	]);
	if (certificatePem !== undefined && privateKeyPem !== undefined) {
		return { certificatePem, privateKeyPem };
	}
	await mkdir(stateDir, { recursive: true });
	// The names are cosmetic — a self-signed gateway is identified by its
	// fingerprint, never by a name a dialer of ours checks.
	const minted = mintSelfSignedCertificate({
		hosts: ["localhost", "127.0.0.1", hostname()],
	});
	await writeFile(certificateFile, minted.certificatePem, { mode: 0o644 });
	await writeFile(privateKeyFile, minted.privateKeyPem, { mode: 0o600 });
	return {
		certificatePem: minted.certificatePem,
		privateKeyPem: minted.privateKeyPem,
	};
};

export const resolveGatewayTls = async (
	stateDir: string,
	options: GatewayTlsOptions
): Promise<ResolvedGatewayTls> => {
	if (options.mode === "terminated-upstream") {
		return {
			fingerprint: undefined,
			listenerTls: undefined,
			mode: options.mode,
			terminatesHere: false,
		};
	}
	if (options.mode === "files") {
		const [certificatePem, privateKeyPem] = await Promise.all([
			readFile(options.certificatePath, "utf-8"),
			readFile(options.privateKeyPath, "utf-8"),
		]);
		return {
			fingerprint: undefined,
			listenerTls: { certificatePem, privateKeyPem },
			mode: options.mode,
			terminatesHere: true,
		};
	}
	const listenerTls = await loadOrMintPipeCertificate(stateDir);
	return {
		fingerprint: fingerprintOfPem(listenerTls.certificatePem),
		listenerTls,
		mode: options.mode,
		terminatesHere: true,
	};
};

const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]", ""]);

/** What the operator is told to hand their Hosts. Undefined when the address
 * Hosts reach this box at is not something the process can know — a wildcard
 * bind behind a port forward — because a pairing code naming `0.0.0.0` is worse
 * than no pairing code at all. */
export const pipePairingCode = (options: {
	readonly advertisedUrl: string | undefined;
	readonly boundUrl: string;
	readonly bindHost: string;
	readonly fingerprint: string | undefined;
}): string | undefined => {
	const url =
		options.advertisedUrl ??
		(WILDCARD_BINDS.has(options.bindHost) ? undefined : options.boundUrl);
	if (url === undefined) {
		return undefined;
	}
	return options.fingerprint === undefined
		? url
		: formatPairingCode(url, options.fingerprint);
};
