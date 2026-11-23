import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
	DEFAULT_RULESET,
	MAP_SEED_MAX,
	RULESET_NAMES as RULESETS,
} from "@supervillain/domain";
import type { MapWriteReason } from "@supervillain/domain";
import { isFingerprint } from "@supervillain/ssh";
import {
	Cause,
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
import { Argument, Command, Flag } from "effect/cli";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import {
	CAMPAIGN_FILE,
	campaignYaml,
	readCampaignConfig,
} from "./content/campaignFile.ts";
import { checkLog } from "./host/check.ts";
import type { LocalSeatOptions } from "./host/LocalSeat.ts";
import {
	joinNote,
	linkAlert,
	parseRelayAddress,
	relayJoinCommand,
	roomSlug,
} from "./host/RelayLink.ts";
import type { TableServerOptions } from "./host/TableServer.ts";
import { bindProblem, portProblem, relayCommand } from "./relay/cli.ts";
import { isReservedRoom, isRoomName } from "./relay/protocol.ts";

class CheckError extends Schema.TaggedError<CheckError>()("CheckError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

class HostError extends Schema.TaggedError<HostError>()("HostError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

class CampaignError extends Schema.TaggedError<CampaignError>()(
	"CampaignError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

const COMPILED = import.meta.dir.startsWith("/$bunfs/");

const SELF = COMPILED ? "supervillain" : "bun supervillain";

const LAST_COMMA = /, (?<last>[^,]*)$/u;

const examplePath = Effect.map(Path.Path, (path) =>
	COMPILED
		? path.join(import.meta.dir, "campaign")
		: path.join(import.meta.dir, "../../../examples/campaign")
);

const copyTree = (
	from: string,
	to: string
): Effect.Effect<
	void,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		for (const name of yield* fs.readDirectory(from)) {
			const source = path.join(from, name);
			const target = path.join(to, name);
			const { type } = yield* fs.stat(source);

			if (type === "Directory") {
				yield* fs.makeDirectory(target);
				yield* copyTree(source, target);
			} else {
				yield* fs.writeFile(target, yield* fs.readFile(source));
			}
		}
	});

const emptied = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		yield* Effect.forEach(
			yield* fs.readDirectory(dir),
			(name) => fs.remove(path.join(dir, name), { recursive: true }),
			{ concurrency: 1, discard: true }
		);
	}).pipe(Effect.ignore);

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
	"events.jsonl",
	"host_key",
	"heroes/",
	"monsters/",
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
	readonly relayText: string | undefined;
	readonly relayAddress:
		| { readonly host: string; readonly port: number }
		| undefined;
	readonly relayKey: string | undefined;
	readonly relayPlayerPort: number | undefined;
	readonly relayHostKey: string | undefined;
}

const relayRoomProblem = (room: string): string | undefined => {
	if (!isRoomName(room)) {
		return `a relay's room is 1-32 of a-z, 0-9 and -, starting with a letter: pick one with --room, not ${room}`;
	}

	return isReservedRoom(room)
		? `the room name ${room} is reserved on a relay, since a bare ssh sends names like it: pick another with --room`
		: undefined;
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

	return choices.relayAddress === undefined
		? undefined
		: relayRoomProblem(choices.room);
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
	readonly port: number;
	readonly bind: string;
	readonly lobby: boolean;
	readonly headless: boolean;
	readonly relayAddress: HostChoices["relayAddress"];
	readonly relayKey: string | undefined;
	readonly relayPlayerPort: number | undefined;
	readonly relayHostKey: string | undefined;
}

