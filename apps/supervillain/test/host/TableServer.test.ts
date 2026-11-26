import { describe, expect, test } from "bun:test";

import type { SessionInfo } from "@supervillain/ssh";
import { Context, Effect, Layer, Logger } from "effect";

import { Knocks } from "../../src/host/Knocks.ts";
import { runLine } from "../../src/host/line.ts";
import type { Reply } from "../../src/host/line.ts";
import { Presence } from "../../src/host/Presence.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import type { TableRoomOptions } from "../../src/host/TableRoom.ts";
import {
	fingerprintOf,
	inviteOf,
	KNOCK_OVER_EXEC,
	knockBucketOf,
	rateKeyOf,
	TableServer,
} from "../../src/host/TableServer.ts";
import type { TableServerOptions } from "../../src/host/TableServer.ts";
import { clientKey, sshExec, sshShell, waitFor } from "../e2e/openssh.ts";
import { startRelay } from "../relay/harness.ts";
import { sshExec as relayExec } from "../relay/openssh.ts";
import { openCampaign } from "./campaign.ts";
import { effect } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const servedTable = (
	more: Partial<TableServerOptions> = {},
	roomOptions: TableRoomOptions = {},
	door: "knock" | "open" = "open"
) =>
	Effect.gen(function* () {
		const dir = door === "open" ? yield* openCampaign : yield* tempDir;

		const layer = TableServer.layer({
			campaignDir: dir,
			room: "den",
			port: 0,
			bind: "127.0.0.1",
			...more,
		}).pipe(Layer.provideMerge(tableServices(dir, roomOptions)));

		const context = yield* Layer.build(
			layer.pipe(Layer.provide(Logger.layer([])))
		);

		const run = Effect.runSyncWith(context);
		const presence = Context.get(context, Presence);
		const knocks = Context.get(context, Knocks);

		const gm = (line: string): Effect.Effect<Reply> =>
			Effect.promise(
				async () => await Effect.runPromiseWith(context)(runLine("gm", line))
			);

		const state = () => run(Context.get(context, TableRoom).state);

		return {
			port: Context.get(context, TableServer).port,
			here: () => run(presence.here.get),
			knocking: () => run(knocks.pending.get),
			gm,
			state,
		};
	});

const replyText = (reply: Reply): string =>
	reply.kind === "message" || reply.kind === "refusal"
		? reply.text
		: JSON.stringify(reply);

const TOKEN = /~(?<token>[0-9a-z]{16})@/u;

const INVITE_TOKEN = /^Invite ~(?<token>[0-9a-z]{16}) /u;

