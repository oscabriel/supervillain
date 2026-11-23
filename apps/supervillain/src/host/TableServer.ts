import { plainText } from "@supervillain/domain";
import { addressBucket, serve, rateLimiter } from "@supervillain/ssh";
import type {
	ExecSession,
	SessionInfo,
	SshError,
	Rate,
} from "@supervillain/ssh";
import { Clock, Context, Effect, Layer, Match, Path, Scope } from "effect";
import type { FileSystem } from "effect";

import { KNOWS_SUBSYSTEM } from "../relay/protocol.ts";
import { execLine, runLine } from "./line.ts";
import { knowsSession } from "./lobby.ts";
import { RelayLink } from "./RelayLink.ts";
import type { RelayLinkOptions, RelayLinkService } from "./RelayLink.ts";
import { mountTable, openSeat } from "./Seat.ts";
import type { TableServices } from "./services.ts";

export interface TableServerOptions {
	readonly campaignDir: string;
	readonly room: string;
	readonly port: number;
	readonly bind: string;
	readonly execRate?: Rate;
	readonly relay?: Pick<
		RelayLinkOptions,
		"host" | "port" | "playerPort" | "relayKey" | "timeouts"
	>;
	readonly lobby?: boolean;
}

const EXEC_RATE: Rate = { burst: 20, perSecond: 2 };

const NO_PTY =
	"supervillain needs a terminal: run ssh -t, or one command at a time, e.g. ssh … help";

const SHUTDOWN = "The GM closed the table.";

export const minutes = (ms: number): string =>
	ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

const actorOf = (info: SessionInfo) => info.relayedActor ?? info.identity.actor;

export const rateKeyOf = (info: SessionInfo): string => {
	const actor = actorOf(info);

	if (actor.startsWith("key:")) {
		return actor;
	}

	if (info.relayedActor !== undefined) {
		return `relay:${info.identity.actor}/${actor}`;
	}

	return `address:${addressBucket(info.remoteAddress)}`;
};

export const execRateKeyOf = (info: SessionInfo): string =>
	info.relayedActor === undefined
		? `address:${addressBucket(info.remoteAddress)}`
		: rateKeyOf(info);

const execCommand = (
	session: ExecSession,
	allowed: (key: string, now: number) => boolean
) =>
	Effect.gen(function* () {
		const actor = actorOf(session.info);

		if (!allowed(execRateKeyOf(session.info), yield* Clock.currentTimeMillis)) {
			session.writeError(
				"Too many commands from your address; wait a moment.\n"
			);

			return 1;
		}

		const reply = yield* runLine(
			actor,
			execLine(session.command),
			"exec",
			rateKeyOf(session.info)
		);

		yield* Effect.logDebug(`exec ${actor}: ${reply.kind}`);

		return Match.value(reply).pipe(
			Match.discriminatorsExhaustive("kind")({
				done: (done) => {
					for (const line of done.lines) {
						session.write(`${plainText(line)}\n`);
					}

					return 0;
				},
				message: (said) => {
					session.write(`${said.text}\n`);

					return 0;
				},
				refusal: (refused) => {
					session.writeError(`${refused.text}\n`);

					return 1;
				},
				empty: () => {
					session.writeError(
						"Nothing to send. Try: ssh … roll 2d10, or ssh … help\n"
					);

					return 1;
				},
			})
		);
	});

export class TableServer extends Context.Service<
	TableServer,
	{
		readonly port: number;
		readonly hostKeyFingerprint: string;
		readonly relay?: RelayLinkService;
	}
>()("supervillain/host/TableServer") {
	static readonly make = (options: TableServerOptions) =>
		Effect.gen(function* () {
			const path = yield* Path.Path;

			const services = Context.omit(Scope.Scope)(
				yield* Effect.context<TableServices>()
			);

			const allowed = rateLimiter(options.execRate ?? EXEC_RATE);

			const server = yield* serve({
				hostKeyPath: path.join(options.campaignDir, "host_key"),
				port: options.port,
				host: options.bind,
				allowGuests: true,
				noPtyMessage: NO_PTY,
				shutdownNotice: SHUTDOWN,
				onShell: (session) =>
					Effect.gen(function* () {
						const actor = actorOf(session.info);
						const { cols, rows, remoteAddress, client, env } = session.info;

						const colour =
							env.COLORTERM === undefined
								? "no COLORTERM"
								: `COLORTERM=${env.COLORTERM}`;

						yield* Effect.logInfo(
							`seat open: ${actor} from ${remoteAddress} (${cols}x${rows}, ${session.info.term}, ${colour}, ${client})`
						);
						const openedAt = yield* Clock.currentTimeMillis;
						yield* Effect.addFinalizer(() =>
							Clock.currentTimeMillis.pipe(
								Effect.flatMap((now) =>
									Effect.logInfo(
										`seat closed: ${actor} after ${minutes(now - openedAt)}`
									)
								)
							)
						);

						const view = yield* openSeat({
							actor,
							rateKey: rateKeyOf(session.info),
							room: options.room,
							leave: session.close,
						});

						yield* mountTable(session.renderer, view);

						return yield* Effect.never;
					}).pipe(Effect.provideContext(services)),
				onExec: (session) =>
					execCommand(session, allowed).pipe(Effect.provideContext(services)),
				relaySubsystems: {
					[KNOWS_SUBSYSTEM]: (session) =>
						knowsSession(options.lobby ?? true)(session).pipe(
							Effect.provideContext(services)
						),
				},
			});

			const seated = {
				port: server.port,
				hostKeyFingerprint: server.hostKeyFingerprint,
			};

			if (options.relay === undefined) {
				return TableServer.of(seated);
			}

			const relay = yield* RelayLink.make({
				...options.relay,
				room: options.room,
				campaignDir: options.campaignDir,
				attach: server.attach,
			});

			return TableServer.of({ ...seated, relay });
		});

	static readonly layer = (
		options: TableServerOptions
	): Layer.Layer<
		TableServer,
		SshError,
		TableServices | FileSystem.FileSystem | Path.Path
	> => Layer.effect(TableServer, TableServer.make(options));
}
