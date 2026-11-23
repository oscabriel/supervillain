import { describe, expect } from "bun:test";

import { Effect } from "effect";

import type { ExecSession } from "../src/index.ts";
import { effect, must } from "./effect.ts";
import { clientKey, sshExec } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

describe("exec", () => {
	effect(
		"reaches onExec with the command and the key's identity; output and status come back",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const seen: Array<ExecSession> = [];

				const server = yield* testServer({
					onExec: (session) =>
						Effect.sync(() => {
							seen.push(session);
							session.write(`you said: ${session.command}\n`);
							session.writeError("a warning\n");

							return 3;
						}),
				});

				const result = yield* sshExec(server.port, ["hello", "world"], {
					key,
					user: "den",
				});

				expect(result).toEqual({
					stdout: "you said: hello world\n",
					stderr: "a warning\n",
					exitCode: 3,
				});
				expect(seen).toHaveLength(1);
				const [only] = seen;
				expect(only?.command).toBe("hello world");
				expect(only?.info.identity).toEqual({
					kind: "key",
					actor: `key:${key.fingerprint}`,
					fingerprint: key.fingerprint,
					algorithm: "ssh-ed25519",
				});
				expect(only?.info.user).toBe("den");
				expect(only?.info.remoteAddress).toBe("127.0.0.1");
				expect(must(only, "onExec ran").info.relayedActor).toBeUndefined();
			})
	);

	effect("keeps only allow-listed client env with clean values", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");
			const seen: Array<ExecSession> = [];

			const server = yield* testServer({
				onExec: (session) =>
					Effect.sync(() => {
						seen.push(session);

						return 0;
					}),
			});

			const client = yield* ssh2Client({ port: server.port, key });
			yield* ssh2Exec(client, "env", {
				COLORTERM: "truecolor",
				TERM_PROGRAM: "evil\u001B]0;pwned\u0007",
				LD_PRELOAD: "/tmp/x.so",
				SV_ACTOR: "gm",
			});
			const { info } = must(seen[0], "onExec ran");
			expect(info.env).toEqual({ COLORTERM: "truecolor" });
			expect(info.relayedActor).toBeUndefined();
		})
	);
});
