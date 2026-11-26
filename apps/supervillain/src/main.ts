import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
	DEFAULT_RULESET,
	MAP_SEED_MAX,
	RULESET_NAMES as RULESETS,
} from "@supervillain/domain";
import type { Door, MapWriteReason } from "@supervillain/domain";
import { isFingerprint } from "@supervillain/ssh";
import {
	Cause,
	Config,
	Console,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	Runtime,
	Schema,
	Stream,
} from "effect";
import type { PlatformError, Types } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import { CAMPAIGN_FILE } from "./content/campaignFile.ts";
import {
	CampaignError,
	COMPILED,
	madeWith,
	writeCampaign,
} from "./content/newCampaign.ts";
import { checkLog } from "./host/check.ts";
import { configDir, GmKey } from "./host/GmKey.ts";
import type { LocalSeatOptions } from "./host/LocalSeat.ts";
import {
	joinNote,
	linkAlert,
	parseRelayAddress,
	relayJoinCommand,
	roomSlug,
} from "./host/RelayLink.ts";
import type { TableServerOptions } from "./host/TableServer.ts";
import { GmConfig } from "./launcher/GmConfig.ts";
import type { GmConfigData } from "./launcher/GmConfig.ts";
import {
	isBareName,
	scanCampaigns,
	supervillainHome,
} from "./launcher/scan.ts";
import { bindProblem, portProblem, relayCommand } from "./relay/cli.ts";
import {
	DEFAULT_RELAY,
	HANDLE_RULE,
	isHandle,
	isPairingCode,
	isReservedHandle,
	isTableName,
	TABLE_RULE,
} from "./relay/protocol.ts";

