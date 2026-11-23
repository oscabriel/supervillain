import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

import { Effect } from "effect";
import ssh2 from "ssh2";
import type { AnyAuthMethod, ClientChannel, ConnectConfig } from "ssh2";

import { SshError } from "../src/index.ts";
import type { ClientKey } from "./openssh.ts";

export interface Ssh2Options {
	readonly port?: number;
	readonly sock?: Duplex;
	readonly key?: ClientKey;
	readonly keyboard?: boolean;
	readonly user?: string;
	readonly localAddress?: string;
	readonly kex?: Array<ssh2.KexAlgorithm>;
}

export interface Ssh2ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
}

const failure = (cause: unknown) =>
	new SshError({
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
	});

const readKey = (
	key: ClientKey | undefined
): Effect.Effect<string | undefined, SshError> =>
	key === undefined
		? Effect.undefined
		: Effect.tryPromise({
				try: async () => await readFile(key.path, "utf-8"),
				catch: failure,
			});

const authMethod = (
	options: Ssh2Options,
	privateKey: string | undefined
): AnyAuthMethod => {
	const username = options.user ?? "den";

	if (privateKey !== undefined) {
		return { type: "publickey", username, key: privateKey };
	}

	if (options.keyboard === true) {
		return {
			type: "keyboard-interactive",
			username,
			prompt: (_name, _instructions, _lang, _prompts, answer) => {
				answer([]);
			},
		};
	}

	return { type: "none", username };
};

const connectConfig = (
	options: Ssh2Options,
	privateKey: string | undefined
): ConnectConfig => {
	const config: ConnectConfig = {
		host: "127.0.0.1",
		username: options.user ?? "den",
		hostVerifier: () => true,
		readyTimeout: 5000,
		authHandler: [authMethod(options, privateKey)],
	};

	if (options.port !== undefined) {
		config.port = options.port;
	}

	if (options.localAddress !== undefined) {
		config.localAddress = options.localAddress;
	}

	if (options.kex !== undefined) {
		config.algorithms = { kex: options.kex };
	}

	if (options.sock !== undefined) {
		config.sock = options.sock;
	}

	return config;
};

const connected = (config: ConnectConfig) =>
	Effect.callback<InstanceType<typeof ssh2.Client>, SshError>((resume) => {
		const client = new ssh2.Client();
		client
			.once("ready", () => {
				resume(Effect.succeed(client));
			})
			.once("error", (error) => {
				resume(Effect.fail(failure(error)));
			});
		client.connect(config);
	});

export const ssh2Client = (options: Ssh2Options) =>
	Effect.acquireRelease(
		readKey(options.key).pipe(
			Effect.flatMap((privateKey) =>
				connected(connectConfig(options, privateKey))
			)
		),
		(client) =>
			Effect.sync(() => {
				client.end();
			})
	);

export const ssh2Exec = (
	client: InstanceType<typeof ssh2.Client>,
	command: string,
	env: Record<string, string> = {},
	pty = false
) =>
	Effect.callback<Ssh2ExecResult, SshError>((resume) => {
		client.exec(command, { env, pty }, (refused, channel) => {
			if (refused !== undefined) {
				resume(Effect.fail(failure(refused)));

				return;
			}

			let stdout = "";
			let stderr = "";
			let code: number | null = null;
			channel.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			channel.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			channel.on("exit", (exitCode: number | null) => {
				code = exitCode;
			});
			channel.on("close", () => {
				resume(Effect.succeed({ stdout, stderr, code }));
			});
		});
	});

export const ssh2Shell = (
	client: InstanceType<typeof ssh2.Client>,
	size: { cols: number; rows: number },
	env: Record<string, string> = {}
) =>
	Effect.callback<ClientChannel, SshError>((resume) => {
		client.shell(
			{
				term: "xterm-256color",
				cols: size.cols,
				rows: size.rows,
				width: 0,
				height: 0,
			},
			{ env },
			(refused, channel) => {
				resume(
					refused === undefined
						? Effect.succeed(channel)
						: Effect.fail(failure(refused))
				);
			}
		);
	});
