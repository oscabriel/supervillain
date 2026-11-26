import { describe, expect } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

import { KNOCK_FIRST } from "@supervillain/domain";
import { Context, Effect, Layer, Logger } from "effect";

import { runLine } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableServer } from "../../src/host/TableServer.ts";
import type { TableServerOptions } from "../../src/host/TableServer.ts";
import { AGENT_NEEDS_KEY } from "../../src/mcp/seat.ts";
import { KNOWS_SUBSYSTEM, MCP_SUBSYSTEM } from "../../src/relay/protocol.ts";
import { AGENTS_TOO_OLD, shorthandMessage } from "../../src/relay/server.ts";
import { openCampaign } from "../host/campaign.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { gmTable, linkGm, startRelay } from "../relay/harness.ts";
import { clientKey } from "../relay/openssh.ts";
import type { ClientKey } from "../relay/openssh.ts";
import { jsonText, lineRpc, resultOf, toolNames } from "./rpc.ts";

const env = () => {
	const { SSH_AUTH_SOCK: _, ...rest } = process.env;

	return rest;
};

const identity = (key: ClientKey | undefined) =>
	key === undefined
		? ["-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no"]
		: ["-o", "BatchMode=yes", "-i", key.path];

const subsystemArgs = (
	port: number,
	user: string,
	key: ClientKey | undefined,
	subsystem: string
) => [
	"ssh",
	"-s",
	"-F",
	"/dev/null",
	"-p",
	String(port),
	"-o",
	"StrictHostKeyChecking=no",
	"-o",
	"UserKnownHostsFile=/dev/null",
	"-o",
	"LogLevel=ERROR",
	"-o",
	"IdentityAgent=none",
	"-o",
	"IdentitiesOnly=yes",
	...identity(key),
	"-l",
	user,
	"127.0.0.1",
	subsystem,
];

const sshAgent = (
	port: number,
	user: string,
	key?: ClientKey,
	subsystem = MCP_SUBSYSTEM
) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const proc = Bun.spawn(subsystemArgs(port, user, key, subsystem), {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: env(),
			});

			let stderr = "";

			const rpc = lineRpc((text) => {
				void proc.stdin.write(text);
			});

			void (async () => {
				for await (const chunk of proc.stdout) {
					rpc.feed(chunk);
				}
			})();

			void (async () => {
				const decoder = new TextDecoder();

				for await (const chunk of proc.stderr) {
					stderr += decoder.decode(chunk, { stream: true });
				}
			})();

			const agent = {
				rpc,
				stderr: () => stderr,
				exited: proc.exited,
				end: async () => {
					await proc.stdin.end();
				},
			};

			return { agent, proc };
		}),
		({ proc }) =>
			Effect.promise(async () => {
				proc.kill("SIGKILL");
				await proc.exited;
			})
	).pipe(Effect.map(({ agent }) => agent));

type Agent = Effect.Success<ReturnType<typeof sshAgent>>;

const toolsOf = (agent: Agent) =>
	Effect.promise(async () => {
		await agent.rpc.initialize();

		return toolNames(await agent.rpc.request("tools/list"));
	});

const exitOf = (agent: Agent) => Effect.promise(async () => await agent.exited);

const servedTable = (
	more: Partial<TableServerOptions> = {},
	door: "knock" | "open" = "open"
) =>
	Effect.gen(function* () {
		const dir = door === "open" ? yield* openCampaign : yield* tempDir;

		const context = yield* Layer.build(
			TableServer.layer({
				campaignDir: dir,
				room: "den",
				port: 0,
				bind: "127.0.0.1",
				...more,
			}).pipe(
				Layer.provideMerge(tableServices(dir)),
				Layer.provide(Logger.layer([]))
			)
		);

		const gm = (line: string) =>
			Effect.promise(
				async () => await Effect.runPromiseWith(context)(runLine("gm", line))
			);

		return { dir, gm, port: Context.get(context, TableServer).port };
	});

const gmKeys = (dir: string, text: string, mode = 0o600) =>
	Effect.promise(async () => {
		const file = path.join(dir, "gm_keys");
		await writeFile(file, text);
		await chmod(file, mode);
	});

