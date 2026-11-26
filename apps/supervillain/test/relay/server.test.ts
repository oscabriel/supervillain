import { describe, expect } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { TERMINAL_RESET } from "@supervillain/ssh";
import { Effect, Exit, Fiber, Schema, Scope } from "effect";
import { SecureRandom } from "effect/crypto";

import { forgetHandle } from "../../src/relay/handles.ts";
import { codeOf, PAIRING_BYTES } from "../../src/relay/pairings.ts";
import {
	closedTableMessage,
	JOIN_HINT,
	readLine,
} from "../../src/relay/protocol.ts";
import { claimLimiter, manyMessage } from "../../src/relay/server.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import {
	dial,
	gmTable,
	HANDLE,
	linkGm,
	socketClosed,
	startRelay,
} from "./harness.ts";
import type { GmTableOptions } from "./harness.ts";
import { clientKey, sshExec, sshShell } from "./openssh.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const Registry = Schema.fromJsonString(
	Schema.Record(
		Schema.String,
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			claimed: Schema.String,
			seen: Schema.String,
		})
	)
);

type Stored = Readonly<
	Record<
		string,
		{
			readonly keys: ReadonlyArray<string>;
			readonly claimed: string;
			readonly seen: string;
		}
	>
>;

const readRegistry = (file: string) =>
	Effect.promise(async () => await readFile(file, "utf-8")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Registry))
	);

const handlesIn = (file: string) =>
	readRegistry(file).pipe(
		Effect.map((handles) => Object.keys(handles).toSorted())
	);

const writeRegistry = (file: string, handles: Stored) => {
	const text = JSON.stringify(handles);

	return Effect.promise(async () => {
		await writeFile(file, text, { mode: 0o600 });
	});
};

const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

const millisOf = (iso: string) => Date.parse(iso);

const LEGACY_ROOMS = JSON.stringify({ den: `SHA256:${"A".repeat(43)}` });

const GUEST_EXEC = /^exec guest:[A-Za-z0-9_-]{1,64} hi\n$/u;

type Started = Effect.Success<ReturnType<typeof startRelay>>;

const counting = (size: number) =>
	Uint8Array.from({ length: size }, (_, at) => (at * 7 + 1) % 256);

const linked = (relay: Started, address: string, up = true) =>
	waitFor(`table ${address} ${up ? "linked" : "unlinked"}`, () =>
		up
			? relay.linkedTables().includes(address)
			: !relay.linkedTables().includes(address)
	);

const openTable = (
	relay: Started,
	table = "den",
	handle = HANDLE,
	options: GmTableOptions = {}
) =>
	Effect.gen(function* () {
		const gm = yield* gmTable(options);

		const link = yield* linkGm(
			gm,
			relay.gmPort,
			table,
			relay.relayKeyFingerprint,
			handle
		);

		expect(link.answer).toBe("OK");
		yield* linked(relay, `${handle}/${table}`);

		return { gm, link };
	});

const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();
		const value = yield* body.pipe(Scope.provide(scope));

		return { value, close: Scope.close(scope, Exit.void) };
	});

const fileThere = (file: string) =>
	Effect.promise(async () => {
		try {
			await stat(file);

			return true;
		} catch {
			return false;
		}
	});

