import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

import {
	bitString,
	boolean,
	dnsName,
	explicit,
	integer,
	ipAddress,
	objectIdentifier,
	octetString,
	sequence,
	setOf,
	smallInteger,
	utcTime,
	utf8String,
} from "./asn1.js";
import { fingerprintOfDer } from "./fingerprint.js";

const OID_COMMON_NAME = "2.5.4.3";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";

const X509_V3 = 2;
const SERIAL_BYTES = 16;
const CLOCK_SKEW_MS = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_VALID_DAYS = 3650;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
/** digitalSignature | keyCertSign | cRLSign. */
const KEY_USAGE_BITS = 0x86;

const ECDSA_SHA256 = sequence(objectIdentifier(OID_ECDSA_SHA256));

const commonName = (value: string): Uint8Array =>
	sequence(
		setOf(sequence(objectIdentifier(OID_COMMON_NAME), utf8String(value)))
	);

const extension = (
	id: string,
	critical: boolean,
	value: Uint8Array
): Uint8Array =>
	critical
		? sequence(objectIdentifier(id), boolean(true), octetString(value))
		: sequence(objectIdentifier(id), octetString(value));

const subjectAltName = (hosts: readonly string[]): Uint8Array =>
	extension(
		OID_SUBJECT_ALT_NAME,
		false,
		sequence(
			...hosts.map((host) =>
				IPV4.test(host) ? ipAddress(host) : dnsName(host)
			)
		)
	);

const pem = (label: string, der: Uint8Array): string => {
	const base64 = Buffer.from(der).toString("base64");
	const lines = base64.match(/.{1,64}/gu) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/** A certificate this process minted for itself, and the number that identifies
 * it. Nothing outside the fingerprint is trusted: there is no CA to chain to and
 * no domain to match, which is precisely NQ-9's promise. */
export interface SelfSignedCertificate {
	readonly certificatePem: string;
	readonly privateKeyPem: string;
	/** 64 lowercase hex chars — the SHA-256 of the certificate's DER bytes. */
	readonly fingerprint: string;
}

export interface MintOptions {
	/** Names written into the subjectAltName. Cosmetic: the pairing code pins the
	 * fingerprint, and no dialer of ours checks the name. Default: localhost. */
	readonly hosts?: readonly string[];
	readonly commonName?: string;
	readonly validForDays?: number;
	readonly now?: Date;
}

/**
 * Mints a self-signed P-256 certificate for a gateway that has no CA, no domain,
 * and no reverse proxy (ADR-0012, NQ-9). The fingerprint it returns is what
 * travels in the Host-onboarding pairing code.
 */
export const mintSelfSignedCertificate = (
	options: MintOptions = {}
): SelfSignedCertificate => {
	const hosts = options.hosts ?? ["localhost"];
	const subject = options.commonName ?? "supervillain-gateway";
	const from = options.now ?? new Date();
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	const subjectPublicKeyInfo = new Uint8Array(
		publicKey.export({ format: "der", type: "spki" })
	);
	const tbsCertificate = sequence(
		explicit(0, smallInteger(X509_V3)),
		integer(new Uint8Array(randomBytes(SERIAL_BYTES))),
		ECDSA_SHA256,
		commonName(subject),
		sequence(
			utcTime(new Date(from.getTime() - CLOCK_SKEW_MS)),
			utcTime(
				new Date(
					from.getTime() + (options.validForDays ?? DEFAULT_VALID_DAYS) * DAY_MS
				)
			)
		),
		commonName(subject),
		subjectPublicKeyInfo,
		explicit(
			3,
			sequence(
				extension(OID_BASIC_CONSTRAINTS, true, sequence(boolean(true))),
				extension(
					OID_KEY_USAGE,
					true,
					bitString(Uint8Array.from([KEY_USAGE_BITS]))
				),
				subjectAltName(hosts)
			)
		)
	);
	const signature = new Uint8Array(sign("sha256", tbsCertificate, privateKey));
	const der = sequence(tbsCertificate, ECDSA_SHA256, bitString(signature));
	return {
		certificatePem: pem("CERTIFICATE", der),
		fingerprint: fingerprintOfDer(der),
		privateKeyPem: privateKey
			.export({ format: "pem", type: "pkcs8" })
			.toString(),
	};
};