class CheckError extends Schema.TaggedError<CheckError>()("CheckError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

class HostError extends Schema.TaggedError<HostError>()("HostError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

const SELF = COMPILED ? "supervillain" : "bun supervillain";

const LAST_COMMA = /, (?<last>[^,]*)$/u;

const LOCAL_PORT = 2222;

const LOCAL_BIND = "127.0.0.1";

const RELAY_KNOWN = "relay_known";

const fail = (e: { readonly message: string }) =>
	Console.error(`supervillain: ${e.message}`).pipe(
		Effect.andThen(
			Effect.sync(() => {
				process.exitCode = 1;
			})
		)
	);

const joinCommand = (room: string, bind: string, port: number) =>
	relayJoinCommand(
		room,
		bind === "0.0.0.0" || bind === "::" ? "<this machine's address>" : bind,
		port
	);

const CAMPAIGN_MARKS = [
	CAMPAIGN_FILE,
	"table.md",
	"events.jsonl",
	"host_key",
	"heroes/",
	"party/",
	"monsters/",
	"scenes/",
	"maps/",
] as const;

type Looks = true | "empty" | "unrelated";

const looksLikeCampaign = Effect.fn("main.looksLikeCampaign")(function* (
	dir: string
): Effect.fn.Return<
	Looks,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names = yield* fs.readDirectory(dir);

	const marked = yield* Effect.forEach(
		CAMPAIGN_MARKS,
		(mark) => {
			const folder = mark.endsWith("/");
			const name = folder ? mark.slice(0, -1) : mark;

			return names.includes(name)
				? fs.stat(path.join(dir, name)).pipe(
						Effect.map(({ type }) => type === (folder ? "Directory" : "File")),
						Effect.orElseSucceed(() => false)
					)
				: Effect.succeed(false);
		},
		{ concurrency: "unbounded" }
	);

	if (marked.includes(true)) {
		return true;
	}

	return names.length === 0 ? "empty" : "unrelated";
});

interface HostChoices {
	readonly port: number;
	readonly bind: string;
	readonly room: string;
	readonly handle: string | undefined;
	readonly claim: string | undefined;
	readonly relayText: string | undefined;
	readonly relayAddress:
		| { readonly host: string; readonly port: number }
		| undefined;
	readonly relayKey: string | undefined;
	readonly relayPlayerPort: number | undefined;
	readonly relayHostKey: string | undefined;
}

const relayNameProblem = (choices: HostChoices): string | undefined => {
	const { handle, room, claim } = choices;

	if (handle === undefined) {
		return `--relay needs your GM handle, which players type before the table's name: pick one with --handle (${HANDLE_RULE})`;
	}

	if (!isHandle(handle)) {
		return `--handle is ${HANDLE_RULE}, not ${handle}`;
	}

	if (isReservedHandle(handle)) {
		return `the handle ${handle} is reserved on a relay: pick another with --handle`;
	}

	if (!isTableName(room)) {
		return `a relay's table name is ${TABLE_RULE}: pick one with --table, not ${room}`;
	}

	return claim === undefined || isPairingCode(claim)
		? undefined
		: `--claim takes a code like sv- and 20 letters and digits, not ${claim}`;
};

const hostProblem = (choices: HostChoices): string | undefined => {
	if (choices.relayText !== undefined && choices.relayAddress === undefined) {
		return `--relay takes host:port, not ${choices.relayText}`;
	}

	const relayPort =
		choices.relayPlayerPort === undefined
			? undefined
			: portProblem("--relay-player-port", choices.relayPlayerPort, 1);

	const ports =
		portProblem("--port", choices.port) ??
		bindProblem(choices.bind) ??
		relayPort;

	if (ports !== undefined) {
		return ports;
	}

	if (choices.relayKey !== undefined && !isFingerprint(choices.relayKey)) {
		return `--relay-key takes a key fingerprint like SHA256:…, not ${choices.relayKey}`;
	}

	if (
		choices.relayHostKey !== undefined &&
		!isFingerprint(choices.relayHostKey)
	) {
		return `--relay-host-key takes a key fingerprint like SHA256:…, not ${choices.relayHostKey}`;
	}

	if (choices.relayAddress === undefined) {
		return choices.handle === undefined && choices.claim === undefined
			? undefined
			: "--handle and --claim go with --relay";
	}

	return relayNameProblem(choices);
};

const notACampaign = (dir: string, named: string, looks: Looks) => {
	const marks = CAMPAIGN_MARKS.join(", ").replace(LAST_COMMA, " or $<last>");

	const advice =
		looks === "empty"
			? `make one there with: ${SELF} new ${named}`
			: `make one in a new folder with: ${SELF} new <folder>`;

	return `${dir} isn't a campaign: it has no ${marks}; ${advice} (--example for the sample)`;
};

const campaignFolder = Effect.fn("main.campaignFolder")(function* (
	dir: string,
	named: string
) {
	const fs = yield* FileSystem.FileSystem;

	const unopenable = (cause: PlatformError.PlatformError) =>
		new HostError({
			message: `can't open the campaign folder ${dir}: ${cause.message}`,
			cause,
		});

	const folder = yield* fs.stat(dir).pipe(
		Effect.asSome,
		Effect.catchReason("PlatformError", "NotFound", () =>
			Effect.succeed(Option.none<FileSystem.File.Info>())
		),
		Effect.mapError(unopenable)
	);

	if (Option.isNone(folder)) {
		return yield* new HostError({
			message: `there's no campaign at ${dir}; make one with: ${SELF} new ${named} (--example for the sample)`,
		});
	}

	if (folder.value.type !== "Directory") {
		return yield* new HostError({
			message: `${dir} isn't a folder, so it can't be a campaign`,
		});
	}

	const looks = yield* looksLikeCampaign(dir).pipe(Effect.mapError(unopenable));

	return yield* looks === true
		? Effect.void
		: Effect.fail(new HostError({ message: notACampaign(dir, named, looks) }));
});

interface Hosting {
	readonly dir: string;
	readonly room: string;
	readonly handle: string | undefined;
	readonly claim: string | undefined;
	readonly door: Door | undefined;
	readonly gmKey: Buffer | undefined;
	readonly port: number;
	readonly bind: string;
	readonly lobby: boolean;
	readonly headless: boolean;
	readonly relayAddress: HostChoices["relayAddress"];
	readonly relayKey: string | undefined;
	readonly relayPlayerPort: number | undefined;
	readonly relayHostKey: string | undefined;
	readonly knownPath: string | undefined;
}

const serverOptions = (hosting: Hosting): TableServerOptions => {
	const options: Types.Mutable<TableServerOptions> = {
		campaignDir: hosting.dir,
		room: hosting.room,
		port: hosting.port,
		bind: hosting.bind,
		lobby: hosting.lobby,
	};

	if (hosting.relayAddress !== undefined && hosting.handle !== undefined) {
		const relay: Types.Mutable<NonNullable<TableServerOptions["relay"]>> = {
			...hosting.relayAddress,
			handle: hosting.handle,
		};

		if (hosting.claim !== undefined) {
			relay.claim = hosting.claim;
		}

		if (hosting.gmKey !== undefined) {
			relay.hostKey = hosting.gmKey;
		}

		if (hosting.relayKey !== undefined) {
			relay.relayKey = hosting.relayKey;
		}

		if (hosting.relayPlayerPort !== undefined) {
			relay.playerPort = hosting.relayPlayerPort;
		}

		if (hosting.knownPath !== undefined) {
			relay.knownPath = hosting.knownPath;
		}

		options.relay = relay;
	}

	return options;
};

const hostTable = Effect.fn("main.hostTable")(function* (hosting: Hosting) {
	const path = yield* Path.Path;
	const { dir, room } = hosting;

	yield* Effect.promise(async () => await import("../preload.ts"));

	const { tableServices } = yield* Effect.promise(
		async () => await import("./host/services.ts")
	);

	const { TableServer } = yield* Effect.promise(
		async () => await import("./host/TableServer.ts")
	);

	const { localSeat } = yield* Effect.promise(
		async () => await import("./host/LocalSeat.ts")
	);

	const { CampaignContent } = yield* Effect.promise(
		async () => await import("./content/index.ts")
	);

	const { agentsLine, McpSocket } = yield* Effect.promise(
		async () => await import("./mcp/socket.ts")
	);

	const logs = hosting.headless
		? Layer.empty
		: Logger.layer([
				Logger.toFile(Logger.formatSimple, path.join(dir, "host.log"), {
					flag: "a",
					mode: 0o600,
				}),
			]);

	const layer = Layer.mergeAll(
		TableServer.layer(serverOptions(hosting)),
		McpSocket.layerBestEffort({ campaignDir: dir, room })
	).pipe(Layer.provideMerge(tableServices(dir)), Layer.provideMerge(logs));

	const seated = Effect.gen(function* () {
		const server = yield* TableServer;
		const agents = yield* McpSocket;
		const { ruleset } = yield* CampaignContent;

		if (hosting.door !== undefined) {
			const { TableRoom } = yield* Effect.promise(
				async () => await import("./host/TableRoom.ts")
			);

			yield* (yield* TableRoom)
				.submit("gm", { type: "door", door: hosting.door })
				.pipe(
					Effect.catchTag("Refusal", (refused) =>
						Effect.logDebug(`--door: ${refused.message}`)
					)
				);
		}

		const { relay } = server;
		const direct = joinCommand(room, hosting.bind, server.port);
		const joining = relay?.joinCommand ?? direct;
		const through = relay === undefined ? "" : " (through the relay)";

		const relayHostKeyText =
			hosting.relayHostKey ??
			"ask whoever runs the relay (it prints it as its host key)";

		yield* Console.log(
			`supervillain: hosting "${room}" from ${dir}, playing ${ruleset}`
		);
		yield* Console.log(`players join with: ${joining}${through}`);

		if (relay !== undefined && hosting.relayAddress !== undefined) {
			const trusting =
				hosting.relayKey ??
				`the key in ${hosting.knownPath ?? path.join(dir, "relay_known")} (pinned on first link)`;

			yield* Console.log(
				`  players' ssh sees the relay's host key: ${relayHostKeyText}`
			);
			yield* Console.log(`players here can also join directly: ${direct}`);
			yield* Console.log(
				`relay ${hosting.relayAddress.host}:${hosting.relayAddress.port}, trusting ${trusting}`
			);
			yield* Console.log(
				hosting.lobby
					? "  its lobby lists this table to players whose key has sat here (--no-lobby: never)"
					: "  its lobby never lists this table (--no-lobby)"
			);
		}

		const directOnly =
			relay === undefined ? "" : " (this table's: direct connections only)";

		yield* Console.log(`host key ${server.hostKeyFingerprint}${directOnly}`);
		yield* Console.log(agentsLine(SELF, dir, agents));
		yield* Effect.logInfo(
			relay === undefined
				? `hosting "${room}" on ${hosting.bind}:${server.port}, players: ${joining}; host key ${server.hostKeyFingerprint}`
				: `hosting "${room}" on ${hosting.bind}:${server.port} (direct: ${direct}); through the relay: ${joining}; players' ssh sees the relay's host key: ${relayHostKeyText}; this table's host key ${server.hostKeyFingerprint} is for direct connections only`
		);

		if (hosting.headless) {
			return yield* Effect.never;
		}

		const seat: Types.Mutable<LocalSeatOptions> = {
			room,
			helpFooter:
				relay === undefined
					? `Players join with: ${joining}\nHost key: ${server.hostKeyFingerprint}`
					: `Players join through the relay with: ${joining}\nThe relay's host key, which their ssh sees: ${relayHostKeyText}\nPlayers here can join directly: ${direct} (host key ${server.hostKeyFingerprint})`,
			joinHint:
				relay === undefined
					? `${joining} · host key ${server.hostKeyFingerprint}`
					: joining,
		};

		if (relay !== undefined) {
			const relayHost =
				hosting.relayHostKey === undefined
					? ""
					: ` · relay host key ${hosting.relayHostKey}`;

			const relayJoining = `${relay.joinCommand}${relayHost}`;

			seat.joinNote = {
				get: Effect.map(relay.status.get, (s) => joinNote(s, relayJoining)),
				changes: Stream.map(relay.status.changes, (s) =>
					joinNote(s, relayJoining)
				),
			};

			seat.alert = {
				get: Effect.map(relay.status.get, linkAlert),
				changes: Stream.map(relay.status.changes, linkAlert),
			};
		}

		yield* localSeat(seat);

		return yield* Effect.logInfo("the GM left the table; shutting down");
	});

	return yield* Effect.flatMap(Layer.build(layer), (context) =>
		Effect.provideContext(seated, context)
	).pipe(
		Effect.scoped,
		Effect.catchTag("SshError", (failure) =>
			Effect.fail(
				failure.message.includes("EADDRINUSE")
					? new HostError({
							message: `port ${hosting.port} on ${hosting.bind} is in use (another table?); pick another with --port, or --port 0 for any free one`,
							cause: failure,
						})
					: failure
			)
		)
	);
});

const host = Command.make(
	"host",
	{
		campaignDir: Argument.String("campaign-dir").pipe(
			Argument.withDescription(
				"The campaign folder, made with `new` (default ./campaign); it holds events.jsonl and the host key"
			),
			Argument.withDefault("campaign")
		),
		port: Flag.Int("port").pipe(
			Flag.withDefault(2222),
			Flag.withDescription("SSH port for players (0 picks a free one)")
		),
		bind: Flag.String("bind").pipe(
			Flag.withDefault("127.0.0.1"),
			Flag.withDescription("Address to listen on (0.0.0.0 for every interface)")
		),
		room: Flag.String("table").pipe(
			Flag.withAlias("room"),
			Flag.optional,
			Flag.withDescription(
				"The table's name (default: the campaign folder's name, slugged); --room still works"
			)
		),
		handle: Flag.String("handle").pipe(
			Flag.optional,
			Flag.withDescription(
				"Your GM handle on the relay: players join with ssh <handle>/<table>@<relay>; your GM key (~/.config/supervillain/gm_key) holds it"
			)
		),
		claim: Flag.String("claim").pipe(
			Flag.optional,
			Flag.withDescription(
				"A claim code (sv-…) that adds this machine's GM key to a handle another of your machines holds"
			)
		),
		door: Flag.Literals("door", ["knock", "open"]).pipe(
			Flag.optional,
			Flag.withDescription(
				"knock (the default for a new table): newcomers wait for you to let them in; open: anyone who connects sits down. Kept in the log"
			)
		),
		relay: Flag.String("relay").pipe(
			Flag.optional,
			Flag.withDescription(
				"Also take players through this relay (host:port, port 7022 if left out); the host dials it"
			)
		),
		relayKey: Flag.String("relay-key").pipe(
			Flag.optional,
			Flag.withDescription(
				"The relay's key fingerprint to trust (SHA256:…, the relay prints it); else <campaign>/relay_known, filled on first link"
			)
		),
		relayPlayerPort: Flag.Int("relay-player-port").pipe(
			Flag.optional,
			Flag.withDescription(
				"The relay's port for players, for the join command you're shown (default 22)"
			)
		),
		relayHostKey: Flag.String("relay-host-key").pipe(
			Flag.optional,
			Flag.withDescription(
				"The relay's host key (SHA256:…, what players' ssh sees there; the relay prints it), shown with the join command for players to check"
			)
		),
		lobby: Flag.Boolean("lobby").pipe(
			Flag.withDefault(true),
			Flag.withDescription(
				"List this table in the relay's lobby for players whose key has sat here before; --no-lobby never lists it"
			)
		),
		headless: Flag.Boolean("headless").pipe(
			Flag.withDefault(false),
			Flag.withDescription("No GM seat in this terminal; logs go to stdout")
		),
	},
	Effect.fn(function* (o) {
		const path = yield* Path.Path;
		const dir = path.resolve(o.campaignDir);
		const room = Option.getOrElse(o.room, () => roomSlug(path.basename(dir)));
		const relayText = Option.getOrUndefined(o.relay);

		const relayAddress =
			relayText === undefined ? undefined : parseRelayAddress(relayText);

		const relayKey = Option.getOrUndefined(o.relayKey);
		const relayPlayerPort = Option.getOrUndefined(o.relayPlayerPort);
		const relayHostKey = Option.getOrUndefined(o.relayHostKey);
		const handle = Option.getOrUndefined(o.handle);
		const claim = Option.getOrUndefined(o.claim);

		const problem = hostProblem({
			port: o.port,
			bind: o.bind,
			room,
			handle,
			claim,
			relayText,
			relayAddress,
			relayKey,
			relayPlayerPort,
			relayHostKey,
		});

		if (problem !== undefined) {
			return yield* new HostError({ message: problem });
		}

		yield* campaignFolder(dir, o.campaignDir);

		const gmKey =
			relayAddress === undefined
				? undefined
				: yield* GmKey.make().pipe(
						Effect.tap((key) =>
							Console.log(`your GM key ${key.fingerprint} (${key.path})`)
						),
						Effect.mapError(
							(cause) => new HostError({ message: cause.message, cause })
						)
					);

		return yield* hostTable({
			dir,
			room,
			handle,
			claim,
			door: Option.getOrUndefined(o.door),
			gmKey: gmKey?.pem,
			port: o.port,
			bind: o.bind,
			lobby: o.lobby,
			headless: o.headless,
			relayAddress,
			relayKey,
			relayPlayerPort,
			relayHostKey,
			knownPath: undefined,
		});
	})
).pipe(
	Command.withDescription(
		"Open the table: the campaign log, the SSH server and (unless --headless) the GM's seat"
	)
);

const envText = (name: string) =>
	Config.option(Config.String(name)).pipe(
		Effect.map((set) => Option.filter(set, (text) => text !== "")),
		Effect.orElseSucceed(() => Option.none<string>())
	);

const relayFor = Effect.fn("main.relayFor")(function* (
	flag: Option.Option<string>,
	config: GmConfigData
) {
	const fromEnv = yield* envText("SUPERVILLAIN_RELAY");

	return Option.getOrElse(
		Option.orElse(flag, () => fromEnv),
		() => config.relay ?? DEFAULT_RELAY
	);
});

const gmSettings = Effect.gen(function* () {
	const gm = yield* GmConfig.make();
	const config = yield* gm.read;

	return { gm, config };
});

const remembered = Effect.fn("main.remembered")(function* (
	gm: GmConfig["Service"],
	config: GmConfigData,
	handle: string | undefined,
	explicit: boolean
) {
	if (handle === undefined || config.handle === handle) {
		return;
	}

	if (config.handle !== undefined && !explicit) {
		return;
	}

	yield* gm.save({ ...config, handle });
	yield* Console.log(
		config.handle === undefined
			? `supervillain: saved your handle ${handle} in ${gm.path}`
			: `supervillain: your handle is ${handle} now, not ${config.handle}; saved in ${gm.path}`
	);
});

interface Opening {
	readonly room: string;
	readonly port: number;
	readonly relayAddress: HostChoices["relayAddress"];
}

const openingOf = Effect.fn("main.openingOf")(function* (
	dir: string,
	handle: string | undefined,
	claim: string | undefined,
	relayText: string | undefined
) {
	const path = yield* Path.Path;
	const room = roomSlug(path.basename(dir));

	const relayAddress =
		relayText === undefined ? undefined : parseRelayAddress(relayText);

	const port = relayText === undefined ? LOCAL_PORT : 0;

	const problem = hostProblem({
		port,
		bind: LOCAL_BIND,
		room,
		handle,
		claim,
		relayText,
		relayAddress,
		relayKey: undefined,
		relayPlayerPort: undefined,
		relayHostKey: undefined,
	});

	if (problem !== undefined) {
		return yield* new HostError({ message: problem });
	}

	const opening: Opening = { room, port, relayAddress };

	return opening;
});

const openTable = Effect.fn("main.openTable")(function* (
	dir: string,
	handle: string | undefined,
	claim: string | undefined,
	relayText: string | undefined
) {
	const path = yield* Path.Path;

	const { room, port, relayAddress } = yield* openingOf(
		dir,
		handle,
		claim,
		relayText
	);

	yield* campaignFolder(dir, dir);

	const gmKey =
		relayAddress === undefined
			? undefined
			: yield* GmKey.make().pipe(
					Effect.tap((key) =>
						Console.log(`your GM key ${key.fingerprint} (${key.path})`)
					),
					Effect.mapError(
						(cause) => new HostError({ message: cause.message, cause })
					)
				);

	return yield* hostTable({
		dir,
		room,
		handle,
		claim,
		door: undefined,
		gmKey: gmKey?.pem,
		port,
		bind: LOCAL_BIND,
		lobby: true,
		headless: false,
		relayAddress,
		relayKey: undefined,
		relayPlayerPort: undefined,
		relayHostKey: undefined,
		knownPath: path.join(yield* configDir, RELAY_KNOWN),
	});
});

const newFolder = Effect.fn("main.newFolder")(function* (
	named: string,
	opening: boolean
) {
	const path = yield* Path.Path;

	return opening && isBareName(named)
		? path.join(yield* supervillainHome, named)
		: path.resolve(named);
});

const make = Command.make(
	"new",
	{
		campaignDir: Argument.String("campaign-dir").pipe(
			Argument.withDescription(
				"The folder to make; it must be missing or empty. With --open or --claim, a bare name goes in SUPERVILLAIN_HOME (else ~/supervillain)"
			)
		),
		rules: Flag.Literals("rules", RULESETS).pipe(
			Flag.optional,
			Flag.withDescription(
				"What the campaign plays: draw-steel (the default), set-world, pf2e or freeform, written to its campaign.yaml"
			)
		),
		example: Flag.Boolean("example").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Copy the sample campaign: four heroes, the bandits and the map for one Draw Steel fight"
			)
		),
		handle: Flag.String("handle").pipe(
			Flag.optional,
			Flag.withDescription(
				"Your GM handle on the relay, for --open; saved in gm.json the first time"
			)
		),
		claim: Flag.String("claim").pipe(
			Flag.optional,
			Flag.withDescription(
				"A pairing code (sv-…) from the relay's lobby that adds this machine's GM key to your handle; implies --open"
			)
		),
		open: Flag.Boolean("open").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Open the new table straight away, linked to the relay (--relay, SUPERVILLAIN_RELAY, gm.json, else supervillain.sh)"
			)
		),
		relay: Flag.String("relay").pipe(
			Flag.optional,
			Flag.withDescription(
				"With --open or --claim, the relay to link to (host:port; default SUPERVILLAIN_RELAY, gm.json, then supervillain.sh:7022)"
			)
		),
	},
	Effect.fn(function* (o) {
		const rules = Option.getOrElse(o.rules, () => DEFAULT_RULESET);
		const claim = Option.getOrUndefined(o.claim);
		const opening = o.open || claim !== undefined;
		const dir = yield* newFolder(o.campaignDir, opening);

		if (o.example && rules !== "draw-steel") {
			return yield* new CampaignError({
				message: `the sample campaign plays draw-steel, so --example can't make a ${rules} campaign; leave out --example for an empty one`,
			});
		}

		if (!opening && Option.isSome(o.handle)) {
			return yield* new CampaignError({
				message:
					"--handle goes with --open (or --claim, which opens the table)",
			});
		}

		if (!opening && Option.isSome(o.relay)) {
			return yield* new CampaignError({
				message: "--relay goes with --open (or --claim, which opens the table)",
			});
		}

		if (claim !== undefined && !isPairingCode(claim)) {
			return yield* new CampaignError({
				message: `--claim takes a code like sv- and 20 letters and digits, not ${claim}`,
			});
		}

		const settings = opening ? Option.some(yield* gmSettings) : Option.none();

		const handle = Option.getOrUndefined(
			Option.orElse(o.handle, () =>
				Option.flatMap(settings, ({ config }) =>
					Option.fromNullishOr(config.handle)
				)
			)
		);

		if (Option.isSome(settings) && handle === undefined) {
			return yield* new CampaignError({
				message: `opening a table on the relay needs your GM handle: pass --handle <you> (${HANDLE_RULE})`,
			});
		}

		const relayText = yield* Option.match(settings, {
			onNone: () => Effect.succeed<string | undefined>(undefined),
			onSome: ({ config }) => relayFor(o.relay, config),
		});

		if (Option.isSome(settings)) {
			yield* openingOf(dir, handle, claim, relayText).pipe(
				Effect.mapError(
					(failure) => new CampaignError({ message: failure.message })
				)
			);
		}

		yield* writeCampaign(dir, rules, o.example);

		const from = o.example ? " from the sample campaign" : madeWith(rules);

		yield* Console.log(`supervillain: made ${dir}${from}`);

		if (Option.isNone(settings)) {
			return yield* Console.log(`host it with: ${SELF} host ${o.campaignDir}`);
		}

		const { gm, config } = settings.value;
		yield* remembered(gm, config, handle, Option.isSome(o.handle));

		return yield* openTable(dir, handle, claim, relayText);
	})
).pipe(
	Command.withDescription(
		"Make a campaign folder: its campaign.yaml, heroes/ and monsters/ for sheets, maps/ for maps, or the sample campaign with --example; --open (or --claim) opens it on the relay"
	)
);

