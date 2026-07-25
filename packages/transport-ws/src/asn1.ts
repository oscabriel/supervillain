/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator -- DER tags and length prefixes are bit fields; the operators are the format. */

/** The sliver of DER writing a self-signed certificate needs. Minting a
 * certificate with no CA and no domain (ADR-0012, NQ-9) means writing X.509 by
 * hand: neither `node:crypto` nor Bun exposes a certificate builder, and a
 * homelab operator's ritual must not include an `openssl` binary. Nothing here
 * parses DER — the only reader we ever face is a TLS stack. */

const LONG_FORM = 0x80;
const BYTE = 256;

const lengthBytes = (length: number): number[] => {
	if (length < LONG_FORM) {
		return [length];
	}
	const bytes: number[] = [];
	let remaining = length;
	while (remaining > 0) {
		bytes.unshift(remaining % BYTE);
		remaining = Math.floor(remaining / BYTE);
	}
	return [LONG_FORM | bytes.length, ...bytes];
};

/** One tag-length-value triple. */
export const tagged = (tag: number, body: Uint8Array): Uint8Array =>
	Buffer.concat([
		Uint8Array.from([tag, ...lengthBytes(body.byteLength)]),
		body,
	]);

export const concat = (...parts: readonly Uint8Array[]): Uint8Array =>
	Buffer.concat(parts);

export const sequence = (...parts: readonly Uint8Array[]): Uint8Array =>
	tagged(0x30, concat(...parts));

export const setOf = (...parts: readonly Uint8Array[]): Uint8Array =>
	tagged(0x31, concat(...parts));

/** `[n] EXPLICIT` — the context-specific constructed tag X.509 uses for the
 * version and extensions members. */
export const explicit = (index: number, body: Uint8Array): Uint8Array =>
	tagged(0xa0 | index, body);

const BASE_128 = 0x80;
const FIRST_ARC_SCALE = 40;

const oidArc = (value: number): number[] => {
	const chunk: number[] = [value % BASE_128];
	let remaining = Math.floor(value / BASE_128);
	while (remaining > 0) {
		chunk.unshift((remaining % BASE_128) | BASE_128);
		remaining = Math.floor(remaining / BASE_128);
	}
	return chunk;
};

export const objectIdentifier = (dotted: string): Uint8Array => {
	const arcs = dotted.split(".").map(Number);
	const [first, second, ...rest] = arcs;
	if (first === undefined || second === undefined) {
		throw new Error(`'${dotted}' is not an object identifier.`);
	}
	const body: number[] = [FIRST_ARC_SCALE * first + second];
	for (const arc of rest) {
		body.push(...oidArc(arc));
	}
	return tagged(0x06, Uint8Array.from(body));
};

const HIGH_BIT = 0x80;

/** DER integers are signed, so a leading high bit needs a zero pad. */
export const integer = (bytes: Uint8Array): Uint8Array => {
	let start = 0;
	while (start < bytes.byteLength - 1 && bytes[start] === 0) {
		start += 1;
	}
	const trimmed = bytes.subarray(start);
	const first = trimmed[0] ?? 0;
	return tagged(
		0x02,
		(first & HIGH_BIT) === 0 ? trimmed : concat(Uint8Array.from([0]), trimmed)
	);
};

export const smallInteger = (value: number): Uint8Array =>
	tagged(0x02, Uint8Array.from([value]));

export const bitString = (bytes: Uint8Array): Uint8Array =>
	tagged(0x03, concat(Uint8Array.from([0]), bytes));

export const octetString = (bytes: Uint8Array): Uint8Array =>
	tagged(0x04, bytes);

export const utf8String = (value: string): Uint8Array =>
	tagged(0x0c, Buffer.from(value, "utf-8"));

export const boolean = (value: boolean): Uint8Array =>
	tagged(0x01, Uint8Array.from([value ? 0xff : 0x00]));

const CENTURY = 100;

const pad = (value: number): string => String(value).padStart(2, "0");

/** UTCTime, the encoding X.509 mandates below 2050. */
export const utcTime = (at: Date): Uint8Array =>
	tagged(
		0x17,
		Buffer.from(
			`${pad(at.getUTCFullYear() % CENTURY)}${pad(at.getUTCMonth() + 1)}${pad(
				at.getUTCDate()
			)}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(
				at.getUTCSeconds()
			)}Z`,
			"ascii"
		)
	);

/** GeneralName `dNSName [2]`. */
export const dnsName = (value: string): Uint8Array =>
	tagged(0x82, Buffer.from(value, "ascii"));

/** GeneralName `iPAddress [7]` — dotted-quad IPv4 only, which is every address
 * a homelab port-forward hands out. */
export const ipAddress = (value: string): Uint8Array =>
	tagged(0x87, Uint8Array.from(value.split(".").map(Number)));
