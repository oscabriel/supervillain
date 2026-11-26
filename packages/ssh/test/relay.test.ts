import { describe, expect } from "bun:test";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { Deferred, Effect, Fiber, Result } from "effect";

import { effect } from "./effect.ts";
import { clientKey } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec } from "./ssh2client.ts";
import { tcpListener } from "./tcp.ts";
import { tempDir } from "./tempDir.ts";

const PLAYER = `key:SHA256:${"A1b2+/".repeat(7)}C`;

const relayServer = (
	trustedRelayKeys: ReadonlyArray<string>,
	pause: `${number} millis` = "0 millis"
) =>
	testServer({
		trustedRelayKeys,
		onExec: (session) =>
			Effect.gen(function* () {
				yield* Effect.sleep(pause);
				session.write(session.info.relayedActor ?? "-");

				return 0;
			}),
	});

describe("relay trust", () => {
	effect(
		"SV_ACTOR from a trusted relay key seats a well-formed player; nothing else starts",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const relayKey = yield* clientKey(dir, "relay");
				const server = yield* relayServer([relayKey.fingerprint]);
				const client = yield* ssh2Client({ port: server.port, key: relayKey });

				const relayed = (actor: string) =>
					ssh2Exec(client, "who", { SV_ACTOR: actor }).pipe(
						Effect.map((r) => r.stdout),
						Effect.orElseSucceed(() => "refused")
					);

				expect(PLAYER).toHaveLength(54);
				expect(yield* relayed(PLAYER)).toBe(PLAYER);
				expect(yield* relayed("guest:Zx_9-q")).toBe("guest:Zx_9-q");

				for (const ignored of [
					"gm",
					"GM",
					"",
					"key:SHA256:tooShort",
					`${PLAYER}A`,
					`${PLAYER}\n`,
					"guest:",
					"guest:has space",
					`guest:${"x".repeat(65)}`,
					`key:${PLAYER}`,
				]) {
					expect(yield* relayed(ignored)).toBe("refused");
				}

				expect(yield* Effect.flip(ssh2Exec(client, "who"))).toBeInstanceOf(
					Error
				);
			})
	);

	effect(
		"SV_CLIENT from a trusted relay names the player's software, cleaned; from others, refused",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const relayKey = yield* clientKey(dir, "relay");
				const mallory = yield* clientKey(dir, "mallory");

				const server = yield* testServer({
					trustedRelayKeys: [relayKey.fingerprint],
					onExec: (session) =>
						Effect.sync(() => {
							session.write(session.info.client);
						}).pipe(Effect.as(0)),
				});

				const relay = yield* ssh2Client({ port: server.port, key: relayKey });

				const said = (env: Record<string, string>) =>
					ssh2Exec(relay, "who", { SV_ACTOR: PLAYER, ...env }).pipe(
						Effect.map((r) => r.stdout)
					);

				expect(yield* said({ SV_CLIENT: "OpenSSH_10.0p2 Debian-5" })).toBe(
					"OpenSSH_10.0p2 Debian-5"
				);
				expect(
					yield* said({ SV_CLIENT: `PuTTY\u001B[31m${"x".repeat(80)}` })
				).toBe(`PuTTY?[31m${"x".repeat(54)}`);
				expect(yield* said({})).toBe("ssh2js1.17.0");
				const direct = yield* ssh2Client({ port: server.port, key: mallory });

				const refused = yield* ssh2Exec(direct, "who", {
					SV_CLIENT: "Forged",
				}).pipe(Effect.map((r) => r.stdout));

				expect(refused).toBe("ssh2js1.17.0");
			})
	);

	effect(
		"SV_INVITE from a trusted relay rides beside the player; a bad one, or one from any other key, is dropped",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const relayKey = yield* clientKey(dir, "relay");
				const mallory = yield* clientKey(dir, "mallory");

				const server = yield* testServer({
					trustedRelayKeys: [relayKey.fingerprint],
					onExec: (session) =>
						Effect.sync(() => {
							session.write(
								`${session.info.relayedActor ?? "-"} ${session.info.relayedInvite ?? "-"}`
							);

							return 0;
						}),
				});

				const relay = yield* ssh2Client({ port: server.port, key: relayKey });

				const asked = (env: Record<string, string>) =>
					ssh2Exec(relay, "who", env).pipe(
						Effect.map((r) => r.stdout),
						Effect.orElseSucceed(() => "refused")
					);

				expect(yield* asked({ SV_ACTOR: PLAYER, SV_INVITE: "k3y9-x_1" })).toBe(
					`${PLAYER} k3y9-x_1`
				);
				expect(yield* asked({ SV_ACTOR: PLAYER })).toBe(`${PLAYER} -`);

				for (const bad of ["", "has space", "x".repeat(65), "semi;colon"]) {
					expect(yield* asked({ SV_ACTOR: PLAYER, SV_INVITE: bad })).toBe(
						`${PLAYER} -`
					);
				}

				const direct = yield* ssh2Client({ port: server.port, key: mallory });

				expect(
					(yield* ssh2Exec(direct, "who", { SV_INVITE: "k3y9" })).stdout
				).toBe("- -");
			})
	);

	effect(
		"SV_BUCKET from a trusted relay rides beside the player; a bad one, or one from any other key, is dropped",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const relayKey = yield* clientKey(dir, "relay");
				const mallory = yield* clientKey(dir, "mallory");
				const bucket = "Ab3_-".padEnd(43, "x");

				const server = yield* testServer({
					trustedRelayKeys: [relayKey.fingerprint],
					onExec: (session) =>
						Effect.sync(() => {
							session.write(
								`${session.info.relayedActor ?? "-"} ${session.info.relayedBucket ?? "-"}`
							);

							return 0;
						}),
				});

				const relay = yield* ssh2Client({ port: server.port, key: relayKey });

				const asked = (env: Record<string, string>) =>
					ssh2Exec(relay, "who", env).pipe(
						Effect.map((r) => r.stdout),
						Effect.orElseSucceed(() => "refused")
					);

				expect(yield* asked({ SV_ACTOR: PLAYER, SV_BUCKET: bucket })).toBe(
					`${PLAYER} ${bucket}`
				);

				for (const bad of ["", "short", "x".repeat(44), `${"x".repeat(42)};`]) {
					expect(yield* asked({ SV_ACTOR: PLAYER, SV_BUCKET: bad })).toBe(
						`${PLAYER} -`
					);
				}

				const direct = yield* ssh2Client({ port: server.port, key: mallory });

				expect(
					(yield* ssh2Exec(direct, "who", { SV_BUCKET: bucket })).stdout
				).toBe("- -");
			})
	);

	effect("SV_ACTOR from any other key is ignored", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const relayKey = yield* clientKey(dir, "relay");
			const mallory = yield* clientKey(dir, "mallory");
			const server = yield* relayServer([relayKey.fingerprint]);
			const client = yield* ssh2Client({ port: server.port, key: mallory });
			expect(
				(yield* ssh2Exec(client, "who", { SV_ACTOR: PLAYER })).stdout
			).toBe("-");
		})
	);

	effect("attach can trust a relay key on that one connection", () =>
		Effect.gen(function* () {
			const relayKey = yield* clientKey(yield* tempDir, "relay");
			const server = yield* relayServer([]);
			const farEnd = yield* Deferred.make<Socket>();

			const relay = yield* tcpListener((socket) => {
				Deferred.doneUnsafe(farEnd, Effect.succeed(socket));
			});

			server.attach(connect(relay.port, "127.0.0.1"), {
				trustedRelayKeys: [relayKey.fingerprint],
			});

			const linked = yield* ssh2Client({
				sock: yield* Deferred.await(farEnd),
				key: relayKey,
			});

			expect(
				(yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout
			).toBe(PLAYER);
			const direct = yield* ssh2Client({ port: server.port, key: relayKey });
			expect(
				(yield* ssh2Exec(direct, "who", { SV_ACTOR: PLAYER })).stdout
			).toBe("-");
		})
	);

	effect(
		"a relayed channel that never starts is closed alone; the relay's players stay",
		() =>
			Effect.gen(function* () {
				const relayKey = yield* clientKey(yield* tempDir, "relay");

				const server = yield* testServer({
					trustedRelayKeys: [relayKey.fingerprint],
					timeouts: { sessionStartMs: 200 },
					onExec: (session) =>
						Effect.sleep("1200 millis").pipe(
							Effect.andThen(
								Effect.sync(() => {
									session.write(session.info.relayedActor ?? "-");
								})
							),
							Effect.as(0)
						),
				});

				const relay = yield* ssh2Client({ port: server.port, key: relayKey });

				const player = yield* Effect.forkScoped(
					ssh2Exec(relay, "who", { SV_ACTOR: PLAYER })
				);

				yield* Effect.sleep("50 millis");
				relay.subsys("nothing", () => {});
				expect((yield* Fiber.join(player)).stdout).toBe(PLAYER);
			})
	);

	effect(
		"a relay connection carries many sessions; an ordinary one only a few",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const relayKey = yield* clientKey(dir, "relay");
				const alice = yield* clientKey(dir, "alice");
				const server = yield* relayServer([relayKey.fingerprint], "300 millis");
				const relay = yield* ssh2Client({ port: server.port, key: relayKey });

				const many = yield* Effect.all(
					Array.from({ length: 8 }, () =>
						ssh2Exec(relay, "who", { SV_ACTOR: PLAYER })
					),
					{ concurrency: "unbounded" }
				);

				expect(many.map((r) => r.stdout)).toEqual(
					Array.from({ length: 8 }, () => PLAYER)
				);

				const player = yield* ssh2Client({ port: server.port, key: alice });

				const few = yield* Effect.all(
					Array.from({ length: 3 }, () =>
						Effect.result(ssh2Exec(player, "who"))
					),
					{ concurrency: "unbounded" }
				);

				expect(few.filter(Result.isSuccess)).toHaveLength(2);
				expect((yield* ssh2Exec(player, "who")).stdout).toBe("-");
			})
	);
});
