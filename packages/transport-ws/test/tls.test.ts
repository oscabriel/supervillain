/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane transport suite shares one runner harness. */
import {
	CertificateMismatchError,
	fingerprintOfPem,
	formatPairingCode,
	gatewayOrigin,
	InvalidPairingCodeError,
	InvalidTransportUrlError,
	normalizeFingerprint,
	openWsDialer,
	parsePairingCode,
	PlaintextPinError,
	readServedCertificate,
} from "../src/index.js";
import { mintSelfSignedCertificate, startWsListener } from "../src/server.js";
import type { WsListener } from "../src/server.js";
import { describe, expect, generateIdentity, test } from "./harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const openTlsListener = async (
	certificate = mintSelfSignedCertificate({
		hosts: ["localhost", "127.0.0.1"],
	})
): Promise<{
	readonly listener: WsListener;
	readonly fingerprint: string;
	readonly gatewayId: string;
}> => {
	const gateway = generateIdentity();
	const listener = await startWsListener({
		secretKeyHex: gateway.secretKeyHex,
		tls: certificate,
	});
	return {
		fingerprint: certificate.fingerprint,
		gatewayId: gateway.publicKeyHex,
		listener,
	};
};

describe("the minted certificate", () => {
	test("is a self-signed certificate whose fingerprint matches its bytes", () => {
		const certificate = mintSelfSignedCertificate();
		expect(certificate.certificatePem).toContain("BEGIN CERTIFICATE");
		expect(certificate.privateKeyPem).toContain("BEGIN PRIVATE KEY");
		expect(certificate.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
		expect(fingerprintOfPem(certificate.certificatePem)).toBe(
			certificate.fingerprint
		);
	});

	test("mints a different certificate every time", () => {
		expect(mintSelfSignedCertificate().fingerprint).not.toBe(
			mintSelfSignedCertificate().fingerprint
		);
	});
});

describe("the pairing code", () => {
	test("round-trips a URL and a fingerprint through one pasteable string", () => {
		const fingerprint = "ab".repeat(32);
		const code = formatPairingCode("wss://box.example:8443/pipe", fingerprint);
		expect(code).toBe(`wss://box.example:8443/pipe#fp=sha256:${fingerprint}`);
		expect(parsePairingCode(code)).toEqual({
			fingerprint,
			url: "wss://box.example:8443/pipe",
		});
	});

	test("reads a bare URL as a gateway with no pin", () => {
		expect(parsePairingCode("wss://supervillain.example/pipe")).toEqual({
			fingerprint: undefined,
			url: "wss://supervillain.example/pipe",
		});
	});

	test("accepts the colon-separated capitals OpenSSL prints", () => {
		const fingerprint = "ab".repeat(32);
		const openssl = (fingerprint.match(/../gu) ?? []).join(":").toUpperCase();
		expect(normalizeFingerprint(openssl)).toBe(fingerprint);
		expect(normalizeFingerprint(`sha256:${openssl}`)).toBe(fingerprint);
	});

	test("refuses a fragment it does not understand rather than dropping it", () => {
		expect(() => parsePairingCode("wss://box.example#token=abc")).toThrow(
			InvalidPairingCodeError
		);
		expect(() => parsePairingCode("wss://box.example#fp=md5:abc")).toThrow(
			InvalidPairingCodeError
		);
		expect(() => parsePairingCode("wss://box.example#fp=sha256:zz")).toThrow(
			InvalidPairingCodeError
		);
		expect(() => parsePairingCode("https://box.example")).toThrow(
			InvalidTransportUrlError
		);
	});

	test("files a pin under scheme, host, and port only", () => {
		expect(gatewayOrigin("wss://box.example:8443/pipe")).toBe(
			"wss://box.example:8443"
		);
	});
});

describe("a self-hosted gateway's TLS pipe", () => {
	test("serves wss and reports the fingerprint a pairing code needs", async () => {
		const { listener, fingerprint } = await openTlsListener();
		try {
			expect(listener.url.startsWith("wss://")).toBe(true);
			expect(listener.certificateFingerprint).toBe(fingerprint);
			const served = await readServedCertificate(listener.url);
			expect(served.fingerprint).toBe(fingerprint);
		} finally {
			await listener.close();
		}
	});

	test("carries an authenticated pipe once the Host pins the fingerprint", async () => {
		const { listener, fingerprint, gatewayId } = await openTlsListener();
		const host = generateIdentity();
		const dialer = openWsDialer({
			certificateFingerprint: fingerprint,
			secretKeyHex: host.secretKeyHex,
			url: listener.url,
		});
		try {
			const dialed = dialer.dial();
			const accepted = await listener.accept();
			const connection = await dialed;
			expect(connection.remoteId).toBe(gatewayId);
			expect(accepted.remoteId).toBe(host.publicKeyHex);
			await connection.send(encoder.encode("over tls"));
			expect(decoder.decode(await accepted.receive())).toBe("over tls");
		} finally {
			await dialer.close();
			await listener.close();
		}
	});

	test("reconnects later against the same pin without re-pairing", async () => {
		const certificate = mintSelfSignedCertificate({ hosts: ["localhost"] });
		const gateway = generateIdentity();
		const host = generateIdentity();
		const first = await startWsListener({
			secretKeyHex: gateway.secretKeyHex,
			tls: certificate,
		});
		const { port, url } = first;
		const dialer = openWsDialer({
			certificateFingerprint: certificate.fingerprint,
			secretKeyHex: host.secretKeyHex,
			url,
		});
		try {
			await Promise.all([dialer.dial(), first.accept()]);
		} finally {
			await first.close();
		}
		// The gateway restarts on the same certificate: the pin still holds, and
		// nothing about the Host's stored trust had to change.
		const second = await startWsListener({
			port,
			secretKeyHex: gateway.secretKeyHex,
			tls: certificate,
		});
		try {
			const [connection] = await Promise.all([dialer.dial(), second.accept()]);
			expect(connection.remoteId).toBe(gateway.publicKeyHex);
		} finally {
			await dialer.close();
			await second.close();
		}
	});

	test("refuses a changed certificate loudly and names both fingerprints", async () => {
		const { listener, fingerprint } = await openTlsListener();
		const impostor = mintSelfSignedCertificate({ hosts: ["localhost"] });
		const host = generateIdentity();
		const dialer = openWsDialer({
			certificateFingerprint: impostor.fingerprint,
			secretKeyHex: host.secretKeyHex,
			url: listener.url,
		});
		try {
			let refusal: unknown;
			try {
				await dialer.dial();
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toBeInstanceOf(CertificateMismatchError);
			const mismatch = refusal as CertificateMismatchError;
			expect(mismatch.expected).toBe(impostor.fingerprint);
			expect(mismatch.served).toBe(fingerprint);
			expect(mismatch.message).toContain(impostor.fingerprint);
			expect(mismatch.message).toContain(fingerprint);
			expect(mismatch.message).toContain("Refused");
		} finally {
			await dialer.close();
			await listener.close();
		}
	});

	test("refuses an unpinned dial at a gateway that chains to no CA", async () => {
		const { listener } = await openTlsListener();
		const host = generateIdentity();
		const dialer = openWsDialer({
			secretKeyHex: host.secretKeyHex,
			url: listener.url,
		});
		try {
			await expect(dialer.dial()).rejects.toThrow();
		} finally {
			await dialer.close();
			await listener.close();
		}
	});

	test("refuses a fingerprint handed to a plaintext address", () => {
		const host = generateIdentity();
		expect(() =>
			openWsDialer({
				certificateFingerprint: "ab".repeat(32),
				secretKeyHex: host.secretKeyHex,
				url: "ws://127.0.0.1:9",
			})
		).toThrow(PlaintextPinError);
	});
});