describe("TableServer", () => {
	effect(
		"an ssh seat is present while its session lasts: Ctrl-C or a dropped client ends it",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable();
				const keys = yield* tempDir;
				const vex = yield* clientKey(keys, "vex");
				const wren = yield* clientKey(keys, "wren");
				const { here } = table;

				const first = yield* sshShell(table.port, vex);
				const second = yield* sshShell(table.port, wren);
				yield* waitFor("both seats", () => here().length === 2);
				expect(here()).toContain(`key:${vex.fingerprint}`);

				first.write("\u0003");
				yield* waitFor("Vex to leave", () => here().length === 1);
				expect(here()).toEqual([`key:${wren.fingerprint}`]);
				expect(yield* Effect.promise(async () => await first.exited)).toBe(0);

				second.kill();
				yield* waitFor(
					"Wren's dropped seat to close",
					() => here().length === 0
				);
			}),
		20_000
	);

	effect(
		"one-off commands from one address are held to a rate, refused on stderr past it",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable({
					execRate: { burst: 3, perSecond: 0.1 },
				});

				const vex = yield* clientKey(yield* tempDir, "vex");

				for (const _n of Array.from({ length: 3 })) {
					expect((yield* sshExec(table.port, "help", vex)).exitCode).toBe(0);
				}

				expect(yield* sshExec(table.port, "help", vex)).toMatchObject({
					exitCode: 1,
					stdout: "",
					stderr: "Too many commands from your address; wait a moment.\n",
				});
			}),
		20_000
	);

	effect(
		"behind a relay, each player's one-off commands are rated as that player, not the relay's address",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				yield* servedTable({
					execRate: { burst: 2, perSecond: 0.01 },
					relay: {
						host: "127.0.0.1",
						port: relay.gmPort,
						relayKey: relay.relayKeyFingerprint,
						handle: "ana",
					},
				});
				yield* waitFor(
					"the link",
					() => relay.linkedTables().includes("ana/den"),
					10_000
				);
				const keys = yield* tempDir;
				const vex = yield* clientKey(keys, "vex");
				const kai = yield* clientKey(keys, "kai");

				const through = (key: typeof vex) =>
					relayExec(relay.playerPort, ["help"], { key });

				expect((yield* through(vex)).exitCode).toBe(0);
				expect((yield* through(vex)).exitCode).toBe(0);
				expect(yield* through(vex)).toMatchObject({
					exitCode: 1,
					stderr: "Too many commands from your address; wait a moment.\n",
				});
				expect((yield* through(kai)).exitCode).toBe(0);
			}),
		20_000
	);

	effect(
		"guests from one address share one rate, however many connections they open",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable(
					{},
					{ playerRate: { burst: 2, perSecond: 0.01 } }
				);

				expect((yield* sshExec(table.port, "/say one")).exitCode).toBe(0);
				expect((yield* sshExec(table.port, "/say two")).exitCode).toBe(0);
				expect(yield* sshExec(table.port, "/say three")).toMatchObject({
					exitCode: 1,
					stderr: "You're sending lines too fast; wait a moment.\n",
				});
				const vex = yield* clientKey(yield* tempDir, "vex");
				expect((yield* sshExec(table.port, "/say mine", vex)).exitCode).toBe(0);
			}),
		20_000
	);

	effect(
		"guest seats from one address share that rate too",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable(
					{},
					{ playerRate: { burst: 2, perSecond: 0.01 } }
				);

				const ann = yield* sshShell(table.port);
				const bea = yield* sshShell(table.port);
				yield* waitFor("both seats", () => table.here().length === 2);
				yield* waitFor("Ann's name prompt", () =>
					ann.text().includes("call you?")
				);
				ann.write("Ann\r");
				yield* waitFor("Ann named", () =>
					ann.text().includes("Ann joins the table")
				);
				yield* waitFor("Bea's name prompt", () =>
					bea.text().includes("call you?")
				);
				bea.write("Bea\r");
				yield* waitFor("Bea named", () =>
					bea.text().includes("Bea joins the table")
				);
				bea.write("hello\r");
				yield* waitFor("Bea held back", () =>
					bea.text().includes("You're sending lines too fast")
				);
			}),
		20_000
	);

	effect(
		"a shell without a terminal is told how to connect, and no seat opens",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable();
				const result = yield* sshExec(table.port, "");
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain("ssh -t");
				expect(result.stderr).toContain("help");
				expect(table.here()).toEqual([]);
			}),
		20_000
	);
});

const info = (
	identity: SessionInfo["identity"],
	more: Partial<SessionInfo> = {}
): SessionInfo => ({
	identity,
	user: "den",
	term: "xterm-256color",
	cols: 80,
	rows: 24,
	env: {},
	remoteAddress: "203.0.113.7",
	client: "OpenSSH_10.0",
	...more,
});

const key = (actor: `key:${string}`) =>
	({
		kind: "key",
		actor,
		fingerprint: actor.slice(4),
		algorithm: "ssh-ed25519",
	}) as const;