const launch = Effect.fn("main.launch")(function* (o: {
	readonly local: boolean;
	readonly relay: Option.Option<string>;
}) {
	if (o.local && Option.isSome(o.relay)) {
		return yield* new HostError({
			message:
				"--local opens tables on this machine only, so it can't go with --relay; pick one",
		});
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return yield* new CliError.ShowHelp({
			commandPath: ["supervillain"],
			errors: [],
		});
	}

	const path = yield* Path.Path;
	const { gm, config } = yield* gmSettings;
	const home = yield* supervillainHome;

	const relayText = o.local ? undefined : yield* relayFor(o.relay, config);

	const campaigns = yield* scanCampaigns(process.cwd(), home);

	const { runLauncher } = yield* Effect.promise(async () => {
		await import("../preload.ts");

		return await import("./launcher/Launcher.tsx");
	});

	const choice = yield* Effect.promise(
		async () =>
			await runLauncher({
				campaigns,
				home,
				handle: config.handle,
				relay: relayText,
			})
	);

	if (choice.kind === "quit") {
		return yield* Effect.void;
	}

	const handle =
		choice.kind === "new"
			? (choice.table.handle ?? config.handle)
			: (choice.handle ?? config.handle);

	const dir =
		choice.kind === "new" ? path.join(home, choice.table.slug) : choice.dir;

	const linking = relayText === undefined ? undefined : handle;

	yield* openingOf(dir, linking, undefined, relayText);

	if (choice.kind === "new") {
		yield* writeCampaign(dir, choice.table.rules, choice.table.example);
		yield* Console.log(`supervillain: made ${dir}`);
	}

	if (relayText !== undefined) {
		yield* remembered(gm, config, handle, false);
	}

	return yield* openTable(dir, linking, undefined, relayText);
});

