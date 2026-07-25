import { parseArgs } from "node:util";

import { resolveGatewayStateDir } from "./state-dir.js";

/**
 * The operator role's argument surface, kept apart from the runner so it can
 * be exercised without binding a port. `serveGateway` in `./index.ts` is the
 * only caller (ADR-0015).
 */

const DEFAULT_SSH_PORT = 2222;
const DEFAULT_SSH_HOST = "127.0.0.1";
const MAX_PORT = 65_535;

export const GATEWAY_ROLE_USAGE = `Usage:
  supervillain gateway serve [options]

Runs the gateway role out of this same binary: the SSH door players reach and
the broker Hosts dial out to. This is an operator surface, not a table one —
it is deliberately outside the pinned create/join/publish verb set (ADR-0015).

Options:
  --state <dir>         where the gateway keeps its identity, SSH host key, and
                        registry. Default:
                        \${XDG_STATE_HOME:-~/.local/state}/supervillain/gateway.
                        Never the campaign folder.
  --ssh-host <name>     the hostname players are told to ssh to. Default: ${DEFAULT_SSH_HOST}
  --ssh-port <port>     the SSH port to listen on. Default: ${DEFAULT_SSH_PORT}
  --bind <host>         the interface to bind. Default: the SSH door on 0.0.0.0,
                        and the Host pipe on 0.0.0.0 when this process
                        terminates TLS, 127.0.0.1 when something in front does.
  --broker-port <port>  TCP port for the Host pipe. Default: 8443 when this
                        process terminates TLS (the one port to forward), an
                        ephemeral port when TLS is terminated upstream.
  --broker-url <url>    the pipe URL Hosts should dial, when it differs from
                        the bound address

Environment fallbacks, each beaten by its flag: SUPERVILLAIN_GATEWAY_STATE,
SUPERVILLAIN_GATEWAY_SSH_HOST, SUPERVILLAIN_GATEWAY_SSH_PORT,
SUPERVILLAIN_GATEWAY_BIND, SUPERVILLAIN_GATEWAY_BROKER_PORT,
SUPERVILLAIN_GATEWAY_BROKER_URL.

TLS is set by environment only, since it is a posture rather than a per-run
choice (ADR-0014): SUPERVILLAIN_GATEWAY_TLS is one of self-signed (the
default — mint a certificate, no CA and no domain needed),
terminated-upstream, or files (with SUPERVILLAIN_GATEWAY_TLS_CERT and
SUPERVILLAIN_GATEWAY_TLS_KEY).

Protective caps, also environment only — cost ceiling and abuse protection,
never monetization (ADR-0012). The defaults come from the R9 capacity
benchmark on one box; your box is not that box, so they are yours to turn:

  SUPERVILLAIN_GATEWAY_ROOMS_PER_IDENTITY   rooms one identity may have
                                            attached at once
  SUPERVILLAIN_GATEWAY_SESSIONS_PER_ROOM    sessions one Room may carry; the
                                            next arrival is refused at the
                                            lobby, and no live table is ever
                                            degraded to admit it
  SUPERVILLAIN_GATEWAY_SESSION_BUDGET       envelopes one session may fall
                                            behind before its own view is
                                            dropped
  SUPERVILLAIN_GATEWAY_SESSION_OUTPUT_BYTES bytes one session's SSH channel may
                                            hold unread before it is dropped
  SUPERVILLAIN_GATEWAY_SESSION_STALL_MS     how long a session's channel may
                                            stall entirely before it is dropped
  SUPERVILLAIN_GATEWAY_PTY_COLUMNS          rendered terminal ceiling; a
  SUPERVILLAIN_GATEWAY_PTY_ROWS             bigger window gets the capped
                                            picture and an honest notice
  SUPERVILLAIN_GATEWAY_LOBBY_IDLE_MS        lobby idle timeout
  SUPERVILLAIN_GATEWAY_LOBBY_MAX_MS         hard ceiling on one lobby hold
  SUPERVILLAIN_GATEWAY_LOBBY_CONNECTIONS_PER_WINDOW
  SUPERVILLAIN_GATEWAY_LOBBY_WINDOW_MS      the per-IP connection window

Every one of them is a whole number of 1 or more; anything else is refused on
start rather than silently ignored.`;