describe("rateKeyOf", () => {
	const PLAYER: `key:${string}` = `key:SHA256:${"p".repeat(43)}`;
	const RELAY: `key:${string}` = `key:SHA256:${"r".repeat(43)}`;

	test("a key is rated as itself, a guest by the address it came from", () => {
		expect(rateKeyOf(info(key(PLAYER)))).toBe(PLAYER);
		expect(rateKeyOf(info({ kind: "guest", actor: "guest:abc" }))).toBe(
			"address:203.0.113.7"
		);
		expect(rateKeyOf(info({ kind: "guest", actor: "guest:xyz" }))).toBe(
			"address:203.0.113.7"
		);

		const v6 = (remoteAddress: string) =>
			rateKeyOf(info({ kind: "guest", actor: "guest:abc" }, { remoteAddress }));

		expect(v6("2001:db8:1:1::7")).toBe(v6("2001:db8:1:1::8"));
	});

	test("through a relay, a key is still itself and a guest is the relay's guest", () => {
		expect(rateKeyOf(info(key(RELAY), { relayedActor: PLAYER }))).toBe(PLAYER);
		expect(rateKeyOf(info(key(RELAY), { relayedActor: "guest:abc" }))).toBe(
			`relay:${RELAY}/guest:abc`
		);
		expect(rateKeyOf(info(key(RELAY), { relayedActor: "guest:xyz" }))).toBe(
			`relay:${RELAY}/guest:xyz`
		);
	});

	test("an invite rides after ~ in a direct user name, or from the trusted relay only", () => {
		expect(inviteOf(info(key(PLAYER), { user: "den~abc123" }))).toBe("abc123");
		expect(inviteOf(info(key(PLAYER)))).toBeUndefined();
		expect(
			inviteOf(
				info(key(RELAY), {
					user: "ana/den~forged",
					relayedActor: PLAYER,
					relayedInvite: "fromrelay",
				})
			)
		).toBe("fromrelay");
		expect(
			inviteOf(info(key(RELAY), { user: "x~forged", relayedActor: PLAYER }))
		).toBeUndefined();
	});

	test("a knock is rated by its address directly, by the relay's opaque address bucket through a relay", () => {
		const bucket = "b".repeat(43);
		expect(knockBucketOf(info(key(PLAYER)))).toBe("address:203.0.113.7");
		expect(knockBucketOf(info(key(RELAY), { relayedActor: PLAYER }))).toBe(
			PLAYER
		);
		expect(
			knockBucketOf(
				info(key(RELAY), { relayedActor: PLAYER, relayedBucket: bucket })
			)
		).toBe(`relayed:${key(RELAY).actor}/${bucket}`);
		expect(fingerprintOf(info(key(PLAYER)))).toBe(PLAYER.slice(4));
		expect(fingerprintOf(info({ kind: "guest", actor: "guest:abc" }))).toBe(
			"guest:abc"
		);
	});
});

const knockServer = (more: Partial<TableServerOptions> = {}) =>
	servedTable(more, {}, "knock");