const importFromPathbuilder = Effect.fn("main.importFromPathbuilder")(
	function* (
		names: ReadonlyArray<string>,
		into: string | undefined,
		overwrite: boolean
	) {
		const path = yield* Path.Path;

		const { importPathbuilder, pathbuilderReportText } = yield* Effect.promise(
			async () => await import("./content/index.ts")
		);

		const [file, campaign, extra] = names;
		const target = campaign ?? into;

		if (file === undefined || target === undefined || extra !== undefined) {
			return yield* new CampaignError({
				message: `usage: ${SELF} import pathbuilder <file.json> <campaign-dir> [--overwrite]`,
			});
		}

		const imported = yield* importPathbuilder({
			from: path.resolve(file),
			into: path.resolve(target),
			overwrite,
		});

		return yield* Effect.forEach(
			pathbuilderReportText(imported),
			(line) => Console.log(line),
			{
				concurrency: 1,
				discard: true,
			}
		);
	}
);

const importFromBestiary = Effect.fn("main.importFromBestiary")(function* (
	from: string,
	names: ReadonlyArray<string>,
	into: string | undefined,
	overwrite: boolean
) {
	const path = yield* Path.Path;

	const { importBestiary, importReportText } = yield* Effect.promise(
		async () => await import("./content/index.ts")
	);

	if (into === undefined) {
		return yield* new CampaignError({
			message: `usage: ${SELF} import <bestiary-json-path> --into <campaign-dir> [names...]`,
		});
	}

	const report = yield* importBestiary({
		from: path.resolve(from),
		into: path.resolve(into),
		names,
		overwrite,
	});

	yield* Effect.forEach(importReportText(report), (line) => Console.log(line), {
		concurrency: 1,
		discard: true,
	});

	const missed =
		report.failed.length + report.notFound.length + report.ambiguous.length;

	if (report.imported.length === 0 && missed === 0) {
		return yield* new CampaignError({
			message: `no creatures found in ${path.resolve(from)}`,
		});
	}

	const notImported = missed === 1 ? "one creature" : `${missed} creatures`;

	return yield* missed > 0
		? Effect.fail(new CampaignError({ message: `${notImported} not imported` }))
		: Effect.void;
});