describe("relay: players reach the GM's table", () => {
	effect(
		"an exec is bridged as the player: output, stderr, exit status and stdin to EOF",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");
				const ran = yield* sshExec(relay.playerPort, ["roll", "2d10"], { key });
				expect(ran).toEqual({
					stdout: `exec key:${key.fingerprint} roll 2d10\n`,
					stderr: "note\n",
					exitCode: 0,
				});
				expect(
					(yield* sshExec(relay.playerPort, ["fail"], { key })).exitCode
				).toBe(3);

				const piped = yield* sshExec(relay.playerPort, ["cat"], {
					key,
					stdin: "one\ntwo\n",
				});

				expect(piped).toMatchObject({ stdout: "ONE\nTWO\n", exitCode: 0 });
			})
	);

	effect(
		"a player with an RSA key is seated as that key, even with it offered first",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				yield* openTable(relay);
				const dir = yield* tempDir;
				const rsa = yield* clientKey(dir, "rsa", "rsa");
				const ed = yield* clientKey(dir, "ed");
				const alone = yield* sshExec(relay.playerPort, ["hi"], { key: rsa });
				expect(alone).toEqual({
					stdout: `exec key:${rsa.fingerprint} hi\n`,
					stderr: "note\n",
					exitCode: 0,
				});

				const both = yield* sshExec(relay.playerPort, ["hi"], {
					key: ed,
					flags: ["-i", rsa.path],
				});

				expect(both).toMatchObject({
					stdout: `exec key:${rsa.fingerprint} hi\n`,
					exitCode: 0,
				});
			})
	);

	effect("a table's address is typed in any case, with / or .", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay();
			yield* openTable(relay);
			const key = yield* clientKey(yield* tempDir, "vex");

			for (const user of ["Ana/Den", "ana.den"]) {
				const ran = yield* sshExec(relay.playerPort, ["hi"], { key, user });

				expect(ran).toMatchObject({
					stdout: `exec key:${key.fingerprint} hi\n`,
					exitCode: 0,
				});
			}
		})
	);

	effect(
		"an invite after ~ is stripped before routing and handed to the table as SV_INVITE",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");

				expect(
					yield* sshExec(relay.playerPort, ["invite"], {
						key,
						user: "ana/den~k3y9",
					})
				).toMatchObject({ stdout: "invite k3y9\n", exitCode: 0 });
				expect(
					yield* sshExec(relay.playerPort, ["invite"], { key, user: "ana/den" })
				).toMatchObject({ stdout: "invite -\n", exitCode: 0 });
			})
	);

	effect("a keyless player is seated as a guest", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay();
			yield* openTable(relay);
			const ran = yield* sshExec(relay.playerPort, ["hi"], {});
			expect(ran.exitCode).toBe(0);
			expect(ran.stdout).toMatch(GUEST_EXEC);
		})
	);

	effect(
		"a shell is bridged with its pty, env, window-changes, keystrokes and exit status",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");

				const terminal = yield* sshShell(
					relay.playerPort,
					{ cols: 100, rows: 30 },
					{
						key,
						flags: ["-o", "SetEnv=COLORTERM=truecolor LD_PRELOAD=/evil.so"],
					}
				);

				yield* waitFor("the seat", () =>
					terminal
						.output()
						.includes(
							`seat key:${key.fingerprint} xterm-256color 100x30 pty=true env={"COLORTERM":"truecolor"} client=OpenSSH|`
						)
				);
				terminal.resize(120, 40);
				yield* waitFor("the resize", () =>
					terminal.output().includes("resize 120x40|")
				);
				terminal.write("x");
				yield* waitFor("the echo", () => terminal.output().includes("echo:x|"));
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					5
				);
			})
	);

	effect("a player who leaves closes their channel at the GM", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay();
			const { gm } = yield* openTable(relay);
			const key = yield* clientKey(yield* tempDir, "vex");

			const terminal = yield* sshShell(
				relay.playerPort,
				{ cols: 80, rows: 24 },
				{ key }
			);

			yield* waitFor("the seat", () => terminal.output().includes("seat key:"));
			terminal.kill();
			yield* waitFor("the GM's session to end", () =>
				gm.ended.includes(`key:${key.fingerprint}`)
			);
		})
	);
});

describe("relay: shutting down", () => {
	effect(
		"a relay that stops puts seated terminals back before it says so",
		() =>
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const relay = yield* startRelay().pipe(Scope.provide(scope));
				yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");

				const seated = yield* sshShell(
					relay.playerPort,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the seat", () => seated.output().includes("seat key:"));
				yield* Scope.close(scope, Exit.void);
				expect(yield* Effect.promise(async () => await seated.exited)).toBe(1);
				expect(seated.output()).toContain(
					`${TERMINAL_RESET}\r\nThe relay is shutting down.\r\n`
				);
			})
	);
});