describe("knock to join", () => {
	effect(
		"a stranger names themself at the door, the GM sees the knock with the key, and /admit seats them",
		() =>
			Effect.gen(function* () {
				const table = yield* knockServer();
				const ana = yield* clientKey(yield* tempDir, "ana");
				const short = ana.fingerprint.slice(7, 15);
				const door = yield* sshShell(table.port, ana);
				yield* waitFor("the door", () =>
					door.text().includes("lets players in by knocking")
				);
				expect(door.text()).toContain(short);
				expect(table.here()).toEqual([]);
				door.write("Ana\r");
				yield* waitFor("the knock", () => table.knocking().length === 1);
				expect(table.knocking()[0]).toMatchObject({
					actor: `key:${ana.fingerprint}`,
					name: "Ana",
					fingerprint: ana.fingerprint,
				});
				yield* waitFor("waiting", () =>
					door.text().includes("Knocking as Ana")
				);

				expect(replyText(yield* table.gm(`/admit ${short}`))).toContain(
					"Ana joins the table."
				);
				yield* waitFor("the table", () =>
					door.text().includes("say something, or /help")
				);
				yield* waitFor("seated", () => table.here().length === 1);
				expect(table.knocking()).toEqual([]);
				expect(table.state().core.members).toEqual({
					[`key:${ana.fingerprint}`]: "in",
				});
				door.write("hello\r");
				yield* waitFor("Ana's chat", () => door.text().includes("Ana: hello"));
			}),
		20_000
	);

	effect(
		"a name the table already uses is refused at the door, the same way /name refuses it",
		() =>
			Effect.gen(function* () {
				const table = yield* knockServer();
				const ana = yield* clientKey(yield* tempDir, "ana");
				const door = yield* sshShell(table.port, ana);
				yield* waitFor("the door", () =>
					door.text().includes("lets players in by knocking")
				);
				door.write("GM\r");
				yield* waitFor("the refusal", () =>
					door.text().includes('"GM" is taken; pick another name.')
				);
				expect(table.knocking()).toEqual([]);
			}),
		20_000
	);

	effect(
		"/deny turns the knocker away, closes their door and holds their key off for a while",
		() =>
			Effect.gen(function* () {
				const table = yield* knockServer();
				const bo = yield* clientKey(yield* tempDir, "bo");
				const door = yield* sshShell(table.port, bo);
				yield* waitFor("the door", () =>
					door.text().includes("lets players in by knocking")
				);
				door.write("Bo\r");
				yield* waitFor("the knock", () => table.knocking().length === 1);
				expect(replyText(yield* table.gm("/deny Bo"))).toContain(
					"Turned away Bo"
				);
				yield* waitFor("the door's answer", () =>
					door.text().includes("The GM didn't")
				);
				expect(yield* Effect.promise(async () => await door.exited)).toBe(0);
				expect(table.state().core.members).toEqual({});

				const again = yield* sshShell(table.port, bo);
				yield* waitFor("the door again", () =>
					again.text().includes("lets players in by knocking")
				);
				again.write("Bo\r");
				yield* waitFor("the cooldown", () =>
					again.text().includes("turned you away")
				);
				expect(table.knocking()).toEqual([]);
			}),
		20_000
	);

	effect(
		"through a relay, /deny holds the address off under a fresh key or as a fresh guest, and one address holds 3 knocks at most",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();

				const table = yield* knockServer({
					relay: {
						host: "127.0.0.1",
						port: relay.gmPort,
						relayKey: relay.relayKeyFingerprint,
						handle: "ana",
					},
				});

				yield* waitFor(
					"the link",
					() => relay.linkedTables().includes("ana/den"),
					10_000
				);

				const keys = yield* tempDir;

				const knockAs = (
					name: string,
					with_: Effect.Success<ReturnType<typeof clientKey>> | undefined
				) =>
					Effect.gen(function* () {
						const door = yield* sshShell(relay.playerPort, with_, "ana/den");
						yield* waitFor(`${name}'s door`, () =>
							door.text().includes("lets players in by knocking")
						);
						door.write(`${name}\r`);

						return door;
					});

				const keyed = Effect.forEach(
					["k1", "k2", "k3", "k4"],
					(name) => clientKey(keys, name),
					{ concurrency: 1 }
				);

				const [one, two, three, four] = yield* keyed;

				for (const [name, held] of [
					["Ann", one],
					["Bea", two],
					["Cal", three],
				] as const) {
					yield* knockAs(name, held);
				}

				yield* waitFor("three knocks", () => table.knocking().length === 3);
				const fourth = yield* knockAs("Dot", four);
				yield* waitFor("the fourth refused", () =>
					fourth.text().includes("Too many knocks from your address")
				);
				expect(table.knocking().map((k) => k.name)).toEqual([
					"Ann",
					"Bea",
					"Cal",
				]);

				expect(replyText(yield* table.gm("/deny Ann"))).toContain(
					"Turned away Ann"
				);

				const fresh = yield* clientKey(keys, "fresh");
				const rekeyed = yield* knockAs("Eve", fresh);
				yield* waitFor("the fresh key turned away", () =>
					rekeyed.text().includes("turned you away")
				);

				const guest = yield* knockAs("Gus", undefined);
				yield* waitFor("the fresh guest turned away", () =>
					guest.text().includes("turned you away")
				);
				expect(table.knocking().map((k) => k.name)).toEqual(["Bea", "Cal"]);
			}),
		30_000
	);

	effect("one-off commands from a stranger are refused on stderr", () =>
		Effect.gen(function* () {
			const table = yield* knockServer();
			const cy = yield* clientKey(yield* tempDir, "cy");

			expect(yield* sshExec(table.port, "roll 2d10", cy)).toMatchObject({
				exitCode: 1,
				stdout: "",
				stderr: `${KNOCK_OVER_EXEC}\n`,
			});
			expect(table.state().seq).toBe(0);
		})
	);

	effect(
		"an invite seats a new player without a knock, then runs out",
		() =>
			Effect.gen(function* () {
				const table = yield* knockServer();
				const invite = replyText(yield* table.gm("/invite 1 30"));

				const token =
					INVITE_TOKEN.exec(invite)?.groups?.token ??
					TOKEN.exec(invite)?.groups?.token;

				expect(token).toBeDefined();
				const keys = yield* tempDir;
				const dee = yield* clientKey(keys, "dee");
				const door = yield* sshShell(table.port, dee, `den~${token ?? ""}`);
				yield* waitFor("the invite", () =>
					door.text().includes("You have an invite")
				);
				door.write("Dee\r");
				yield* waitFor("the table", () =>
					door.text().includes("say something, or /help")
				);
				expect(table.knocking()).toEqual([]);
				expect(table.state().feed.at(-1)?.text).toBe("Dee joins the table.");

				const eve = yield* clientKey(keys, "eve");
				const late = yield* sshShell(table.port, eve, `den~${token ?? ""}`);
				yield* waitFor("a plain door", () =>
					late.text().includes("lets players in by knocking")
				);
			}),
		20_000
	);

	effect(
		"/kick closes a member's live seat, and they must knock to come back",
		() =>
			Effect.gen(function* () {
				const table = yield* knockServer();
				const fay = yield* clientKey(yield* tempDir, "fay");
				const door = yield* sshShell(table.port, fay);
				yield* waitFor("the door", () =>
					door.text().includes("lets players in by knocking")
				);
				door.write("Fay\r");
				yield* waitFor("the knock", () => table.knocking().length === 1);
				yield* table.gm("/admit Fay");
				yield* waitFor("seated", () => table.here().length === 1);
				expect(replyText(yield* table.gm("/kick Fay"))).toContain(
					"Fay was removed from the table."
				);
				yield* waitFor("Fay's seat closed", () => table.here().length === 0);

				const back = yield* sshShell(table.port, fay);
				yield* waitFor("the door again", () =>
					back.text().includes("lets players in by knocking")
				);
			}),
		20_000
	);

	effect(
		"a /kicked member's live invite doesn't seat them again: they knock, and the invite keeps its uses",
		() =>
			Effect.gen(function* () {
				const table = yield* knockServer();
				const keys = yield* tempDir;
				const fay = yield* clientKey(keys, "fay");
				const invite = replyText(yield* table.gm("/invite 3 30"));

				const token =
					INVITE_TOKEN.exec(invite)?.groups?.token ??
					TOKEN.exec(invite)?.groups?.token ??
					"";

				expect(token).not.toBe("");
				const first = yield* sshShell(table.port, fay, `den~${token}`);
				yield* waitFor("the invite", () =>
					first.text().includes("You have an invite")
				);
				first.write("Fay\r");
				yield* waitFor("seated", () => table.here().length === 1);
				expect(replyText(yield* table.gm("/kick Fay"))).toContain(
					"Fay was removed from the table."
				);
				yield* waitFor("Fay's seat closed", () => table.here().length === 0);

				const back = yield* sshShell(table.port, fay, `den~${token}`);
				yield* waitFor("a plain door", () =>
					back.text().includes("lets players in by knocking")
				);
				expect(back.text()).not.toContain("You have an invite");
				back.write("Fay\r");
				yield* waitFor("the knock", () => table.knocking().length === 1);
				expect(table.state().core.members[`key:${fay.fingerprint}`]).toBe(
					"out"
				);

				for (const name of ["gil", "hal"]) {
					const friend = yield* clientKey(keys, name);
					const door = yield* sshShell(table.port, friend, `den~${token}`);
					yield* waitFor(`${name}'s invite`, () =>
						door.text().includes("You have an invite")
					);
					door.write(`${name}\r`);
					yield* waitFor(`${name} seated`, () =>
						door.text().includes("say something, or /help")
					);
				}
			}),
		30_000
	);

	effect(
		"a seat closes the moment its player stops being a member: /door knock sends lurkers off",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable();
				const ivy = yield* clientKey(yield* tempDir, "ivy");
				const seat = yield* sshShell(table.port, ivy);
				yield* waitFor("seated", () => table.here().length === 1);
				yield* table.gm("/door knock");
				yield* waitFor(
					"the lurker's seat closed",
					() => table.here().length === 0
				);
				expect(yield* Effect.promise(async () => await seat.exited)).toBe(0);
			}),
		20_000
	);
});
