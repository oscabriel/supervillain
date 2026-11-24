import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { inOrder } from "../game/sequence.ts";
import { tempDir } from "../host/tempDir.ts";
import { pollFor } from "./log.ts";

const root = path.join(import.meta.dir, "../../../..");

const main = path.join(root, "apps/supervillain/src/main.ts");

export const campaignDir = Effect.tap(tempDir, (dir) =>
	Effect.promise(async () => {
		await inOrder(["heroes", "monsters", "maps"], async (sub) => {
			await mkdir(path.join(dir, sub));
		});
	})
);

const plainEnv = () => {
	const {
		CLICOLOR_FORCE: _clicolor,
		FORCE_COLOR: _force,
		...rest
	} = process.env;

	return { ...rest, NO_COLOR: "1" };
};

export const cli = (args: ReadonlyArray<string>, cwd = root) =>
	Effect.promise(async () => {
		const proc = Bun.spawn(["bun", main, ...args], {
			cwd,
			env: plainEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { stdout, stderr, exitCode };
	});

export interface Host {
	readonly port: number;
	readonly output: () => string;
	readonly stop: () => Promise<number>;
}

export const startHost = (args: ReadonlyArray<string>, cwd = root) =>
	Effect.acquireRelease(
		Effect.promise(async () => {
			const proc = Bun.spawn(["bun", main, "host", ...args, "--port", "0"], {
				cwd,
				env: plainEnv(),
				stdout: "pipe",
				stderr: "pipe",
			});

			let output = "";
			const decoder = new TextDecoder();

			const pump = async (stream: ReadableStream<Uint8Array>) => {
				for await (const chunk of stream) {
					output += decoder.decode(chunk, { stream: true });
				}
			};

			void pump(proc.stdout);
			void pump(proc.stderr);

			const said = () => {
				const found = /ssh -p (?<port>\d+) /u.exec(output)?.groups?.port;

				if (found === undefined && proc.exitCode !== null) {
					throw new Error(`host did not start:\n${output}`);
				}

				return found === undefined ? undefined : Number(found);
			};

			const port = await pollFor(
				said,
				() => `host did not start:\n${output}`,
				10_000
			);

			const host: Host = {
				port,
				output: () => output,
				stop: async () => {
					proc.kill("SIGINT");

					return await proc.exited;
				},
			};

			return { host, proc };
		}),
		({ proc }) =>
			Effect.promise(async () => {
				if (proc.exitCode === null) {
					proc.kill("SIGKILL");
				}

				await proc.exited;
			})
	).pipe(Effect.map(({ host }) => host));