describe("relay: handles", () => {
	effect(
		"a closed table says so; a name that's no table, or one ssh sends by default, gets the join hint",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const key = yield* clientKey(yield* tempDir, "vex");

				const unknown = yield* sshExec(relay.playerPort, ["hi"], {
					key,
					user: "nobody/nowhere",
				});

				expect(unknown).toMatchObject({
					stdout: "",
					stderr: `${closedTableMessage("nobody/nowhere")}\n`,
					exitCode: 1,
				});

				for (const user of ["Not_A-Table", "root", "ubuntu", "nowhere"]) {
					const odd = yield* sshExec(relay.playerPort, ["hi"], { key, user });
					expect(odd).toMatchObject({ stderr: `${JOIN_HINT}\n`, exitCode: 1 });
				}

				const shell = yield* sshShell(
					relay.playerPort,
					{ cols: 80, rows: 24 },
					{ key, user: "nobody/nowhere" }
				);

				yield* waitFor("the lobby, saying why", () => {
					const shown = Bun.stripANSI(shell.output());

					return (
						shown.includes("join by name") &&
						shown.includes("isn't open right now")
					);
				});
				shell.write("\u0003");
				expect(yield* Effect.promise(async () => await shell.exited)).toBe(0);

				const table = yield* scoped(openTable(relay));
				yield* table.close;
				yield* linked(relay, "ana/den", false);
				const closed = yield* sshExec(relay.playerPort, ["hi"], { key });
				expect(closed).toMatchObject({
					stderr: `${closedTableMessage("ana/den")}\n`,
					exitCode: 1,
				});
			})
	);

	effect(
		"the first GM key claims a handle; another key is refused until it's forgotten",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const rightful = yield* gmTable();
				const file = path.join(relay.dir, "handles.json");

				const linkDen = (gm: Effect.Success<ReturnType<typeof gmTable>>) =>
					scoped(linkGm(gm, relay.gmPort, "den", relay.relayKeyFingerprint));

				const first = yield* linkDen(rightful);
				yield* linked(relay, "ana/den");
				const registry = yield* readRegistry(file);
				expect(Object.keys(registry)).toEqual(["ana"]);
				expect(registry.ana?.keys).toEqual([
					rightful.server.hostKeyFingerprint,
				]);
				yield* first.close;
				yield* linked(relay, "ana/den", false);

				const impostor = yield* gmTable();

				const refused = yield* linkGm(
					impostor,
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint
				);

				expect(refused.answer).toBe("OK");
				yield* waitFor("the impostor's link to be closed", refused.closed);
				expect(relay.linkedTables()).toEqual([]);
				expect(relay.logs.join("\n")).toContain(
					`handle ana: refused a GM with key ${impostor.server.hostKeyFingerprint}`
				);
				expect(yield* readRegistry(file)).toMatchObject({
					ana: { keys: [rightful.server.hostKeyFingerprint] },
				});

				const again = yield* linkDen(rightful);
				yield* linked(relay, "ana/den");
				yield* again.close;
				yield* linked(relay, "ana/den", false);

				yield* forgetHandle(file, "ana");
				yield* linkGm(impostor, relay.gmPort, "den", relay.relayKeyFingerprint);
				yield* linked(relay, "ana/den");
				expect(yield* readRegistry(file)).toMatchObject({
					ana: { keys: [impostor.server.hostKeyFingerprint] },
				});
			})
	);

	effect(
		"one GM key opens several tables under its handle, and the relay sees the GM key, not each campaign's",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const gmKey = yield* gmTable();

				const pem = yield* Effect.promise(
					async () => await readFile(gmKey.hostKeyPath)
				);

				const den = yield* gmTable();
				const attic = yield* gmTable();

				yield* linkGm(
					{ server: den.server, hostKey: pem },
					relay.gmPort,
					"den",
					relay.relayKeyFingerprint
				);
				yield* linkGm(
					{ server: attic.server, hostKey: pem },
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint
				);
				yield* linked(relay, "ana/den");
				yield* linked(relay, "ana/attic");
				expect(
					(yield* readRegistry(path.join(relay.dir, "handles.json"))).ana?.keys
				).toEqual([gmKey.server.hostKeyFingerprint]);
				expect(den.server.hostKeyFingerprint).not.toBe(
					gmKey.server.hostKeyFingerprint
				);
			})
	);

	effect(
		"a claim code is made from the random service's bytes, so a fixed source mints a known code",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay().pipe(
					Effect.provideService(
						SecureRandom.SecureRandom,
						SecureRandom.make(counting)
					)
				);

				const { gm } = yield* openTable(relay);

				expect(
					yield* relay.mintPairing("ana", gm.server.hostKeyFingerprint)
				).toMatchObject({
					kind: "minted",
					code: codeOf(counting(PAIRING_BYTES)),
				});
			})
	);

	effect(
		"a claim code minted by a key that holds the handle adds another machine's key, once",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const { gm } = yield* openTable(relay);
				const laptop = yield* gmTable();
				const file = path.join(relay.dir, "handles.json");

				expect(
					yield* relay.mintPairing("ana", laptop.server.hostKeyFingerprint)
				).toMatchObject({ kind: "refused" });

				const minted = yield* relay.mintPairing(
					"ana",
					gm.server.hostKeyFingerprint
				);

				expect(minted.kind).toBe("minted");
				const code = minted.kind === "minted" ? minted.code : "";

				const paired = yield* linkGm(
					laptop,
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint,
					"ana",
					code
				);

				expect(paired.answer).toBe("OK");
				yield* linked(relay, "ana/attic");
				expect((yield* readRegistry(file)).ana?.keys).toEqual([
					gm.server.hostKeyFingerprint,
					laptop.server.hostKeyFingerprint,
				]);

				const stranger = yield* gmTable();

				const reused = yield* linkGm(
					stranger,
					relay.gmPort,
					"loft",
					relay.relayKeyFingerprint,
					"ana",
					code
				);

				yield* waitFor("the spent code to be refused", reused.closed);
				expect((yield* readRegistry(file)).ana?.keys).toHaveLength(2);
			})
	);

	effect(
		"a claim proof overheard on the wire can't be redeemed by another host key",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const { gm } = yield* openTable(relay);
				const laptop = yield* gmTable();
				const thief = yield* gmTable();
				const file = path.join(relay.dir, "handles.json");

				const minted = yield* relay.mintPairing(
					"ana",
					gm.server.hostKeyFingerprint
				);

				const code = minted.kind === "minted" ? minted.code : "";

				const stolen = yield* linkGm(
					thief,
					relay.gmPort,
					"loft",
					relay.relayKeyFingerprint,
					"ana",
					code,
					laptop.server.hostKeyFingerprint
				);

				yield* waitFor("the stolen proof to be refused", stolen.closed);
				expect(relay.linkedTables()).not.toContain("ana/loft");
				expect((yield* readRegistry(file)).ana?.keys).toEqual([
					gm.server.hostKeyFingerprint,
				]);
				expect(relay.logs.join("\n")).toContain(
					`with key ${thief.server.hostKeyFingerprint} that proves no live code`
				);

				const paired = yield* linkGm(
					laptop,
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint,
					"ana",
					code
				);

				expect(paired.answer).toBe("OK");
				yield* linked(relay, "ana/attic");
				expect((yield* readRegistry(file)).ana?.keys).toEqual([
					gm.server.hostKeyFingerprint,
					laptop.server.hostKeyFingerprint,
				]);
			})
	);

	effect(
		"a claim refused because the handle holds its most keys keeps its code",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ gm: { maxKeysPerHandle: 2 } });
				const { gm } = yield* openTable(relay);
				const laptop = yield* gmTable();
				const file = path.join(relay.dir, "handles.json");
				const phantom = `SHA256:${"P".repeat(43)}`;
				const own = gm.server.hostKeyFingerprint;
				const registry = yield* readRegistry(file);
				const held = registry.ana;

				expect(held).toBeDefined();

				const at = {
					claimed: held?.claimed ?? daysAgo(1),
					seen: held?.seen ?? daysAgo(0),
				};

				yield* writeRegistry(file, { ana: { keys: [own, phantom], ...at } });

				const minted = yield* relay.mintPairing("ana", own);
				const code = minted.kind === "minted" ? minted.code : "";

				const full = yield* linkGm(
					laptop,
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint,
					"ana",
					code
				);

				yield* waitFor("the full handle to refuse the key", full.closed);
				expect(relay.logs.join("\n")).toContain(
					`handle ana: refused key ${laptop.server.hostKeyFingerprint}: it holds its most keys (2)`
				);
				expect((yield* readRegistry(file)).ana?.keys).toEqual([own, phantom]);

				yield* writeRegistry(file, { ana: { keys: [own], ...at } });

				const paired = yield* linkGm(
					laptop,
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint,
					"ana",
					code
				);

				expect(paired.answer).toBe("OK");
				yield* linked(relay, "ana/attic");
				expect((yield* readRegistry(file)).ana?.keys).toEqual([
					own,
					laptop.server.hostKeyFingerprint,
				]);
			})
	);

	effect("a handle opens so many tables at once", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay({ gm: { tablesPerHandle: 1 } });
			const { gm } = yield* openTable(relay);

			const second = yield* linkGm(
				gm,
				relay.gmPort,
				"attic",
				relay.relayKeyFingerprint
			);

			yield* waitFor("the second table to be refused", second.closed);
			expect(second.answer).toBe(
				"ERR the handle ana has 1 tables open already"
			);
			expect(relay.linkedTables()).toEqual(["ana/den"]);
		})
	);

	effect(
		"the same GM linking a table again replaces its old link at once",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const { gm, link: old } = yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");

				const seated = yield* sshShell(
					relay.playerPort,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the seat", () => seated.output().includes("seat key:"));

				const fresh = yield* linkGm(
					gm,
					relay.gmPort,
					"den",
					relay.relayKeyFingerprint
				);

				expect(fresh.answer).toBe("OK");
				yield* waitFor("the old link to close", old.closed);
				yield* waitFor("the notice", () =>
					seated.output().includes("The table closed.")
				);
				expect(yield* Effect.promise(async () => await seated.exited)).toBe(1);
				expect(fresh.closed()).toBe(false);
				expect(
					(yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode
				).toBe(0);
			})
	);

	effect(
		"a handle no GM has linked for --claim-days lapses, and another GM key claims it",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const file = path.join(dir, "handles.json");
				const gone = `SHA256:${"A".repeat(43)}`;
				const lapsed = daysAgo(8);

				yield* writeRegistry(file, {
					ana: { keys: [gone], claimed: daysAgo(20), seen: lapsed },
					bo: { keys: [gone], claimed: daysAgo(20), seen: daysAgo(6) },
				});

				const relay = yield* startRelay({ dir, gm: { claimDays: 7 } });
				const newcomer = yield* gmTable();
				yield* linkGm(newcomer, relay.gmPort, "den", relay.relayKeyFingerprint);
				yield* linked(relay, "ana/den");
				expect(relay.logs.join("\n")).toContain(
					`handle ana: dropped the claim of GM keys ${gone}, last seen ${lapsed}\n`
				);

				const bo = yield* linkGm(
					yield* gmTable(),
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint,
					"bo"
				);

				yield* waitFor("the second GM to be refused", bo.closed);

				expect(yield* readRegistry(file)).toMatchObject({
					ana: { keys: [newcomer.server.hostKeyFingerprint] },
					bo: { keys: [gone] },
				});
			})
	);

	effect("a GM's link renews its handle when it begins and when it ends", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay();
			const file = path.join(relay.dir, "handles.json");

			const seenAt = () =>
				readRegistry(file).pipe(
					Effect.map((handles) => millisOf(handles.ana?.seen ?? ""))
				);

			const table = yield* scoped(openTable(relay));
			const began = yield* seenAt();
			const stored = (yield* readRegistry(file)).ana;
			expect(millisOf(stored?.seen ?? "")).toBeGreaterThanOrEqual(
				millisOf(stored?.claimed ?? "")
			);
			yield* Effect.sleep("20 millis");
			yield* table.close;
			yield* linked(relay, "ana/den", false);

			for (
				let tries = 0;
				(yield* seenAt()) === began && tries < 100;
				tries += 1
			) {
				yield* Effect.sleep("20 millis");
			}

			expect(yield* seenAt()).toBeGreaterThan(began);
		})
	);

	effect(
		"a full registry refuses a new handle; only a lapsed claim makes way, never one still live",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const file = path.join(dir, "handles.json");
				const absent = `SHA256:${"A".repeat(43)}`;
				const lapsed = daysAgo(31);

				yield* writeRegistry(file, {
					attic: { keys: [absent], claimed: lapsed, seen: lapsed },
					den: { keys: [absent], claimed: daysAgo(2), seen: daysAgo(1) },
				});

				const relay = yield* startRelay({ dir, gm: { maxHandles: 2 } });
				yield* openTable(relay, "den", "ana");
				expect(relay.logs.join("\n")).toContain(
					`handle attic: dropped the claim of GM keys ${absent}, last seen ${lapsed}, to make room for ana`
				);

				expect(yield* handlesIn(file)).toEqual(["ana", "den"]);

				const second = yield* linkGm(
					yield* gmTable(),
					relay.gmPort,
					"den",
					relay.relayKeyFingerprint,
					"bo"
				);

				yield* waitFor("the second claim to be refused", second.closed);
				expect(second.answer).toBe(
					"ERR the relay holds its most handles; try again later"
				);
				expect(relay.logs.join("\n")).toContain(
					"handle bo: refused: the relay holds its most handles (2), none lapsed"
				);
				expect(yield* handlesIn(file)).toEqual(["ana", "den"]);
			})
	);

	effect(
		"a relay from protocol 1 sets its rooms.json aside and starts handles afresh",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* Effect.promise(async () => {
					await writeFile(path.join(dir, "rooms.json"), LEGACY_ROOMS, {
						mode: 0o600,
					});
				});

				const relay = yield* startRelay({ dir });
				expect(yield* fileThere(path.join(dir, "rooms.json"))).toBe(false);
				expect(yield* fileThere(path.join(dir, "rooms.json.legacy"))).toBe(
					true
				);
				expect(relay.logs.join("\n")).toContain("rooms.json.legacy");
				yield* openTable(relay);
			})
	);

	effect(
		"a GM link that drops tells shells the table closed and fails execs",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const { link } = yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");

				const seated = yield* sshShell(
					relay.playerPort,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the seat", () => seated.output().includes("seat key:"));

				const waiting = yield* Effect.forkChild(
					sshExec(relay.playerPort, ["wait"], { key })
				);

				yield* Effect.sleep("300 millis");
				link.socket.destroy();
				yield* waitFor("the notice", () =>
					seated.output().includes("The table closed.\r\n")
				);
				expect(yield* Effect.promise(async () => await seated.exited)).toBe(1);
				const exec = yield* Fiber.join(waiting);
				expect(exec.exitCode).toBe(1);
				expect(exec.stderr).toContain("The table closed.");
			})
	);

	effect("a GM whose host doesn't trust this relay's key never links", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay();
			const gm = yield* gmTable();

			const link = yield* linkGm(
				gm,
				relay.gmPort,
				"den",
				`SHA256:${"Z".repeat(43)}`
			);

			yield* waitFor("the link to close", link.closed);
			expect(relay.linkedTables()).toEqual([]);
			expect(relay.logs.join("\n")).toContain("refused this relay's key");
		})
	);

	effect(
		"a bad hello is answered with ERR, and a protocol 1 host is told to upgrade",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();

				const bad = yield* dial(relay.gmPort);
				bad.socket.write("SUPERVILLAIN 2 TABLE Bad_Handle/den\n");
				const answer = yield* readLine(bad.socket);
				yield* socketClosed(bad.socket);
				expect(answer).toStartWith("ERR ");

				const old = yield* dial(relay.gmPort);
				old.socket.write("SUPERVILLAIN 1 ROOM den\n");
				const upgrade = yield* readLine(old.socket);
				yield* socketClosed(old.socket);
				expect(upgrade).toStartWith("ERR this relay speaks protocol 2");
				expect(relay.linkedTables()).toEqual([]);
			})
	);
});

