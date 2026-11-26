import type { Duplex, Readable } from "node:stream";

import { Effect, Predicate } from "effect";
import type { Scope } from "effect";
import ssh2 from "ssh2";
import type { ClientChannel } from "ssh2";

import { COMPRESS, fingerprintOf, IDENT, KEX } from "./keys.ts";
import { SshError } from "./types.ts";
import type { RawExit, RawRequest } from "./types.ts";

const CLOSE_GRACE_MS = 250;

const withSize = (pty: ClientPty | false) =>
	pty === false ? false : { ...pty, width: 0, height: 0 };

const loginFailure = (
	hostKeyRefused: boolean,
	e: Error & { level?: string }
): string => {
	if (hostKeyRefused) {
		return "the server's host key was refused";
	}

	return e.level === "client-authentication"
		? "the server refused this client's key"
		: e.message;
};

export interface ClientOptions {
	readonly socket: Duplex;
	readonly username: string;
	readonly privateKey: Buffer | string;
	readonly verifyHostKey: (fingerprint: string) => Promise<boolean>;
	readonly readyTimeoutMs?: number;
	readonly keepaliveMs?: number;
	readonly keepaliveCount?: number;
}

export interface ClientPty {
	readonly term: string;
	readonly cols: number;
	readonly rows: number;
}

export interface ClientSession {
	readonly stream: Duplex;
	readonly stderr: Readable;
	readonly resize: (cols: number, rows: number) => void;
	readonly ended: Promise<RawExit | undefined>;
	readonly close: () => void;
}

export interface ClientLink {
	readonly hostKeyFingerprint: string;
	readonly open: (
		request: RawRequest,
		env: Readonly<Record<string, string>>,
		pty: ClientPty | false
	) => Promise<ClientSession>;
	readonly onClose: (listener: () => void) => void;
	readonly closed: () => boolean;
	readonly close: () => void;
}

const session = (channel: ClientChannel): ClientSession => {
	const { promise: ended, resolve } = Promise.withResolvers<
		RawExit | undefined
	>();

	let exit: RawExit | undefined;
	channel.on(
		"exit",
		(
			code: number | null,
			signal?: string,
			coreDumped?: boolean,
			message?: string
		) => {
			exit = Predicate.isNumber(code)
				? code
				: {
						signal: (signal ?? "SIGTERM").replace(/^SIG/u, ""),
						coreDumped: coreDumped === true,
						message: message ?? "",
					};
		}
	);
	channel.once("close", () => {
		resolve(exit);
	});

	return {
		stream: channel,
		stderr: channel.stderr,
		resize: (cols, rows) => {
			channel.setWindow(rows, cols, 0, 0);
		},
		ended,
		close: () => {
			channel.close();
		},
	};
};

export const connectClient = (
	options: ClientOptions
): Effect.Effect<ClientLink, SshError, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.callback<ClientLink, SshError>((resume) => {
			const client = new ssh2.Client();
			let hostKeyFingerprint: string | undefined;
			let hostKeyRefused = false;
			let ready = false;
			let isClosed = false;
			const listeners = new Set<() => void>();

			const destroy = () => {
				client.destroy();
				options.socket.destroy();
			};

			const close = () => {
				if (isClosed) {
					return;
				}

				client.end();
				setTimeout(destroy, CLOSE_GRACE_MS).unref();
			};

			const link: ClientLink = {
				get hostKeyFingerprint() {
					return hostKeyFingerprint ?? "";
				},
				open: async (request, env, pty) => {
					const { promise, resolve, reject } =
						Promise.withResolvers<ClientSession>();

					const opened = (
						failure: Error | undefined,
						channel: ClientChannel
					) => {
						if (failure === undefined || Object.is(failure, null)) {
							resolve(session(channel));
						} else {
							reject(failure);
						}
					};

					try {
						if (request.kind === "subsystem") {
							client.subsys(request.name, { env: { ...env } }, opened);
						} else if (request.kind === "shell") {
							client.shell(withSize(pty), { env: { ...env } }, opened);
						} else {
							client.exec(
								request.command,
								{ env: { ...env }, pty: withSize(pty) },
								opened
							);
						}
					} catch (error) {
						reject(
							error instanceof Error
								? error
								: new Error(String(error), { cause: error })
						);
					}

					return await promise;
				},
				onClose: (listener) => {
					if (isClosed) {
						listener();
					} else {
						listeners.add(listener);
					}
				},
				closed: () => isClosed,
				close,
			};

			client.once("ready", () => {
				ready = true;
				resume(Effect.succeed(link));
			});
			client.on("error", (e: Error & { level?: string }) => {
				if (ready) {
					return;
				}

				resume(
					Effect.fail(
						new SshError({ message: loginFailure(hostKeyRefused, e), cause: e })
					)
				);
				destroy();
			});

			const decide = async (offered: string): Promise<boolean> => {
				try {
					const ok = await options.verifyHostKey(offered);

					if (ok) {
						hostKeyFingerprint = offered;
					} else {
						hostKeyRefused = true;
					}

					return ok;
				} catch {
					hostKeyRefused = true;

					return false;
				}
			};

			client.on("close", () => {
				isClosed = true;
				options.socket.destroy();

				if (!ready) {
					resume(
						Effect.fail(
							new SshError({ message: "the link closed during login" })
						)
					);
				}

				for (const listener of listeners) {
					listener();
				}

				listeners.clear();
			});
			client.connect({
				sock: options.socket,
				username: options.username,
				privateKey: options.privateKey,
				ident: IDENT,
				algorithms: { kex: KEX, compress: COMPRESS },
				readyTimeout: options.readyTimeoutMs ?? 20_000,
				keepaliveInterval: options.keepaliveMs ?? 15_000,
				keepaliveCountMax: options.keepaliveCount ?? 3,
				hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
					decide(fingerprintOf(key))
						.then((ok) => {
							verify(ok);

							return ok;
						})
						.catch(() => {
							verify(false);

							return false;
						});
				},
			});

			return Effect.sync(destroy);
		}),
		(link) =>
			Effect.sync(() => {
				link.close();
			})
	);
