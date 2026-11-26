import { describe, expect } from "bun:test";
import {
	chmod,
	mkdir,
	readdir,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Result,
	Scope,
} from "effect";

import { TableServer } from "../../src/host/TableServer.ts";
import { bridgeMcp } from "../../src/mcp/bridge.ts";
import { agentsLine, McpSocket, mcpSocketPath } from "../../src/mcp/socket.ts";
import type { McpSocketError, SocketPlace } from "../../src/mcp/socket.ts";
import { cli, startHost } from "../e2e/cli.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { mcpTable, rulesCampaign } from "./harness.ts";
import { jsonText, lineRpc, resultOf, toolNames } from "./rpc.ts";

const LONG = "a-very-long-folder-name-for-a-campaign-that-goes-on".repeat(3);

const HEX_SOCKET = /^[0-9a-f]{16}\.sock$/u;

const exists = (file: string) =>
	Effect.promise(async () => {
		try {
			await stat(file);

			return true;
		} catch {
			return false;
		}
	});

const failureOf = <A>(result: Result.Result<A, McpSocketError>): string =>
	Result.isFailure(result) ? result.failure.message : "";

const modeOf = (mode: number): string => mode.toString(8).slice(-3);

const opened = (
	table: Effect.Success<ReturnType<typeof mcpTable>>,
	dir: string,
	place?: SocketPlace
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();

		const built = yield* Layer.buildWithScope(
			McpSocket.layer(
				place === undefined
					? { campaignDir: dir, room: "den" }
					: { campaignDir: dir, room: "den", place }
			),
			scope
		).pipe(Effect.provideContext(table.full), Effect.result);

		return { built, scope };
	});

const bridged = (dir: string, place?: SocketPlace) =>
	Effect.gen(function* () {
		const stdin = new PassThrough();
		const stdout = new PassThrough();

		const rpc = lineRpc((text) => {
			stdin.write(text);
		});

		stdout.on("data", rpc.feed);

		const fiber = yield* Effect.forkChild(
			bridgeMcp(
				place === undefined
					? { campaignDir: dir, stdin, stdout }
					: { campaignDir: dir, stdin, stdout, place }
			)
		);

		return {
			rpc,
			fiber,
			end: () => {
				stdin.end();
			},
		};
	});

const staleSocket = (file: string) =>
	Effect.promise(async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				"require('node:net').createServer().listen(process.argv.at(-1), () => console.log('up'))",
				file,
			],
			{ stdout: "pipe", stderr: "pipe" }
		);

		const reader = proc.stdout.getReader();
		await reader.read();
		proc.kill("SIGKILL");
		await proc.exited;
	});