describe("relay: the returning player's shorthand", () => {
	effect(
		"a bare table name seats a key straight at the one open table of that name that knows it",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const key = yield* clientKey(yield* tempDir, "vex");
				const actor = `key:${key.fingerprint}`;
				yield* openTable(relay, "den", "ana", { knows: { actors: [actor] } });
				yield* openTable(relay, "den", "bo", { knows: { actors: [] } });

				for (const user of ["den", "ana"]) {
					const seated = yield* sshExec(relay.playerPort, ["hi"], {
						key,
						user,
					});

					expect(seated).toMatchObject({
						stdout: `exec ${actor} hi\n`,
						exitCode: 0,
					});
					expect(seated.stderr).toStartWith("Joining ana/den…\n");
				}
			})
	);

	effect(
		"two open tables of that name that know the key make the player pick",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const key = yield* clientKey(yield* tempDir, "vex");
				const actor = `key:${key.fingerprint}`;
				yield* openTable(relay, "den", "ana", { knows: { actors: [actor] } });
				yield* openTable(relay, "den", "bo", { knows: { actors: [actor] } });

				const exec = yield* sshExec(relay.playerPort, ["hi"], {
					key,
					user: "den",
				});

				expect(exec).toMatchObject({
					stderr: `${manyMessage("den")}\n`,
					exitCode: 1,
				});

				const shell = yield* sshShell(
					relay.playerPort,
					{ cols: 100, rows: 30 },
					{ key, user: "den" }
				);

				yield* waitFor("the lobby with both", () => {
					const shown = Bun.stripANSI(shell.output());

					return shown.includes("ana/den") && shown.includes("bo/den");
				});
				shell.write("\u0003");
			})
	);

	effect(
		"a shorthand no open table answers to looks the same whether or not a table of that name is open, so strangers can't probe for one",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const key = yield* clientKey(yield* tempDir, "vex");
				yield* openTable(relay, "den", "ana", { knows: { actors: [] } });

				const none = yield* sshExec(relay.playerPort, ["hi"], {
					key,
					user: "attic",
				});

				expect(none).toMatchObject({ stderr: `${JOIN_HINT}\n`, exitCode: 1 });
				expect(
					yield* sshExec(relay.playerPort, ["hi"], { key, user: "den" })
				).toMatchObject({ stderr: none.stderr, exitCode: 1 });
				expect(
					yield* sshExec(relay.playerPort, ["hi"], { user: "den" })
				).toMatchObject({ stderr: none.stderr, exitCode: 1 });

				const shell = yield* sshShell(
					relay.playerPort,
					{ cols: 100, rows: 30 },
					{ key, user: "den" }
				);

				yield* waitFor("the lobby", () =>
					Bun.stripANSI(shell.output()).includes("join by name")
				);
				expect(Bun.stripANSI(shell.output())).not.toContain("called den");
				shell.write("\u0003");
				expect(
					yield* sshExec(relay.playerPort, ["hi"], { key, user: "ana/den" })
				).toMatchObject({ exitCode: 0 });
			})
	);
});

