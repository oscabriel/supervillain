import { describe, expect } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { must } from "../game/must.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { startRelay } from "../relay/harness.ts";
import { clientKey, sshShell } from "../relay/openssh.ts";
import { plainEnv } from "./cli.ts";

const main = path.join(import.meta.dir, "../../src/main.ts");

const CODE = /--claim (?<code>sv-[0-9a-z]{20})/u;

const shown = (terminal: { output: () => string }) =>
	Bun.stripANSI(terminal.output());

const inPty = (
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			let output = "";
			const decoder = new TextDecoder();

			const proc = Bun.spawn(["bun", main, ...args], {
				env: { ...plainEnv(), TERM: "xterm-256color", ...env },
				terminal: {
					cols: 100,
					rows: 30,
					data: (_terminal, data) => {
						output += decoder.decode(data, { stream: true });
					},
				},
			});

			return { proc, output: () => output };
		}),
		({ proc }) =>
			Effect.promise(async () => {
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGKILL");
				}

				await proc.exited;
			})
	);

describe("Create a Table: from the relay's lobby to a linked table", () => {
	effect(
		"a key claims its handle in the lobby, gets a pairing code, and supervillain new --claim opens the table under it",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const dir = yield* tempDir;
				const vex = yield* clientKey(dir, "vex");

				const lobby = yield* sshShell(
					relay.playerPort,
					{ cols: 100, rows: 30 },
					{ key: vex, user: "lobby" }
				);

				yield* waitFor("the lobby", () =>
					shown(lobby).includes("> type your table's name")
				);
				lobby.write("\u001BOR");
				yield* waitFor("the create tab", () =>
					shown(lobby).includes("Pick your GM handle.")
				);
				lobby.write("ana\r");
				yield* waitFor("the claim", () =>
					shown(lobby).includes("› You hold ana now.")
				);
				lobby.write("ford\r");
				yield* waitFor("the code", () => CODE.test(shown(lobby)));
				expect(lobby.output()).toContain("\u001B]52;c;");
				expect(shown(lobby)).toContain(
					"curl -fsSL https://supervillain.sh/install | sh"
				);

				const code = must(CODE.exec(shown(lobby))?.groups?.code);
				lobby.write("\u0003");
				expect(yield* Effect.promise(async () => await lobby.exited)).toBe(0);
				expect(lobby.output()).toContain(
					"Run these on your computer (the code works once, for 15 minutes):"
				);

				const home = path.join(dir, "home");
				const config = path.join(dir, "config");

				const gm = yield* inPty(
					[
						"new",
						"ford",
						"--rules",
						"draw-steel",
						"--handle",
						"ana",
						"--claim",
						code,
					],
					{
						SUPERVILLAIN_HOME: home,
						SUPERVILLAIN_RELAY: `127.0.0.1:${relay.gmPort}`,
						XDG_CONFIG_HOME: config,
					}
				);

				yield* waitFor(
					"the table linked",
					() => relay.linkedTables().includes("ana/ford"),
					20_000
				);

				const handles = yield* Effect.promise(
					async () =>
						await readFile(path.join(relay.dir, "handles.json"), "utf-8")
				);

				expect(handles).toContain(vex.fingerprint);
				expect(handles.match(/SHA256:/gu)?.length).toBe(2);

				const saved = path.join(config, "supervillain", "gm.json");

				expect(
					yield* Effect.promise(async () => await readFile(saved, "utf-8"))
				).toBe('{"handle":"ana"}\n');
				expect(
					(yield* Effect.promise(async () => await stat(saved))).mode % 0o1000
				).toBe(0o600);
				expect(
					yield* Effect.promise(
						async () =>
							await readFile(path.join(home, "ford", "campaign.yaml"), "utf-8")
					)
				).toContain("rules: draw-steel");

				gm.proc.terminal?.write("\u0003");
				expect(yield* Effect.promise(async () => await gm.proc.exited)).toBe(0);
			}),
		40_000
	);
});
