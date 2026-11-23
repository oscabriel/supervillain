import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { Identity } from "../src/index.ts";
import { parseKey } from "../src/keys.ts";
import { effect } from "./effect.ts";
import { clientKey, sshExec } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

const sshString = (buf: Buffer) => {
	const head = Buffer.alloc(4);
	head.writeUInt32BE(buf.length, 0);

	return Buffer.concat([head, buf]);
};

const whoami = (allowGuests: boolean) => {
	const seen: Array<Identity> = [];

	return testServer({
		allowGuests,
		onExec: (session) =>
			Effect.sync(() => {
				seen.push(session.info.identity);
				session.write(session.info.identity.actor);

				return 0;
			}),
	}).pipe(Effect.map((server) => ({ port: server.port, seen })));
};

describe("identity", () => {
	effect(
		"two keys are two actors, and the same key is the same actor again",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const alice = yield* clientKey(dir, "alice");
				const bob = yield* clientKey(dir, "bob");
				const { port } = yield* whoami(false);
				const a1 = yield* sshExec(port, ["whoami"], { key: alice });
				const b = yield* sshExec(port, ["whoami"], { key: bob });
				const a2 = yield* sshExec(port, ["whoami"], { key: alice });
				expect(a1.stdout).toBe(`key:${alice.fingerprint}`);
				expect(b.stdout).toBe(`key:${bob.fingerprint}`);
				expect(a2.stdout).toBe(a1.stdout);
				expect(alice.fingerprint).not.toBe(bob.fingerprint);
			})
	);

	effect("a client with no key is refused unless guests are allowed", () =>
		Effect.gen(function* () {
			const { port, seen } = yield* whoami(false);
			const refused = yield* sshExec(port, ["whoami"]);
			expect(refused.exitCode).toBe(255);
			expect(refused.stderr).toContain("Permission denied");
			const forced = yield* Effect.flip(ssh2Client({ port, keyboard: true }));
			expect(forced.message).toContain("authentication methods failed");
			expect(seen).toEqual([]);
		})
	);

	effect(
		"a client with no key is a guest when guests are allowed, a new one each connection",
		() =>
			Effect.gen(function* () {
				const { port, seen } = yield* whoami(true);
				const first = yield* sshExec(port, ["whoami"]);
				const second = yield* sshExec(port, ["whoami"]);
				expect(first.exitCode).toBe(0);
				expect(first.stdout).toMatch(/^guest:[A-Za-z0-9_-]{1,64}$/u);
				expect(second.stdout).toMatch(/^guest:[A-Za-z0-9_-]{1,64}$/u);
				expect(second.stdout).not.toBe(first.stdout);
				expect(seen.map((i) => i.kind)).toEqual(["guest", "guest"]);
			})
	);

	effect(
		"an RSA key logs in as itself with OpenSSH's defaults, even offered before another key",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const rsa = yield* clientKey(dir, "rsa", "rsa");
				const ed = yield* clientKey(dir, "ed", "ed25519");
				const { port } = yield* whoami(false);
				const alone = yield* sshExec(port, ["whoami"], { key: rsa });
				expect(alone.stderr).toBe("");
				expect(alone.exitCode).toBe(0);
				expect(alone.stdout).toBe(`key:${rsa.fingerprint}`);

				const both = yield* sshExec(port, ["whoami"], {
					key: ed,
					flags: ["-i", rsa.path],
				});

				expect(both.exitCode).toBe(0);
				expect(both.stdout).toBe(`key:${rsa.fingerprint}`);
			})
	);

	effect(
		"an RSA key its client restricts to rsa-sha2-512 isn't offered, as ssh2 never advertises it",
		() =>
			Effect.gen(function* () {
				const rsa = yield* clientKey(yield* tempDir, "rsa", "rsa");
				const { port } = yield* whoami(false);

				const only512 = yield* sshExec(port, ["whoami"], {
					key: rsa,
					flags: ["-v", "-o", "PubkeyAcceptedAlgorithms=rsa-sha2-512"],
				});

				const advertised = /server-sig-algs=<(?<algorithms>[^>]*)>/u
					.exec(only512.stderr)
					?.groups?.algorithms?.split(",");

				expect(advertised).toContain("rsa-sha2-256");
				expect(advertised).not.toContain("rsa-sha2-512");
				expect(only512.exitCode).toBe(255);
				expect(only512.stderr).toContain("Permission denied");
			})
	);

	effect("a key holder is still a key when guests are allowed", () =>
		Effect.gen(function* () {
			const alice = yield* clientKey(yield* tempDir, "alice");
			const { port } = yield* whoami(true);
			expect((yield* sshExec(port, ["whoami"], { key: alice })).stdout).toBe(
				`key:${alice.fingerprint}`
			);
		})
	);

	test("a malformed key a stranger sends is no key, not a throw", () => {
		for (const [algorithm, blob] of [
			[
				"ecdsa-sha2-nistp384",
				"0000001365636473612d736861322d6e69737470333834000000086e6973747032353600000000",
			],
			[
				"ssh-dss",
				"000000077373682d647373000000000000000301000100000002ffff0000000193",
			],
		] as const) {
			expect(
				parseKey(`${algorithm} ${Buffer.from(blob, "hex").toString("base64")}`)
			).toBeUndefined();
		}
	});

	test("an off-curve ECDSA key whose verify returns an Error is not accepted as true", () => {
		const offCurve = Buffer.concat([
			sshString(Buffer.from("ecdsa-sha2-nistp256")),
			sshString(Buffer.from("nistp256")),
			sshString(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)])),
		]);

		const parsed = parseKey(
			`ecdsa-sha2-nistp256 ${offCurve.toString("base64")}`
		);

		expect(parsed).toBeDefined();

		const outcome = parsed?.verify(Buffer.from("data"), Buffer.alloc(64));

		expect(Object.is(outcome, true)).toBe(false);
	});
});