describe("relay: limits", () => {
	effect(
		"per-address connection caps and session rates apply to players at the relay",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({
					limits: {
						connectionsPerAddress: 1,
						sessionRate: { burst: 2, perSecond: 0.001 },
					},
				});

				yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");

				const held = yield* sshShell(
					relay.playerPort,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the seat", () => held.output().includes("seat key:"));
				expect(
					(yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode
				).toBe(255);
				yield* waitFor("the refusal in the log", () =>
					relay.logs.some((l) =>
						l.includes("refused a connection from 127.0.0.1")
					)
				);
				held.kill();
				yield* Effect.promise(async () => await held.exited);
				yield* Effect.sleep("100 millis");
				expect(
					(yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode
				).toBe(0);
				const third = yield* sshExec(relay.playerPort, ["hi"], { key });
				expect(third).toMatchObject({ exitCode: 255, stdout: "" });
			})
	);

	effect(
		"a table seats so many players at once; the next is told it's full",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ sessionsPerTable: 1 });
				yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");

				const held = yield* sshShell(
					relay.playerPort,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the seat", () => held.output().includes("seat key:"));
				const turned = yield* sshExec(relay.playerPort, ["hi"], { key });
				expect(turned).toMatchObject({
					exitCode: 1,
					stderr: "ana/den is full right now.\n",
				});
				held.kill();
				yield* Effect.promise(async () => await held.exited);
				yield* Effect.sleep("200 millis");
				expect(
					(yield* sshExec(relay.playerPort, ["hi"], { key })).exitCode
				).toBe(0);
			})
	);

	effect(
		"a player who gives up while a slow host seats them gives their place back at once",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ sessionsPerTable: 1 });
				const { link } = yield* openTable(relay);
				const key = yield* clientKey(yield* tempDir, "vex");
				link.socket.pause();

				const leaving = yield* sshShell(
					relay.playerPort,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* Effect.sleep("500 millis");
				leaving.kill();
				yield* Effect.promise(async () => await leaving.exited);
				yield* Effect.sleep("200 millis");

				const next = yield* Effect.forkScoped(
					sshExec(relay.playerPort, ["hi"], { key })
				);

				yield* Effect.sleep("500 millis");
				link.socket.resume();
				expect((yield* Fiber.join(next)).exitCode).toBe(0);
			})
	);

	effect(
		"linked GMs count apart from links still saying hello, and links are capped",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({ gm: { pendingLinks: 1, links: 2 } });
				yield* openTable(relay, "den", "ana");
				yield* openTable(relay, "attic", "bo");

				const third = yield* linkGm(
					yield* gmTable(),
					relay.gmPort,
					"cellar",
					relay.relayKeyFingerprint,
					"cy"
				);

				yield* waitFor("the third GM to be refused", third.closed);
				expect(third.answer).toBe(
					"ERR the relay has its most GMs linked; try again later"
				);
				expect(relay.logs.join("\n")).toContain(
					"table cy/cellar: refused: the relay has its most GMs linked (2)"
				);
				expect(relay.linkedTables().toSorted()).toEqual([
					"ana/den",
					"bo/attic",
				]);

				expect(yield* handlesIn(path.join(relay.dir, "handles.json"))).toEqual([
					"ana",
					"bo",
				]);
			})
	);

	effect(
		"handles are claimed at a rate per address and up to a total; held handles relink",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay({
					gm: { claimRate: { burst: 1, perSecond: 0.0001 } },
				});

				const { gm, link } = yield* openTable(relay, "den", "ana");

				const squatter = yield* linkGm(
					yield* gmTable(),
					relay.gmPort,
					"attic",
					relay.relayKeyFingerprint,
					"bo"
				);

				yield* waitFor("the second claim to be refused", squatter.closed);
				expect(squatter.answer).toBe(
					"ERR this address claims handles too fast; try again later"
				);
				expect(relay.logs.join("\n")).toContain(
					"handle bo: refused: 127.0.0.1 claims handles too fast"
				);
				link.socket.destroy();
				yield* linked(relay, "ana/den", false);
				yield* linkGm(gm, relay.gmPort, "den", relay.relayKeyFingerprint);
				yield* linked(relay, "ana/den");

				const full = yield* startRelay({ gm: { maxHandles: 1 } });
				yield* openTable(full, "den", "ana");

				const over = yield* linkGm(
					yield* gmTable(),
					full.gmPort,
					"attic",
					full.relayKeyFingerprint,
					"bo"
				);

				yield* waitFor("the claim past the total to be refused", over.closed);
				expect(over.answer).toBe(
					"ERR the relay holds its most handles; try again later"
				);
				expect(full.logs.join("\n")).toContain(
					"handle bo: refused: the relay holds its most handles (1), none lapsed"
				);

				expect(yield* handlesIn(path.join(full.dir, "handles.json"))).toEqual([
					"ana",
				]);
			})
	);

	effect(
		"only a claim made counts against the rate: failed logins for a free handle don't",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const gm = yield* gmTable();

				for (const i of [1, 2, 3]) {
					const failed = yield* linkGm(
						gm,
						relay.gmPort,
						"den",
						"SHA256:not-this-relay"
					);

					expect(failed.answer).toBe("OK");
					yield* waitFor(`failed login ${i} to end`, failed.closed);
				}

				expect(relay.linkedTables()).toEqual([]);

				const good = yield* linkGm(
					gm,
					relay.gmPort,
					"den",
					relay.relayKeyFingerprint
				);

				expect(good.answer).toBe("OK");
				yield* linked(relay, "ana/den");
				expect(relay.logs.join("\n")).toContain(
					"handle ana: claimed by GM key"
				);
				expect(relay.logs.join("\n")).not.toContain("claims handles too fast");
			})
	);

	effect("GM links are capped per address, and a silent one is cut", () =>
		Effect.gen(function* () {
			const relay = yield* startRelay({
				gm: { linksPerAddress: 2, lineTimeoutMs: 200 },
			});

			const open = () => dial(relay.gmPort);

			const a = yield* open();
			const b = yield* open();
			const c = yield* open();
			yield* waitFor("the third link to be refused", c.closed, 3000);
			expect(a.closed() || b.closed()).toBe(false);
			yield* waitFor(
				"the silent links to be cut",
				() => a.closed() && b.closed(),
				4000
			);
			const gm = yield* gmTable();

			const link = yield* linkGm(
				gm,
				relay.gmPort,
				"den",
				relay.relayKeyFingerprint
			);

			expect(link.answer).toBe("OK");
			yield* linked(relay, "ana/den");
		})
	);
});

