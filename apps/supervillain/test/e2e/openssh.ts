import nodePath from "node:path";

import { Effect } from "effect";

import { pollFor } from "./log.ts";

export interface ClientKey {
	readonly path: string;
	readonly fingerprint: string;
}

const run = async (cmd: ReadonlyArray<string>) => {
	const proc = Bun.spawn([...cmd], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: env(),
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { stdout, stderr, exitCode };
};

const env = () => {
	const { SSH_AUTH_SOCK: _, ...rest } = process.env;

	return rest;
};

export const clientKey = (
	dir: string,
	name: string,
	type: "ed25519" | "rsa" | "ecdsa" = "ed25519"
) =>
	Effect.promise(async (): Promise<ClientKey> => {
		const path = nodePath.join(dir, name);

		const made = await run([
			"ssh-keygen",
			"-q",
			"-t",
			type,
			"-N",
			"",
			"-C",
			name,
			"-f",
			path,
		]);

		if (made.exitCode !== 0) {
			throw new Error(`ssh-keygen: ${made.stderr}`);
		}

		const listed = await run(["ssh-keygen", "-lf", `${path}.pub`]);
		const [, fingerprint] = listed.stdout.split(" ");

		if (fingerprint?.startsWith("SHA256:") !== true) {
			throw new Error(`ssh-keygen -lf: ${listed.stderr}`);
		}

		return { path, fingerprint };
	});

const identity = (key: ClientKey | undefined) =>
	key === undefined
		? ["-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no"]
		: ["-o", "BatchMode=yes", "-i", key.path];

const args = (
	port: number,
	key: ClientKey | undefined,
	flags: ReadonlyArray<string> = []
) => [
	"ssh",
	...flags,
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
	"den@127.0.0.1",
];

export const sshExec = (port: number, command: string, key?: ClientKey) =>
	Effect.promise(async () => await run([...args(port, key), command]));

export interface Terminal {
	readonly text: () => string;
	readonly output: () => string;
	readonly write: (text: string) => void;
	readonly kill: () => void;
	readonly exited: Promise<number>;
}

export const sshShell = (port: number, key?: ClientKey) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			let output = "";
			const decoder = new TextDecoder();

			const proc = Bun.spawn(args(port, key, ["-tt"]), {
				env: { ...env(), TERM: "xterm-256color" },
				terminal: {
					cols: 100,
					rows: 30,
					data: (_terminal, data) => {
						output += decoder.decode(data, { stream: true });
					},
				},
			});

			const terminal: Terminal = {
				text: () => Bun.stripANSI(output),
				output: () => output,
				write: (text) => {
					proc.terminal?.write(text);
				},
				kill: () => {
					proc.kill("SIGKILL");
				},
				exited: proc.exited,
			};

			return { terminal, proc };
		}),
		({ proc }) =>
			Effect.promise(async () => {
				proc.kill("SIGKILL");
				await proc.exited;
			})
	).pipe(Effect.map(({ terminal }) => terminal));

export const waitFor = (what: string, predicate: () => boolean, ms = 5000) =>
	Effect.promise(async () => {
		await pollFor(
			() => (predicate() ? true : undefined),
			() => `timed out waiting for ${what}`,
			ms
		);
	});