const importMonsters = Command.make(
	"import",
	{
		from: Argument.String("bestiary-json-path").pipe(
			Argument.withDescription(
				"A local copy of Steel Compendium's data-bestiary-json: the folder or one file; or the word pathbuilder, then a Pathbuilder 2e export and the campaign folder"
			)
		),
		names: Argument.String("names").pipe(
			Argument.variadic(),
			Argument.withDescription(
				"Creatures to import, by name or id; every one when left out"
			)
		),
		into: Flag.String("into").pipe(
			Flag.optional,
			Flag.withDescription(
				"The campaign folder; monster files go in its monsters/"
			)
		),
		overwrite: Flag.Boolean("overwrite").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Replace monster files that are already there")
		),
	},
	(o) =>
		o.from === "pathbuilder"
			? importFromPathbuilder(
					o.names,
					Option.getOrUndefined(o.into),
					o.overwrite
				)
			: importFromBestiary(
					o.from,
					o.names,
					Option.getOrUndefined(o.into),
					o.overwrite
				)
).pipe(
	Command.withDescription(
		"Turn Steel Compendium bestiary JSON into monster files in a campaign's monsters/, or (import pathbuilder <file.json> <campaign-dir>) a Pathbuilder 2e export into a PF2e hero file in its heroes/"
	)
);

