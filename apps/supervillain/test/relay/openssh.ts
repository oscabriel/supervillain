import path from "node:path";

import { Effect } from "effect";

export interface ClientKey {
	readonly path: string;
	readonly fingerprint: string;
}

const run = async (cmd: ReadonlyArray<string>) => {
	const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe" });

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { stdout, stderr, exitCode };
};

const fingerprintFile = async (file: string) => {
	const listed = await run(["ssh-keygen", "-lf", file]);
	const [, fingerprint = ""] = listed.stdout.split(" ");

	if (!fingerprint.startsWith("SHA256:")) {
		throw new Error(`ssh-keygen -lf ${file}: ${listed.stderr}`);
	}

	return fingerprint;
};

export const clientKey = (
	dir: string,
	name: string,
	type: "ed25519" | "rsa" | "ecdsa" = "ed25519"
) =>
	Effect.promise(async (): Promise<ClientKey> => {
		const keyPath = path.join(dir, name);

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
			keyPath,
		]);

		if (made.exitCode !== 0) {
			throw new Error(`ssh-keygen: ${made.stderr}`);
		}

		return {
			path: keyPath,
			fingerprint: await fingerprintFile(`${keyPath}.pub`),
		};
	});

export const keygenFingerprint = (file: string) =>
	Effect.promise(async () => await fingerprintFile(file));

export interface ClientOptions {
	readonly key?: ClientKey;
	readonly user?: string;
	readonly flags?: ReadonlyArray<string>;
	readonly stdin?: string;
}

const env = () => {
	const { SSH_AUTH_SOCK: _, ...rest } = process.env;

	return rest;
};

const identity = (key: ClientKey | undefined) =>
	key === undefined
		? ["-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no"]
		: ["-o", "BatchMode=yes", "-i", key.path];

const extraFlags = (options: ClientOptions) => options.flags ?? [];

const baseArgs = (
	port: number,
	options: ClientOptions,
	flags: ReadonlyArray<string> = []
) => [
	"ssh",
	...flags,
	...extraFlags(options),
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
	...identity(options.key),
	"-l",
	options.user ?? "den",
	"127.0.0.1",
];

export const sshExec = (
	port: number,
	command: ReadonlyArray<string>,
	options: ClientOptions = {}
) =>
	Effect.promise(async () => {
		const proc = Bun.spawn([...baseArgs(port, options), ...command], {
			stdin: options.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: env(),
		});

		if (options.stdin !== undefined) {
			await proc.stdin?.write(options.stdin);
			await proc.stdin?.end();
		}

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { stdout, stderr, exitCode };
	});

export interface Terminal {
	readonly output: () => string;
	readonly resize: (cols: number, rows: number) => void;
	readonly write: (text: string) => void;
	readonly kill: () => void;
	readonly pause: () => void;
	readonly resume: () => void;
	readonly exited: Promise<number>;
}

export const sshShell = (
	port: number,
	size: { cols: number; rows: number },
	options: ClientOptions
) =>
	Effect.acquireRelease(
		Effect.sync((): Terminal => {
			let output = "";
			const decoder = new TextDecoder();

			const proc = Bun.spawn(baseArgs(port, options, ["-tt"]), {
				env: { ...env(), TERM: "xterm-256color" },
				terminal: {
					cols: size.cols,
					rows: size.rows,
					data: (_terminal, data) => {
						output += decoder.decode(data, { stream: true });
					},
				},
			});

			return {
				output: () => output,
				resize: (cols, rows) => {
					proc.terminal?.resize(cols, rows);
				},
				write: (text) => {
					proc.terminal?.write(text);
				},
				kill: () => {
					proc.kill("SIGKILL");
				},
				pause: () => {
					proc.kill("SIGSTOP");
				},
				resume: () => {
					proc.kill("SIGCONT");
				},
				exited: proc.exited,
			};
		}),
		(terminal) =>
			Effect.promise(async () => {
				terminal.resume();
				terminal.kill();
				await terminal.exited;
			})
	);