describe("relay: claim rates", () => {
	effect("claims count per IPv4 address, and per IPv6 /64 and /48 both", () =>
		Effect.sync(() => {
			const one = { burst: 1, perSecond: 1 / 3600 };
			const limiter = claimLimiter(one, { burst: 2, perSecond: 1 / 3600 });
			expect(limiter.over("198.51.100.1", 0)).toBeUndefined();
			expect(limiter.over("198.51.100.1", 0)).toBeUndefined();

			const allowed = (address: string, now: number) => {
				const over = limiter.over(address, now);

				if (over === undefined) {
					limiter.spend(address, now);
				}

				return over;
			};

			expect(allowed("203.0.113.7", 0)).toBeUndefined();
			expect(allowed("203.0.113.7", 1)).toBe("203.0.113.7");
			expect(allowed("203.0.113.8", 1)).toBeUndefined();
			expect(allowed("2001:db8:1:1::1", 0)).toBeUndefined();
			expect(allowed("2001:db8:1:1::2", 0)).toBe("2001:db8:1:1::/64");
			expect(allowed("2001:db8:1:2::1", 0)).toBeUndefined();
			expect(allowed("2001:db8:1:3::1", 0)).toBe("2001:db8:1::/48");
			expect(allowed("2001:db8:2:3::1", 0)).toBeUndefined();
			expect(allowed("2001:db8:1:3::1", 3_600_000)).toBeUndefined();
		})
	);
});