const mapAdvice = (
	reason: MapWriteReason,
	message: string,
	campaignDir: string
): string => {
	if (reason === "exists") {
		return `${message}; pick another --id`;
	}

	return reason === "no-campaign"
		? `${message}; make one with: ${SELF} new ${campaignDir}`
		: message;
};

const mapCommand = Command.make(
	"map",
	{
		kind: Argument.String("kind").pipe(
			Argument.withDescription(
				"What kind of place: crossing (a river, a road, woods, a ruin) or keep"
			)
		),
		campaignDir: Argument.String("campaign-dir").pipe(
			Argument.withDescription("The campaign folder; the map goes in its maps/")
		),
		seed: Flag.Int("seed").pipe(
			Flag.optional,
			Flag.withDescription(
				"The seed, 0 to 4294967295: the same kind and seed always make the same map"
			)
		),
		id: Flag.String("id").pipe(
			Flag.optional,
			Flag.withDescription(
				"The map's id, its file name in maps/ (default: <kind>-<seed>)"
			)
		),
	},
	Effect.fn(function* (o) {
		const path = yield* Path.Path;
		const random = yield* SecureRandom.SecureRandom;

		const [{ writeGeneratedMap }, { formatSquare, MAP_KINDS }] =
			yield* Effect.promise(
				async () =>
					await Promise.all([
						import("./content/newMap.ts"),
						import("@supervillain/domain"),
					])
			);

		const kind = MAP_KINDS.find((k) => k === o.kind.toLowerCase());

		if (kind === undefined) {
			return yield* new CampaignError({
				message: `there's no kind of map called ${o.kind}; there are: ${MAP_KINDS.join(", ")}`,
			});
		}

		const seed = Option.isSome(o.seed)
			? o.seed.value
			: yield* random.intBetween(0, MAP_SEED_MAX);

		const written = yield* writeGeneratedMap(
			path.resolve(o.campaignDir),
			kind,
			seed,
			Option.getOrUndefined(o.id)
		).pipe(
			Effect.mapError(
				(cause) =>
					new CampaignError({
						message: mapAdvice(cause.reason, cause.message, o.campaignDir),
						cause,
					})
			)
		);

		const { id, map } = written;

		yield* Console.log(
			`supervillain: wrote ${map.name} to ${written.file} (${kind}, seed ${written.seed})`
		);
		yield* Console.log(map.lines.map((line) => `  ${line}`).join("\n"));

		const squares = (list: ReadonlyArray<{ x: number; y: number }>) =>
			list.slice(0, 4).map(formatSquare).join(" ");

		yield* Console.log(
			`the party can start at ${squares(map.deploy.west)}, their foes at ${squares(map.deploy.east)}`
		);

		return yield* Console.log(`load it at the table with: /map ${id}`);
	})
).pipe(
	Command.withDescription(
		"Generate a battlemap in MEKMODE letters into a campaign's maps/: a river crossing or a keep"
	)
);

