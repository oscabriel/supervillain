import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/class-methods-use-this, promise/avoid-new -- Bun-only suite: the gateway is Bun-bound by bun:sqlite, and the fake store is interface-shaped. */
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";
import { openHostPipe } from "@supervillain/room-wire";
import {
	CertificateMismatchError,
	openWsDialer,
	parsePairingCode,
	readServedCertificate,
} from "@supervillain/transport-ws";
import { mintSelfSignedCertificate } from "@supervillain/transport-ws/server";

import { gatewayBanner, pipePairingCode, startGateway } from "../src/index.js";
import type { RunningGateway } from "../src/index.js";

class FakeRoomStore implements RoomStore {
	readonly submissions: RoomCommand[] = [];

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		this.submissions.push(command);
		return { accepted: true, envelopes: [] };
	}

	stream(): AsyncIterable<Envelope> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<Envelope>>(() => {}),
			}),
		};
	}
}

/** A gateway with no domain, no CA, and nothing in front of it — posture 2 of
 * ADR-0012 NQ-9, started exactly as a homelab operator starts it. */
const startSelfHosted = (stateDir: string): Promise<RunningGateway> =>
	startGateway({
		bindHost: "127.0.0.1",
		brokerPort: 0,
		sshHost: "127.0.0.1",
		sshPort: 0,
		stateDir,
	});

const hostIdentity = "11".repeat(32);

describe("a self-hosted gateway's TLS", () => {
	test("mints a certificate on first start and prints a pairing code", async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-tls-"));
		const gateway = await startSelfHosted(stateDir);
		try {
			expect(gateway.url.startsWith("wss://")).toBe(true);
			expect(gateway.certificateFingerprint).toMatch(/^[0-9a-f]{64}$/u);
			expect(gateway.pairingCode).toContain(
				`#fp=sha256:${gateway.certificateFingerprint}`
			);
			expect(parsePairingCode(gateway.pairingCode ?? "")).toEqual({
				fingerprint: gateway.certificateFingerprint,
				url: new URL(gateway.url).toString(),
			});
			await access(path.join(stateDir, "pipe-cert.pem"));
			await access(path.join(stateDir, "pipe-key.pem"));
			expect(gatewayBanner(gateway)).toContain(gateway.pairingCode ?? "");
		} finally {
			await gateway.close();
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("keeps the same certificate across restarts, so a pin survives", async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-tls-"));
		const first = await startSelfHosted(stateDir);
		const fingerprint = first.certificateFingerprint;
		await first.close();
		const second = await startSelfHosted(stateDir);
		try {
			expect(second.certificateFingerprint).toBe(fingerprint);
		} finally {
			await second.close();
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("carries a Host that paired with the code, and refuses a changed one", async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-tls-"));
		const gateway = await startSelfHosted(stateDir);
		const pairing = parsePairingCode(gateway.pairingCode ?? "");
		const pipe = openHostPipe({
			dialer: openWsDialer({
				certificateFingerprint: pairing.fingerprint,
				secretKeyHex: hostIdentity,
				url: pairing.url,
			}),
			rooms: [
				{
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		try {
			const attachment = await pipe.attached;
			expect(attachment.sshHost).toBe("127.0.0.1");
		} finally {
			await pipe.close();
		}

		// The same address, a different certificate: the refusal is the point.
		const impostor = mintSelfSignedCertificate();
		const refused = openHostPipe({
			dialer: openWsDialer({
				certificateFingerprint: impostor.fingerprint,
				secretKeyHex: hostIdentity,
				url: pairing.url,
			}),
			reconnectDelayMs: () => 1,
			rooms: [
				{
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		try {
			await expect(refused.attached).rejects.toBeInstanceOf(
				CertificateMismatchError
			);
		} finally {
			await refused.close();
			await gateway.close();
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("serves the pipe in the clear only when TLS is terminated upstream", async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-tls-"));
		const gateway = await startGateway({
			bindHost: "127.0.0.1",
			brokerPort: 0,
			sshHost: "127.0.0.1",
			sshPort: 0,
			stateDir,
			tls: { mode: "terminated-upstream" },
		});
		try {
			expect(gateway.url.startsWith("ws://")).toBe(true);
			expect(gateway.certificateFingerprint).toBeUndefined();
			// Behind Caddy the operator sets the public URL; the code is a plain
			// wss:// address because a real certificate is checked against a CA.
			expect(gateway.pairingCode).toBe(gateway.url);
		} finally {
			await gateway.close();
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("serves an operator's own certificate without publishing a pin", async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), "supervillain-tls-"));
		const supplied = mintSelfSignedCertificate({ hosts: ["localhost"] });
		const certificatePath = path.join(stateDir, "supplied-cert.pem");
		const privateKeyPath = path.join(stateDir, "supplied-key.pem");
		await writeFile(certificatePath, supplied.certificatePem);
		await writeFile(privateKeyPath, supplied.privateKeyPem);
		const gateway = await startGateway({
			bindHost: "127.0.0.1",
			brokerPort: 0,
			sshHost: "127.0.0.1",
			sshPort: 0,
			stateDir,
			tls: { certificatePath, mode: "files", privateKeyPath },
		});
		try {
			expect(gateway.url.startsWith("wss://")).toBe(true);
			// A CA-issued certificate is expected to be renewed, so pinning it would
			// turn every renewal into a refusal.
			expect(gateway.certificateFingerprint).toBeUndefined();
			expect(gateway.pairingCode).toBe(gateway.url);
			const served = await readServedCertificate(gateway.url);
			expect(served.fingerprint).toBe(supplied.fingerprint);
		} finally {
			await gateway.close();
			await rm(stateDir, { force: true, recursive: true });
		}
	});
});

describe("the pairing code the operator is shown", () => {
	test("is withheld when the address Hosts reach is not knowable here", () => {
		expect(
			pipePairingCode({
				advertisedUrl: undefined,
				bindHost: "0.0.0.0",
				boundUrl: "wss://0.0.0.0:8443",
				fingerprint: "ab".repeat(32),
			})
		).toBeUndefined();
	});

	test("uses the advertised address whenever the operator supplied one", () => {
		expect(
			pipePairingCode({
				advertisedUrl: "wss://box.example:8443",
				bindHost: "0.0.0.0",
				boundUrl: "wss://0.0.0.0:8443",
				fingerprint: "ab".repeat(32),
			})
		).toBe(`wss://box.example:8443/#fp=sha256:${"ab".repeat(32)}`);
	});
});
