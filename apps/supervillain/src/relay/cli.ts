import { isIP } from "node:net";
import { homedir } from "node:os";

import { Console, Effect, FileSystem, Option, Path } from "effect";
import type { Types } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { checkRelayDir, forgetHandle, HANDLE_POLICY } from "./handles.ts";
import {
	DEFAULT_GM_PORT,
	DEFAULT_PLAYER_PORT,
	DEFAULT_RELAY,
	HANDLE_RULE,
	isHandle,
	parseRelayAddress,
} from "./protocol.ts";
import { SANDBOX_LIVE } from "./sandbox.ts";
import { Relay, RelayError } from "./server.ts";
import type { RelayOptions } from "./server.ts";

const DEFAULT_DIR = "~/.supervillain-relay";

const DEFAULT_CLAIM_DAYS = HANDLE_POLICY.claimDays;

const relayDir = (dir: string) =>
	Effect.map(Path.Path, (path) => {
		if (dir === "~") {
			return homedir();
		}

		return path.resolve(
			dir.startsWith("~/") ? path.join(homedir(), dir.slice(2)) : dir
		);
	});

const notHandle = (handle: string) =>
	`${JSON.stringify(handle)} isn't a handle (${HANDLE_RULE})`;

export const portProblem = (flag: string, port: number, lowest: 0 | 1 = 0) =>
	port >= lowest && port <= 65_535
		? undefined
		: `${flag} takes a port from ${lowest} to 65535, not ${port}`;

export const bindProblem = (bind: string) =>
	isIP(bind) !== 0 || bind === "localhost"
		? undefined
		: `--bind takes an IP address, such as 127.0.0.1 or 0.0.0.0, or localhost, not ${JSON.stringify(bind)}`;

const fail = (e: { readonly message: string }) =>
	Console.error(`supervillain: ${e.message}`).pipe(
		Effect.andThen(
			Effect.sync(() => {
				process.exitCode = 1;
			})
		)
	);

const relay = Command.make("relay", {
	playerPort: Flag.Int("player-port").pipe(
		Flag.withDefault(DEFAULT_PLAYER_PORT),
		Flag.withDescription(
			"SSH port for players: ssh -p <port> <handle>/<table>@<this host> (0 picks one)"
		)
	),
	gmPort: Flag.Int("gm-port").pipe(
		Flag.withDefault(DEFAULT_GM_PORT),
		Flag.withDescription("Port GMs' hosts dial with --relay (0 picks one)")
	),
	bind: Flag.String("bind").pipe(
		Flag.withDefault("0.0.0.0"),
		Flag.withDescription("Address to listen on, both ports")
	),
	sandboxes: Flag.Int("sandboxes").pipe(
		Flag.withDefault(SANDBOX_LIVE),
		Flag.withDescription(
			"How many lobby visitors may try a sandbox table at once, each in the relay's memory (0 turns Try a Table off)"
		)
	),
	claimDays: Flag.Int("claim-days").pipe(
		Flag.withDefault(DEFAULT_CLAIM_DAYS),
		Flag.withDescription(
			"Days a handle's claim lasts with no GM linked (30 if it never linked a table), before another GM may take it"
		)
	),
	publicRelay: Flag.String("public-relay").pipe(
		Flag.optional,
		Flag.withDescription(
			`The host:port GMs dial for this relay, shown in the lobby's Create a Table command as --relay when it isn't ${DEFAULT_RELAY}`
		)
	),
}).pipe(
	Command.withSharedFlags({
		dir: Flag.String("dir").pipe(
			Flag.withDefault(DEFAULT_DIR),
			Flag.withDescription(
				"Holds the relay's keys and handles.json, which GM keys hold each handle"
			)
		),
	})
);

