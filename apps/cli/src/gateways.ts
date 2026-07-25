import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { gatewayOrigin, parsePairingCode } from "@supervillain/transport-ws";

const PIN_FILE = "gateways.json";
const PIN_VERSION = 1;

/** A gateway certificate this machine has decided to trust, and when it decided.
 * The date is for the human reading a refusal, not for any expiry rule — a pin
 * does not lapse. */
export interface PinnedGateway {
	readonly fingerprint: string;
	readonly pinnedAt: string;
}

interface PinFile {
	readonly version: number;
	readonly gateways: Record<string, PinnedGateway>;
}

export const pinFilePath = (configFolder: string): string =>
	path.join(configFolder, PIN_FILE);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readPinned = (value: unknown): PinnedGateway | undefined => {
	if (
		!isRecord(value) ||
		typeof value.fingerprint !== "string" ||
		typeof value.pinnedAt !== "string"
	) {
		return undefined;
	}
	return { fingerprint: value.fingerprint, pinnedAt: value.pinnedAt };
};

/** Reads the pin store, treating an absent or unreadable file as no pins. A
 * damaged file must not brick hosting — but it also must not be silently
 * repaired into an empty one, so nothing is written back here. */
export const readGatewayPins = async (
	configFolder: string
): Promise<Record<string, PinnedGateway>> => {
	let text: string;
	try {
		text = await readFile(pinFilePath(configFolder), "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {};
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new TypeError(
			`Pinned-gateway file '${pinFilePath(configFolder)}' is not valid JSON.`,
			{ cause: error }
		);
	}
	if (!isRecord(parsed) || !isRecord(parsed.gateways)) {
		return {};
	}
	const pins: Record<string, PinnedGateway> = {};
	for (const [origin, value] of Object.entries(parsed.gateways)) {
		const pinned = readPinned(value);
		if (pinned !== undefined) {
			pins[origin] = pinned;
		}
	}
	return pins;
};

/** Records the trust decision. Called only after a connection succeeded, so a
 * gateway that was never reached leaves nothing behind to un-pair. */
export const pinGateway = async (
	configFolder: string,
	origin: string,
	fingerprint: string
): Promise<void> => {
	const pins = await readGatewayPins(configFolder);
	const file: PinFile = {
		gateways: {
			...pins,
			[origin]: { fingerprint, pinnedAt: new Date().toISOString() },
		},
		version: PIN_VERSION,
	};
	await mkdir(configFolder, { recursive: true });
	await writeFile(
		pinFilePath(configFolder),
		`${JSON.stringify(file, null, 2)}\n`,
		{ mode: 0o600 }
	);
};

/** The gateway a `--gateway` value resolved to, with the trust this machine will
 * insist on when it dials. */
export interface GatewayTarget {
	readonly url: string;
	readonly origin: string;
	/** The fingerprint the dial must find, or undefined for a CA-checked gateway. */
	readonly fingerprint: string | undefined;
	/** True when a successful connection is what turns this into a pin. */
	readonly pinOnSuccess: boolean;
}

/** The refusal a changed pairing code earns. Loud by construction: it names both
 * fingerprints and the file that holds the decision, because the only safe next
 * step is a human deciding which certificate is real. */
export class PinnedGatewayChangedError extends Error {
	constructor(options: {
		readonly origin: string;
		readonly pinned: PinnedGateway;
		readonly offered: string;
		readonly pinFile: string;
	}) {
		super(
			[
				`Refused: the pairing code for ${options.origin} names a different certificate than this machine pinned.`,
				"",
				`  pinned:   sha256:${options.pinned.fingerprint}   (first trusted ${options.pinned.pinnedAt})`,
				`  offered:  sha256:${options.offered}`,
				"",
				"A gateway's certificate changes when it is rebuilt — or when something is",
				"impersonating it. supervillain will not connect until you decide which.",
				"",
				"If you rebuilt that gateway yourself, remove its entry from",
				`  ${options.pinFile}`,
				"and pair again.",
			].join("\n")
		);
		this.name = "PinnedGatewayChangedError";
	}
}

/**
 * Resolves `--gateway` — a pairing code or a bare URL — against what this
 * machine already trusts (ADR-0012 NQ-9, ADR-0014).
 *
 * A pin always wins over a bare URL: dropping the fingerprint from a pairing
 * code must not quietly downgrade a pinned gateway to whatever a CA will vouch
 * for. A pin that disagrees with an offered fingerprint is a refusal, never a
 * prompt.
 */
export const resolveGatewayTarget = async (
	configFolder: string,
	address: string
): Promise<GatewayTarget> => {
	const pairing = parsePairingCode(address);
	const origin = gatewayOrigin(pairing.url);
	const pins = await readGatewayPins(configFolder);
	const pinned = pins[origin];
	if (pinned !== undefined) {
		if (
			pairing.fingerprint !== undefined &&
			pairing.fingerprint !== pinned.fingerprint
		) {
			throw new PinnedGatewayChangedError({
				offered: pairing.fingerprint,
				origin,
				pinFile: pinFilePath(configFolder),
				pinned,
			});
		}
		return {
			fingerprint: pinned.fingerprint,
			origin,
			pinOnSuccess: false,
			url: pairing.url,
		};
	}
	return {
		fingerprint: pairing.fingerprint,
		origin,
		pinOnSuccess: pairing.fingerprint !== undefined,
		url: pairing.url,
	};
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The warning a plaintext pipe to somewhere other than this machine deserves.
 * ADR-0012 makes the pipe TLS; plaintext survives for local development only,
 * and a development default that quietly reaches the internet is how interim
 * states become permanent. */
export const plaintextWarning = (url: string): string | undefined => {
	const parsed = new URL(url);
	if (parsed.protocol !== "ws:" || LOOPBACK.has(parsed.hostname)) {
		return undefined;
	}
	return `warning: ${parsed.host} is being dialed over plaintext ws://. Everything on this pipe, including your room's commands, crosses the network unencrypted. Use a wss:// gateway address.`;
};