const readLog = Effect.fn("main.readLog")(function* (dir: string, log: string) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.readFileString(log).pipe(
		Effect.asSome,
		Effect.catchReason("PlatformError", "NotFound", () =>
			fs.stat(dir).pipe(
				Effect.as(Option.none<string>()),
				Effect.catchReason("PlatformError", "NotFound", (cause) =>
					Effect.fail(
						new CheckError({ message: `there's no campaign at ${dir}`, cause })
					)
				)
			)
		),
		Effect.catchTag("PlatformError", (cause) =>
			Effect.fail(
				new CheckError({
					message: `can't read ${log}: ${cause.message}`,
					cause,
				})
			)
		)
	);
});

const check = Command.make(
	"check",
	{
		campaignDir: Argument.String("campaign-dir").pipe(
			Argument.withDescription("Folder holding events.jsonl")
		),
	},
	Effect.fn(function* (o) {
		const path = yield* Path.Path;
		const dir = path.resolve(o.campaignDir);
		const log = path.join(dir, "events.jsonl");
		const text = yield* readLog(dir, log);

		const { validateCampaign, problemLine, keyedDocs } = yield* Effect.promise(
			async () => await import("./content/index.ts")
		);

		const { rules, index, problems } = yield* validateCampaign(dir).pipe(
			Effect.mapError(
				(cause) => new CheckError({ message: cause.message, cause })
			)
		);

		for (const problem of problems) {
			yield* Console.error(problemLine(problem));
		}

		const files = keyedDocs(index).length + (index.table === undefined ? 0 : 1);

		const content =
			problems.length > 0
				? new CheckError({
						message: `${dir}: ${problems.length === 1 ? "a problem" : `${problems.length} problems`} in the campaign's files`,
					})
				: undefined;

		if (Option.isNone(text)) {
			yield* Console.log(`${log}: no log yet; the table hasn't been opened`);
		} else {
			const report = checkLog(log, text.value, rules);

			for (const warning of report.warnings) {
				yield* Console.error(warning);
			}

			yield* Console.log(report.out.join("\n"));

			if (report.error !== undefined) {
				return yield* new CheckError({ message: report.error });
			}
		}

		if (content !== undefined) {
			return yield* content;
		}

		return yield* files === 0
			? Effect.void
			: Console.log(
					`${dir}: ${files} campaign ${files === 1 ? "file" : "files"}, no problems`
				);
	})
).pipe(
	Command.withDescription(
		"Check a campaign without opening it: its Markdown files (fields, links between them, sizes), then its log's summary, skipped events, feed and final state"
	)
);