const serverOptions = (hosting: Hosting): TableServerOptions => {
	const options: Types.Mutable<TableServerOptions> = {
		campaignDir: hosting.dir,
		room: hosting.room,
		port: hosting.port,
		bind: hosting.bind,
		lobby: hosting.lobby,
	};

	if (hosting.relayAddress !== undefined) {
		const relay: Types.Mutable<NonNullable<TableServerOptions["relay"]>> = {
			...hosting.relayAddress,
		};

		if (hosting.relayKey !== undefined) {
			relay.relayKey = hosting.relayKey;
		}

		if (hosting.relayPlayerPort !== undefined) {
			relay.playerPort = hosting.relayPlayerPort;
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

	const logs = hosting.headless
		? Layer.empty
		: Logger.layer([
				Logger.toFile(Logger.formatSimple, path.join(dir, "host.log"), {
					flag: "a",
					mode: 0o600,
				}),
			]);

	const layer = TableServer.layer(serverOptions(hosting)).pipe(
		Layer.provideMerge(tableServices(dir)),
		Layer.provideMerge(logs)
	);

	const seated = Effect.gen(function* () {
		const server = yield* TableServer;
		const { ruleset } = yield* CampaignContent;
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
				`the key in ${path.join(dir, "relay_known")} (pinned on first link)`;

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
		room: Flag.String("room").pipe(
			Flag.optional,
			Flag.withDescription(
				"The room's name (default: the campaign folder's name, slugged)"
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
				"The relay's port for players, for the join command you're shown (default 2222, the relay's own)"
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

		const problem = hostProblem({
			port: o.port,
			bind: o.bind,
			room,
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

		return yield* hostTable({
			dir,
			room,
			port: o.port,
			bind: o.bind,
			lobby: o.lobby,
			headless: o.headless,
			relayAddress,
			relayKey,
			relayPlayerPort,
			relayHostKey,
		});
	})
).pipe(
	Command.withDescription(
		"Open the table: the campaign log, the SSH server and (unless --headless) the GM's seat"
	)
);

const isFree = (dir: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readDirectory(dir).pipe(
			Effect.map((names) => names.length === 0),
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.succeed(true)
			)
		)
	);

const README_BODY = {
	"draw-steel":
		"A supervillain campaign playing Draw Steel (campaign.yaml says so): hero sheets go in heroes/<id>.yaml, monster stat blocks in monsters/<id>.yaml, text maps in maps/<id>.txt, and the host keeps the log in events.jsonl.",
	"set-world":
		"A supervillain campaign playing set.world's rules (campaign.yaml says so): fighters are rolled at set.world at the table, text maps go in maps/<id>.txt, and the host keeps the log in events.jsonl.",
	pf2e: "A supervillain campaign playing PF2e (Remaster) rules under the ORC License (campaign.yaml says so): PC sheets go in heroes/<id>.yaml (import pathbuilder <file.json> writes one), creature stat blocks in monsters/<id>.yaml, text maps in maps/<id>.txt with 5-ft squares, and the host keeps the log in events.jsonl.",
} as const;

type Rules = keyof typeof README_BODY;

const readmeFor = (name: string, rules: Rules) =>
	`# ${name}\n\n${README_BODY[rules]}\n`;

const madeWith = (rules: Rules) => {
	if (rules === "set-world") {
		return ` playing ${rules}, with maps/`;
	}

	const playing = rules === "draw-steel" ? "" : ` playing ${rules},`;

	return `${playing} with heroes/, monsters/ and maps/`;
};

const emptyCampaign = Effect.fn("main.emptyCampaign")(function* (
	dir: string,
	rules: Rules
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.writeFileString(path.join(dir, CAMPAIGN_FILE), campaignYaml(rules));

	if (rules !== "set-world") {
		yield* fs.makeDirectory(path.join(dir, "heroes"));
		yield* fs.makeDirectory(path.join(dir, "monsters"));
	}

	yield* fs.makeDirectory(path.join(dir, "maps"));
	yield* fs.writeFileString(
		path.join(dir, "README.md"),
		readmeFor(path.basename(dir), rules)
	);
});

const makeCampaign = Effect.fn("main.makeCampaign")(function* (
	dir: string,
	rules: Rules,
	example: boolean
) {
	const fs = yield* FileSystem.FileSystem;

	const unmade = (cause: PlatformError.PlatformError) =>
		new CampaignError({
			message: `can't make a campaign in ${dir}: ${cause.message}`,
			cause,
		});

	const free = yield* isFree(dir).pipe(Effect.mapError(unmade));

	if (!free) {
		return yield* new CampaignError({
			message: `can't make a campaign in ${dir}: it already has files in it`,
		});
	}

	const made = example
		? Effect.flatMap(examplePath, (from) =>
				copyTree(from, dir).pipe(Effect.tapError(() => emptied(dir)))
			)
		: emptyCampaign(dir, rules);

	return yield* fs
		.makeDirectory(dir, { recursive: true, mode: 0o700 })
		.pipe(
			Effect.andThen(fs.chmod(dir, 0o700)),
			Effect.andThen(made),
			Effect.mapError(unmade)
		);
});

const make = Command.make(
	"new",
	{
		campaignDir: Argument.String("campaign-dir").pipe(
			Argument.withDescription(
				"The folder to make; it must be missing or empty"
			)
		),
		rules: Flag.Literals("rules", RULESETS).pipe(
			Flag.optional,
			Flag.withDescription(
				"What the campaign plays: draw-steel (the default), set-world or pf2e, written to its campaign.yaml"
			)
		),
		example: Flag.Boolean("example").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Copy the sample campaign: four heroes, the bandits and the map for one Draw Steel fight"
			)
		),
	},
	Effect.fn(function* (o) {
		const path = yield* Path.Path;
		const dir = path.resolve(o.campaignDir);
		const rules = Option.getOrElse(o.rules, () => DEFAULT_RULESET);

		if (o.example && rules !== "draw-steel") {
			return yield* new CampaignError({
				message: `the sample campaign plays draw-steel, so --example can't make a ${rules} campaign; leave out --example for an empty one`,
			});
		}

		yield* makeCampaign(dir, rules, o.example);

		const from = o.example ? " from the sample campaign" : madeWith(rules);

		yield* Console.log(`supervillain: made ${dir}${from}`);

		return yield* Console.log(`host it with: ${SELF} host ${o.campaignDir}`);
	})
).pipe(
	Command.withDescription(
		"Make a campaign folder: its campaign.yaml, heroes/ and monsters/ for sheets, maps/ for maps, or the sample campaign with --example"
	)
);

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

		if (Option.isNone(text)) {
			return yield* Console.log(
				`${log}: no log yet; the table hasn't been opened`
			);
		}

		const { rules } = yield* readCampaignConfig(dir).pipe(
			Effect.mapError(
				(cause) => new CheckError({ message: cause.message, cause })
			)
		);

		const report = checkLog(log, text.value, rules);

		for (const warning of report.warnings) {
			yield* Console.error(warning);
		}

		yield* Console.log(report.out.join("\n"));

		return yield* report.error === undefined
			? Effect.void
			: Effect.fail(new CheckError({ message: report.error }));
	})
).pipe(
	Command.withDescription(
		"Read a campaign log without opening it: summary, skipped events, feed and final state"
	)
);

if (process.stdin.isTTY) {
	process.on("SIGHUP", () => {
		process.kill(process.pid, "SIGTERM");
	});
}

Command.make("supervillain").pipe(
	Command.withDescription(
		"A terminal-first virtual tabletop for Draw Steel, or set.world's rules"
	),
	Command.withSubcommands([
		host,
		make,
		mapCommand,
		importMonsters,
		check,
		relayCommand,
	]),
	Command.run({ version: process.env.SUPERVILLAIN_VERSION ?? "0.0.0" }),
	Effect.catchTags({
		CampaignConfigInvalid: fail,
		CampaignError: fail,
		CheckError: fail,
		ContentReadError: fail,
		HostError: fail,
		LogError: fail,
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