const run = relay.pipe(
	Command.withHandler((o) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* relayDir(o.dir);

			const problem =
				portProblem("--player-port", o.playerPort) ??
				portProblem("--gm-port", o.gmPort) ??
				bindProblem(o.bind);

			if (problem !== undefined) {
				return yield* new RelayError({ message: problem });
			}

			if (o.sandboxes < 0) {
				return yield* new RelayError({
					message: `--sandboxes takes a number from 0, not ${o.sandboxes}`,
				});
			}

			const publicRelay = Option.getOrUndefined(o.publicRelay);

			if (
				publicRelay !== undefined &&
				parseRelayAddress(publicRelay) === undefined
			) {
				return yield* new RelayError({
					message: `--public-relay takes host:port, not ${publicRelay}`,
				});
			}

			if (o.claimDays < 1) {
				return yield* new RelayError({
					message: `--claim-days takes a number of days from 1, not ${o.claimDays}`,
				});
			}

			yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(
				Effect.mapError(
					(cause) =>
						new RelayError({
							message: `can't make ${dir}: ${cause.message}`,
							cause,
						})
				)
			);

			const relayOptions: Types.Mutable<RelayOptions> = {
				dir,
				playerPort: o.playerPort,
				gmPort: o.gmPort,
				bind: o.bind,
				gm: { claimDays: o.claimDays },
				sandbox: { live: o.sandboxes },
			};

			if (publicRelay !== undefined) {
				relayOptions.publicRelay = publicRelay;
			}

			const info = yield* Relay.make(relayOptions);

			const shown =
				o.bind === "0.0.0.0" || o.bind === "::" ? "<this host>" : o.bind;

			yield* Console.log(
				`supervillain relay: keeping its keys and handles in ${dir}`
			);
			yield* Console.log(
				`players join with: ssh -p ${info.playerPort} <handle>/<table>@${shown}`
			);
			yield* Console.log(
				`GMs dial ${o.bind}:${info.gmPort} (supervillain host --handle <you> --relay ${shown}:${info.gmPort})`
			);
			yield* Console.log(`relay key ${info.relayKeyFingerprint}`);
			yield* Console.log(
				`  GMs pin it with: --relay-key ${info.relayKeyFingerprint}`
			);
			yield* Console.log(
				`host key ${info.hostKeyFingerprint} (what players' ssh sees)`
			);
			yield* Console.log(
				o.sandboxes === 0
					? "the lobby's Try a Table is off (--sandboxes 0)"
					: `the lobby's Try a Table runs up to ${o.sandboxes} sandbox table${o.sandboxes === 1 ? "" : "s"} at once`
			);
			yield* Console.log(
				`a handle's claim lapses after ${o.claimDays} day${o.claimDays === 1 ? "" : "s"} with no GM linked`
			);

			return yield* Effect.never;
		}).pipe(
			Effect.scoped,
			Effect.catchTags({ RelayError: fail, HandlesError: fail, SshError: fail })
		)
	)
);

const forget = Command.make(
	"forget",
	{
		handle: Argument.String("handle").pipe(
			Argument.withDescription("The handle to release")
		),
	},
	(o) =>
		Effect.gen(function* () {
			const { dir } = yield* relay;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			if (!isHandle(o.handle)) {
				return yield* new RelayError({ message: notHandle(o.handle) });
			}

			const folder = yield* relayDir(dir);

			yield* fs.access(path.join(folder, "relay_key")).pipe(
				Effect.mapError(
					(cause) =>
						new RelayError({
							message: `${folder} holds no relay (it has no relay_key); pass the relay's folder with --dir`,
							cause,
						})
				)
			);

			yield* checkRelayDir(folder);
			const handles = path.join(folder, "handles.json");
			const holder = yield* forgetHandle(handles, o.handle);

			return yield* holder === undefined
				? Console.log(
						`supervillain: no GM holds the handle ${o.handle} in ${handles}`
					)
				: Console.log(
						`supervillain: released the handle ${o.handle} in ${handles}, held by GM key${holder.length === 1 ? "" : "s"} ${holder.join(", ")}`
					).pipe(
						Effect.andThen(
							Console.log(
								"The next GM to link a table under it claims it; tables linked now stay open until they drop."
							)
						)
					);
		}).pipe(Effect.catchTags({ RelayError: fail, HandlesError: fail }))
).pipe(
	Command.withDescription(
		"Release a handle's claim, so another GM's key can take it"
	)
);

export const relayCommand = run.pipe(
	Command.withDescription(
		"Run a relay: players ssh to it, GMs' hosts dial out to it, and it carries the bytes between"
	),
	Command.withSubcommands([forget])
);