const schemaCommand = Command.make(
	"schema",
	{
		campaignDir: Argument.String("campaign-dir").pipe(
			Argument.withDescription(
				"The campaign whose rules the schemas follow; they go in its schemas/ unless --out says"
			),
			Argument.withDefault(".")
		),
		out: Flag.String("out").pipe(
			Flag.optional,
			Flag.withDescription("The folder to write the schemas into")
		),
		draft: Flag.Literals("draft", ["2020-12", "07"]).pipe(
			Flag.withDefault("2020-12"),
			Flag.withDescription(
				"The JSON Schema draft: 2020-12 (the default) or 07, for editors that want it"
			)
		),
	},
	Effect.fn(function* (o) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const dir = path.resolve(o.campaignDir);
		const out = Option.getOrElse(o.out, () => path.join(dir, "schemas"));

		const { readCampaignConfig, schemaFiles } = yield* Effect.promise(
			async () => await import("./content/index.ts")
		);

		const { rules } = yield* readCampaignConfig(dir);
		const files = schemaFiles(rules, o.draft);

		const unwritten = (cause: PlatformError.PlatformError) =>
			new CampaignError({
				message: `can't write the schemas to ${out}: ${cause.message}`,
				cause,
			});

		yield* fs
			.makeDirectory(out, { recursive: true })
			.pipe(Effect.mapError(unwritten));

		yield* Effect.forEach(
			files,
			(file) =>
				fs
					.writeFileString(path.join(out, file.file), file.text)
					.pipe(Effect.mapError(unwritten)),
			{ concurrency: 1, discard: true }
		);

		return yield* Console.log(
			`supervillain: wrote ${files.length} files (JSON Schema draft ${o.draft}, rules ${rules}) to ${out}; index.json maps each file pattern to its schema`
		);
	})
).pipe(
	Command.withDescription(
		"Write JSON Schemas for a campaign's Markdown frontmatter (table.md, scenes/, npcs/, party/ and the rest), for editors to check as you type"
	)
);

const mcpCommand = Command.make(
	"mcp",
	{
		campaignDir: Argument.String("campaign-dir").pipe(
			Argument.withDescription(
				"The campaign folder of a table open on this machine (default ./campaign)"
			),
			Argument.withDefault("campaign")
		),
	},
	Effect.fn(function* (o) {
		const { bridgeMcp } = yield* Effect.promise(
			async () => await import("./mcp/bridge.ts")
		);

		return yield* bridgeMcp({
			campaignDir: o.campaignDir,
			stdin: process.stdin,
			stdout: process.stdout,
		});
	})
).pipe(
	Command.withDescription(
		"Connect an AI agent to a table open on this machine as its GM: speaks MCP on stdin and stdout"
	)
);

if (process.stdin.isTTY) {
	process.on("SIGHUP", () => {
		process.kill(process.pid, "SIGTERM");
	});
}

Command.make(
	"supervillain",
	{
		local: Flag.Boolean("local").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"In the launcher, open tables on this machine only, not linked to a relay"
			)
		),
		relay: Flag.String("relay").pipe(
			Flag.optional,
			Flag.withDescription(
				"In the launcher, the relay tables link to (host:port; default SUPERVILLAIN_RELAY, gm.json, then supervillain.sh:7022)"
			)
		),
	},
	launch
).pipe(
	Command.withDescription(
		"A terminal-first virtual tabletop for Draw Steel, set.world's rules, PF2e or freeform. Run it bare in a terminal for your tables"
	),
	Command.withSubcommands([
		host,
		make,
		mapCommand,
		importMonsters,
		check,
		schemaCommand,
		mcpCommand,
		relayCommand,
	]),
	Command.run({ version: process.env.SUPERVILLAIN_VERSION ?? "0.0.0" }),
	Effect.catchTags({
		CampaignConfigInvalid: fail,
		CampaignError: fail,
		ContentInvalid: fail,
		CheckError: fail,
		ContentReadError: fail,
		GmConfigError: fail,
		HostError: fail,
		LogError: fail,
		McpBridgeError: fail,
		McpSocketError: fail,
		SshError: fail,
	}),
	Effect.provide([
		BunServices.layer,
		FetchHttpClient.layer,
		SecureRandom.layerWebCrypto,
	]),
	BunRuntime.runMain({
		teardown: (exit, onExit) => {
			if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
				onExit(0);
			} else {
				Runtime.defaultTeardown(exit, onExit);
			}
		},
	})
);