describe("mcp.sock", () => {
	effect(
		"the socket sits in the campaign, or under a private runtime dir when that path is too long",
		() =>
			Effect.gen(function* () {
				expect(mcpSocketPath("/srv/den")).toBe("/srv/den/mcp.sock");

				const long = path.join("/srv", LONG);
				const place = { runtimeDir: "/run/user/1000", uid: 1000 };
				const fallback = mcpSocketPath(long, place);

				expect(path.dirname(fallback)).toBe("/run/user/1000/supervillain-1000");
				expect(path.basename(fallback)).toMatch(HEX_SOCKET);
				expect(mcpSocketPath(long, place)).toBe(fallback);
				expect(mcpSocketPath(`${long}x`, place)).not.toBe(fallback);
				expect(path.dirname(mcpSocketPath(long, { tmp: "/tmp", uid: 7 }))).toBe(
					"/tmp/supervillain-7"
				);
			})
	);

	effect(
		"an open table listens with mode 0600, speaks MCP as the GM, and unlinks the socket when it closes",
		() =>
			Effect.gen(function* () {
				const dir = yield* rulesCampaign("draw-steel");
				const table = yield* mcpTable(dir);
				const { built, scope } = yield* opened(table, dir);

				expect(built._tag).toBe("Success");

				const file = mcpSocketPath(dir);
				const info = yield* Effect.promise(async () => await stat(file));

				expect(info.isSocket()).toBe(true);
				expect(modeOf(info.mode)).toBe("600");

				const left = yield* Effect.promise(
					async () => await readdir(path.dirname(file))
				);

				expect(left.filter((name) => name.startsWith(".mcp."))).toEqual([]);

				const agent = yield* bridged(dir);

				yield* Effect.promise(async () => await agent.rpc.initialize());

				const tools = toolNames(
					yield* Effect.promise(
						async () => await agent.rpc.request("tools/list")
					)
				);

				expect(tools).toContain("batch_commands");

				const said = yield* Effect.promise(
					async () =>
						await agent.rpc.request("tools/call", {
							name: "cmd_narrate",
							arguments: { text: "Through the socket." },
						})
				);

				expect(jsonText(resultOf(said))).toContain("Through the socket.");

				agent.end();
				yield* Fiber.join(agent.fiber);

				yield* Scope.close(scope, Exit.void);
				expect(yield* exists(file)).toBe(false);
			}),
		20_000
	);

	effect(
		"a socket left by a table that died is cleared; a live one stops a second table",
		() =>
			Effect.gen(function* () {
				const dir = yield* rulesCampaign("draw-steel");
				const file = mcpSocketPath(dir);
				const table = yield* mcpTable(dir);

				yield* Effect.promise(async () => {
					await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				});
				yield* staleSocket(file);
				expect(yield* exists(file)).toBe(true);

				const first = yield* opened(table, dir);

				expect(first.built._tag).toBe("Success");

				const second = yield* opened(table, dir);

				expect(second.built._tag).toBe("Failure");
				expect(failureOf(second.built)).toContain("already taking agents");
				expect(yield* exists(file)).toBe(true);

				yield* Scope.close(first.scope, Exit.void);
				expect(yield* exists(file)).toBe(false);
			}),
		20_000
	);

	effect("a plain file in the socket's place is left alone and named", () =>
		Effect.gen(function* () {
			const dir = yield* rulesCampaign("draw-steel");
			const file = mcpSocketPath(dir);
			const table = yield* mcpTable(dir);

			yield* Effect.promise(async () => {
				await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				await writeFile(file, "keep me");
			});

			const { built } = yield* opened(table, dir);

			expect(built._tag).toBe("Failure");
			expect(failureOf(built)).toContain("isn't a socket");
		})
	);

	effect(
		"a campaign too deep for a socket path gets one in a 0700 runtime folder",
		() =>
			Effect.gen(function* () {
				const base = yield* tempDir;
				const runtimeDir = yield* tempDir;
				const dir = path.join(base, LONG);

				yield* Effect.promise(async () => {
					await mkdir(dir, { recursive: true });
					await writeFile(path.join(dir, "campaign.yaml"), "rules: freeform\n");
				});

				const place = { runtimeDir, uid: 4242 };
				const table = yield* mcpTable(dir);
				const { built, scope } = yield* opened(table, dir, place);

				expect(built._tag).toBe("Success");

				const file = mcpSocketPath(dir, place);

				const folder = yield* Effect.promise(
					async () => await stat(path.dirname(file))
				);

				expect(path.dirname(file)).toBe(
					path.join(runtimeDir, "supervillain-4242")
				);
				expect(modeOf(folder.mode)).toBe("700");

				const agent = yield* bridged(dir, place);

				const hello = yield* Effect.promise(
					async () => await agent.rpc.initialize()
				);

				expect(resultOf(hello)).toMatchObject({
					serverInfo: { name: "supervillain" },
				});

				agent.end();
				yield* Fiber.join(agent.fiber);
				yield* Scope.close(scope, Exit.void);
				expect(yield* exists(file)).toBe(false);
			}),
		20_000
	);

	effect(
		"a stale socket that answers with anything but ECONNREFUSED is left alone",
		() =>
			Effect.gen(function* () {
				const dir = yield* rulesCampaign("draw-steel");
				const file = mcpSocketPath(dir);
				const table = yield* mcpTable(dir);

				yield* Effect.promise(async () => {
					await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				});
				yield* staleSocket(file);
				yield* Effect.promise(async () => {
					await chmod(file, 0o000);
				});

				const { built } = yield* opened(table, dir);

				expect(built._tag).toBe("Failure");
				expect(failureOf(built)).toContain("leaving it alone");
				expect(yield* exists(file)).toBe(true);
			}),
		20_000
	);

	effect(
		"a symlinked or loose fallback socket folder is refused by the table and the bridge",
		() =>
			Effect.gen(function* () {
				const base = yield* tempDir;
				const elsewhere = yield* tempDir;
				const dir = path.join(base, LONG);

				yield* Effect.promise(async () => {
					await mkdir(dir, { recursive: true });
					await writeFile(path.join(dir, "campaign.yaml"), "rules: freeform\n");
				});

				const table = yield* mcpTable(dir);

				const linked = { runtimeDir: yield* tempDir, uid: 4242 };
				const linkedDir = path.dirname(mcpSocketPath(dir, linked));

				yield* Effect.promise(async () => {
					await chmod(elsewhere, 0o700);
					await symlink(elsewhere, linkedDir);
				});

				const viaLink = yield* opened(table, dir, linked);

				expect(viaLink.built._tag).toBe("Failure");
				expect(failureOf(viaLink.built)).toContain("isn't a plain folder");

				const linkBridge = yield* bridged(dir, linked);
				const linkExit = yield* Fiber.await(linkBridge.fiber);

				expect(
					Exit.isFailure(linkExit) ? Cause.pretty(linkExit.cause) : ""
				).toContain("isn't a plain folder");

				const loose = { runtimeDir: yield* tempDir, uid: 4243 };
				const looseDir = path.dirname(mcpSocketPath(dir, loose));

				yield* Effect.promise(async () => {
					await mkdir(looseDir);
					await chmod(looseDir, 0o770);
				});

				const viaLoose = yield* opened(table, dir, loose);

				expect(viaLoose.built._tag).toBe("Failure");
				expect(failureOf(viaLoose.built)).toContain("open to other users");

				const looseBridge = yield* bridged(dir, loose);
				const looseExit = yield* Fiber.await(looseBridge.fiber);

				expect(
					Exit.isFailure(looseExit) ? Cause.pretty(looseExit.cause) : ""
				).toContain("open to other users");
			}),
		20_000
	);

	effect(
		"a socket that can't be opened leaves the table hosting, with agents unavailable",
		() =>
			Effect.gen(function* () {
				const dir = yield* rulesCampaign("draw-steel");
				const file = mcpSocketPath(dir);
				const table = yield* mcpTable(dir);

				yield* Effect.promise(async () => {
					await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
					await writeFile(file, "keep me");
				});

				const scope = yield* Scope.make();

				const context = yield* Layer.buildWithScope(
					Layer.mergeAll(
						TableServer.layer({
							campaignDir: dir,
							room: "den",
							port: 0,
							bind: "127.0.0.1",
						}),
						McpSocket.layerBestEffort({ campaignDir: dir, room: "den" })
					),
					scope
				).pipe(Effect.provideContext(table.full));

				const agents = Context.get(context, McpSocket);
				const server = Context.get(context, TableServer);

				expect(agents._tag).toBe("Unavailable");
				expect(
					agentsLine("supervillain", dir, agents).startsWith(
						"agents on this machine: unavailable ("
					)
				).toBe(true);
				expect(server.port).toBeGreaterThan(0);

				yield* Scope.close(scope, Exit.void);
			}),
		20_000
	);

	effect(
		"supervillain host keeps hosting when the agent socket can't open, and says agents are unavailable",
		() =>
			Effect.gen(function* () {
				const dir = yield* rulesCampaign("draw-steel");
				const file = mcpSocketPath(dir);

				yield* Effect.promise(async () => {
					await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
					await writeFile(file, "keep me");
				});

				const host = yield* startHost([dir, "--headless"]);

				yield* waitFor("the host to say agents are unavailable", () =>
					host.output().includes("agents on this machine: unavailable (")
				);

				expect(host.output()).toContain("players join with:");
				expect(yield* Effect.promise(async () => await host.stop())).toBe(0);
			}),
		30_000
	);

	effect("the bridge says plainly when no table is open there", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const agent = yield* bridged(dir);
			const exit = yield* Fiber.await(agent.fiber);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(
				"no table is open"
			);
		})
	);

	effect(
		"supervillain mcp bridges an agent's stdio to a hosted table; with none, it fails on stderr only",
		() =>
			Effect.gen(function* () {
				const empty = yield* tempDir;
				const missing = yield* cli(["mcp", empty]);

				expect(missing.exitCode).toBe(1);
				expect(missing.stdout).toBe("");
				expect(missing.stderr).toContain("no table is open");

				const dir = yield* rulesCampaign("draw-steel");
				const file = mcpSocketPath(dir);
				const host = yield* startHost([dir, "--headless"]);

				yield* waitFor("the host's agent socket", () =>
					host.output().includes("agents on this machine connect with:")
				);

				const proc = Bun.spawn(
					["bun", path.join(import.meta.dir, "../../src/main.ts"), "mcp", dir],
					{ stdin: "pipe", stdout: "pipe", stderr: "pipe" }
				);

				const rpc = lineRpc((text) => {
					void proc.stdin.write(text);
				});

				let stdout = "";

				void (async () => {
					const decoder = new TextDecoder();

					for await (const chunk of proc.stdout) {
						stdout += decoder.decode(chunk, { stream: true });
						rpc.feed(chunk);
					}
				})();

				yield* Effect.promise(async () => await rpc.initialize());

				const tools = toolNames(
					yield* Effect.promise(async () => await rpc.request("tools/list"))
				);

				expect(tools).toContain("cmd_kick");

				for (const line of stdout.split("\n").filter((l) => l !== "")) {
					expect(line.startsWith('{"')).toBe(true);
				}

				yield* Effect.promise(async () => {
					await proc.stdin.end();
				});

				expect(yield* Effect.promise(async () => await proc.exited)).toBe(0);
				expect(yield* Effect.promise(async () => await host.stop())).toBe(0);
				expect(yield* exists(file)).toBe(false);
			}),
		30_000
	);
});