describe("mcp over ssh", () => {
	effect(
		"a seated player's agent opens mcp-1 on the table and gets a player's tools",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable();
				const vex = yield* clientKey(yield* tempDir, "vex");
				const agent = yield* sshAgent(table.port, "den", vex);
				const tools = yield* toolsOf(agent);

				expect(tools).toContain("cmd_say");
				expect(tools).not.toContain("batch_commands");

				const said = yield* Effect.promise(
					async () =>
						await agent.rpc.request("tools/call", {
							name: "cmd_say",
							arguments: { text: "From my agent." },
						})
				);

				expect(jsonText(resultOf(said))).toContain("From my agent.");

				yield* Effect.promise(agent.end);
				expect(yield* exitOf(agent)).toBe(0);
			}),
		20_000
	);

	effect(
		"a guest's agent and one the GM hasn't let in are turned away on stderr",
		() =>
			Effect.gen(function* () {
				const open = yield* servedTable();
				const guest = yield* sshAgent(open.port, "den");

				expect(yield* exitOf(guest)).toBe(1);
				expect(guest.stderr()).toContain(AGENT_NEEDS_KEY);

				const closed = yield* servedTable({}, "knock");
				const vex = yield* clientKey(yield* tempDir, "vex");
				const knocking = yield* sshAgent(closed.port, "den", vex);

				expect(yield* exitOf(knocking)).toBe(1);
				expect(knocking.stderr()).toContain(KNOCK_FIRST);

				const asksKnows = yield* sshAgent(
					closed.port,
					"den",
					vex,
					KNOWS_SUBSYSTEM
				);

				expect(yield* exitOf(asksKnows)).not.toBe(0);
			}),
		20_000
	);

	effect(
		"a key listed in gm_keys gets the GM's agent; a loose gm_keys is ignored",
		() =>
			Effect.gen(function* () {
				const table = yield* servedTable({}, "knock");
				const keys = yield* tempDir;
				const gm = yield* clientKey(keys, "gm");
				const other = yield* clientKey(keys, "other");

				yield* gmKeys(table.dir, `${gm.fingerprint}\n\nnot a key\n`);

				const remote = yield* sshAgent(table.port, "den", gm);
				const tools = yield* toolsOf(remote);

				expect(tools).toContain("batch_commands");
				expect(tools).toContain("cmd_kick");

				yield* Effect.promise(remote.end);
				expect(yield* exitOf(remote)).toBe(0);

				const stranger = yield* sshAgent(table.port, "den", other);

				expect(yield* exitOf(stranger)).toBe(1);
				expect(stranger.stderr()).toContain(KNOCK_FIRST);

				yield* gmKeys(table.dir, `${gm.fingerprint}\n`, 0o666);

				const loose = yield* sshAgent(table.port, "den", gm);

				expect(yield* exitOf(loose)).toBe(1);
				expect(loose.stderr()).toContain(KNOCK_FIRST);
			}),
		20_000
	);

	effect(
		"through the relay: a full address, a known shorthand, and never the relay's own knows-1",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();

				const table = yield* servedTable({
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
				const gm = yield* clientKey(keys, "gm");

				const full = yield* sshAgent(relay.playerPort, "ana/den", vex);
				const tools = yield* toolsOf(full);

				expect(tools).toContain("cmd_say");
				expect(tools).not.toContain("batch_commands");

				const said = yield* Effect.promise(
					async () =>
						await full.rpc.request("tools/call", {
							name: "cmd_say",
							arguments: { text: "Relayed agent." },
						})
				);

				expect(jsonText(resultOf(said))).toContain("Relayed agent.");
				yield* Effect.promise(full.end);
				expect(yield* exitOf(full)).toBe(0);

				const unknown = yield* sshAgent(relay.playerPort, "den", gm);

				expect(yield* exitOf(unknown)).toBe(1);
				expect(unknown.stderr()).toContain(shorthandMessage("den"));

				const short = yield* sshAgent(relay.playerPort, "den", vex);
				const shortTools = yield* toolsOf(short);

				expect(shortTools).toContain("cmd_say");
				yield* Effect.promise(short.end);
				expect(yield* exitOf(short)).toBe(0);

				yield* gmKeys(table.dir, `${gm.fingerprint}\n`);

				const remoteGm = yield* sshAgent(relay.playerPort, "ana/den", gm);

				expect(yield* toolsOf(remoteGm)).toContain("batch_commands");
				yield* Effect.promise(remoteGm.end);

				const knows = yield* sshAgent(
					relay.playerPort,
					"ana/den",
					vex,
					KNOWS_SUBSYSTEM
				);

				expect(yield* exitOf(knows)).not.toBe(0);
			}),
		30_000
	);

	effect(
		"a table whose host predates agents says so",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const old = yield* gmTable();

				const link = yield* linkGm(
					old,
					relay.gmPort,
					"old",
					relay.relayKeyFingerprint
				);

				expect(link.answer).toBe("OK");
				yield* waitFor("the old table's link", () =>
					relay.linkedTables().includes("ana/old")
				);

				const vex = yield* clientKey(yield* tempDir, "vex");
				const agent = yield* sshAgent(relay.playerPort, "ana/old", vex);

				expect(yield* exitOf(agent)).toBe(1);
				expect(agent.stderr()).toContain(AGENTS_TOO_OLD);
			}),
		20_000
	);
});