/** Structurally the subset of `GatewayOptions` an operator can set from the
 * command line. Declared here rather than imported so the parser stays free of
 * the runner (and of `bun:sqlite`, which the runner reaches). */
export interface GatewayRoleOptions {
	readonly stateDir: string;
	readonly sshPort: number;
	readonly sshHost: string;
	readonly bindHost?: string | undefined;
	readonly brokerPort?: number | undefined;
	readonly brokerUrl?: string | undefined;
}

export interface GatewayRoleEnvironment {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly homeDir: string;
}

export type GatewayRoleParse =
	| { readonly kind: "run"; readonly options: GatewayRoleOptions }
	| { readonly kind: "help" }
	| { readonly kind: "error"; readonly message: string };

const readPort = (
	value: string,
	label: string
): { readonly port: number } | { readonly message: string } => {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
		return { message: `${label} must be a port number between 0 and 65535.` };
	}
	return { port };
};

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Parses `gateway serve`'s flags with the `SUPERVILLAIN_GATEWAY_*` environment
 * as the fallback layer, and resolves the state directory. Returns the shape
 * to run, a help request, or a one-line complaint — never throws, never binds.
 */
export const parseGatewayRoleArgs = (
	args: readonly string[],
	environment: GatewayRoleEnvironment
): GatewayRoleParse => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: {
				bind: { type: "string" },
				"broker-port": { type: "string" },
				"broker-url": { type: "string" },
				help: { short: "h", type: "boolean" },
				"ssh-host": { type: "string" },
				"ssh-port": { type: "string" },
				state: { type: "string" },
			},
		});
	} catch (error) {
		return {
			kind: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	if (parsed.values.help === true) {
		return { kind: "help" };
	}
	if (parsed.positionals.length > 0) {
		return {
			kind: "error",
			message: "gateway serve takes no positional arguments.",
		};
	}
	const { env } = environment;
	const sshPortText =
		optionalString(parsed.values["ssh-port"]) ??
		env.SUPERVILLAIN_GATEWAY_SSH_PORT;
	const sshPortResult =
		sshPortText === undefined
			? { port: DEFAULT_SSH_PORT }
			: readPort(sshPortText, "--ssh-port");
	if ("message" in sshPortResult) {
		return { kind: "error", message: sshPortResult.message };
	}
	const brokerPortText =
		optionalString(parsed.values["broker-port"]) ??
		env.SUPERVILLAIN_GATEWAY_BROKER_PORT;
	const brokerPortResult =
		brokerPortText === undefined
			? undefined
			: readPort(brokerPortText, "--broker-port");
	if (brokerPortResult !== undefined && "message" in brokerPortResult) {
		return { kind: "error", message: brokerPortResult.message };
	}
	return {
		kind: "run",
		options: {
			bindHost:
				optionalString(parsed.values.bind) ?? env.SUPERVILLAIN_GATEWAY_BIND,
			brokerPort: brokerPortResult?.port,
			brokerUrl:
				optionalString(parsed.values["broker-url"]) ??
				env.SUPERVILLAIN_GATEWAY_BROKER_URL,
			sshHost:
				optionalString(parsed.values["ssh-host"]) ??
				env.SUPERVILLAIN_GATEWAY_SSH_HOST ??
				DEFAULT_SSH_HOST,
			sshPort: sshPortResult.port,
			stateDir: resolveGatewayStateDir({
				env: env.SUPERVILLAIN_GATEWAY_STATE,
				flag: optionalString(parsed.values.state),
				homeDir: environment.homeDir,
				xdgStateHome: env.XDG_STATE_HOME,
			}),
		},
	};
};
