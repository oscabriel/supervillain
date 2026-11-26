import { GM } from "@supervillain/domain";
import { addressBucket } from "@supervillain/ssh";
import type { Rate, RawSession, ShellSession } from "@supervillain/ssh";
import { Cause, Context, Effect, Layer, Scope, SubscriptionRef } from "effect";
import type { FileSystem, Path } from "effect";
import { SecureRandom } from "effect/crypto";

import { examplePath } from "../content/newCampaign.ts";
import { PLAYER_RATE, SANDBOX_LOG_CAP } from "../host/TableRoom.ts";

export interface SandboxOptions {
	readonly live?: number;
	readonly perAddress?: number;
	readonly perKey?: number;
	readonly idleMs?: number;
	readonly maxMs?: number;
	readonly warnMs?: number;
	readonly logCap?: number;
	readonly minCols?: number;
	readonly minRows?: number;
	readonly rate?: Rate;
	readonly campaignDir?: string;
}

export interface SandboxLimits {
	readonly live: number;
	readonly perAddress: number;
	readonly perKey: number;
	readonly idleMs: number;
	readonly maxMs: number;
	readonly warnMs: number;
	readonly logCap: number;
	readonly minCols: number;
	readonly minRows: number;
	readonly rate: Rate;
	readonly campaignDir: string | undefined;
}

export const SANDBOX_LIVE = 12;

const SANDBOX_DEFAULTS: SandboxLimits = {
	live: SANDBOX_LIVE,
	perAddress: 1,
	perKey: 1,
	idleMs: 5 * 60_000,
	maxMs: 20 * 60_000,
	warnMs: 60_000,
	logCap: SANDBOX_LOG_CAP,
	minCols: 100,
	minRows: 30,
	rate: PLAYER_RATE,
	campaignDir: undefined,
};

export const sandboxLimits = (options: SandboxOptions = {}): SandboxLimits => ({
	...SANDBOX_DEFAULTS,
	...options,
	campaignDir: options.campaignDir,
});

export const SANDBOX_ROOM = "try";

export const SANDBOX_SETUP: ReadonlyArray<string> = [
	"/map ford-road",
	"/hero brann",
	"/hero ilsa",
	"/add bandit-chief",
	"/add bandit-bruiser",
	"/place brann b5",
	"/place ilsa b7",
	"/place bandit-chief p5",
	"/place bandit-bruiser h5",
];

const SETUP_RATE_KEY = "sandbox:setup";

const IDLE_TICK_MS = 1000;

export const SANDBOX_CLOSING =
	"This sandbox table closes in a minute; nothing here is saved.";

const SANDBOX_HELP =
	"This is a sandbox: a private Draw Steel table in the relay's memory. Nothing is saved, and it closes when you leave (Ctrl-C).";

export const NO_SANDBOXES = "This relay offers no sandbox tables.";

export const minutesOf = (ms: number): number =>
	Math.max(1, Math.round(ms / 60_000));

export const sizeProblem = (
	cols: number,
	rows: number,
	limits: SandboxLimits
): string | undefined =>
	cols >= limits.minCols && rows >= limits.minRows
		? undefined
		: `Try a Table needs a terminal of at least ${limits.minCols}×${limits.minRows}; this one is ${cols}×${rows}. Make the window bigger, then press Enter.`;

export type Admitted =
	| { readonly kind: "in"; readonly release: () => void }
	| { readonly kind: "out"; readonly reason: string };

export interface SandboxGate {
	readonly admit: (address: string, key: string | undefined) => Admitted;
	readonly live: () => number;
}

const out = (reason: string): Admitted => ({ kind: "out", reason });

const bump = (counts: Map<string, number>, name: string, by: 1 | -1) => {
	const next = (counts.get(name) ?? 0) + by;

	if (next <= 0) {
		counts.delete(name);
	} else {
		counts.set(name, next);
	}
};

export const sandboxGate = (limits: SandboxLimits): SandboxGate => {
	let live = 0;
	const byAddress = new Map<string, number>();
	const byKey = new Map<string, number>();

	return {
		live: () => live,
		admit: (address, key) => {
			if (limits.live <= 0) {
				return out(NO_SANDBOXES);
			}

			if (live >= limits.live) {
				return out(
					`Every sandbox table is in use (${limits.live}); try again in a few minutes.`
				);
			}

			const bucket = addressBucket(address);

			if ((byAddress.get(bucket) ?? 0) >= limits.perAddress) {
				return out(
					"Your address has a sandbox table open already; close that one first."
				);
			}

			if (key !== undefined && (byKey.get(key) ?? 0) >= limits.perKey) {
				return out(
					"Your key has a sandbox table open already; close that one first."
				);
			}

			live += 1;
			bump(byAddress, bucket, 1);

			if (key !== undefined) {
				bump(byKey, key, 1);
			}

			let released = false;

			return {
				kind: "in",
				release: () => {
					if (released) {
						return;
					}

					released = true;
					live -= 1;
					bump(byAddress, bucket, -1);

					if (key !== undefined) {
						bump(byKey, key, -1);
					}
				},
			};
		},
	};
};

const tableModules = Effect.promise(async () => {
	await import("../../preload.ts");

	const [services, seat, line] = await Promise.all([
		import("../host/services.ts"),
		import("../host/Seat.ts"),
		import("../host/line.ts"),
	]);

	return {
		sandboxServices: services.sandboxServices,
		openSeat: seat.openSeat,
		mountTable: seat.mountTable,
		runLine: line.runLine,
	};
});

type Modules = Effect.Success<typeof tableModules>;

const quietFor = (idleMs: number, activity: { count: number }) =>
	Effect.gen(function* () {
		const tick = Math.min(IDLE_TICK_MS, idleMs);
		let quiet = 0;
		let seen = activity.count;

		while (quiet < idleMs) {
			yield* Effect.sleep(tick);

			if (activity.count === seen) {
				quiet += tick;
			} else {
				seen = activity.count;
				quiet = 0;
			}
		}
	});

const played = (
	session: RawSession,
	shell: ShellSession,
	modules: Modules,
	dir: string,
	limits: SandboxLimits
) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			modules
				.sandboxServices(dir, {
					logCap: limits.logCap,
					playerRate: limits.rate,
				})
				.pipe(Layer.provide(SecureRandom.layerWebCrypto))
		);

		yield* Effect.forEach(
			SANDBOX_SETUP.entries(),
			([at, line]) =>
				modules
					.runLine(GM, line, "seat", `${SETUP_RATE_KEY}:${at}`)
					.pipe(
						Effect.tap((reply) =>
							reply.kind === "refusal"
								? Effect.logWarning(`sandbox: ${line}: ${reply.text}`)
								: Effect.void
						)
					),
			{ concurrency: 1, discard: true }
		).pipe(Effect.provideContext(context));

		const alert = yield* SubscriptionRef.make<string | undefined>(undefined);

		const view = yield* modules
			.openSeat({
				actor: GM,
				room: SANDBOX_ROOM,
				leave: shell.close,
				helpFooter: SANDBOX_HELP,
				joinHint: "a sandbox table: nothing is saved",
				alert: {
					get: SubscriptionRef.get(alert),
					changes: SubscriptionRef.changes(alert),
				},
			})
			.pipe(Effect.provideContext(context));

		yield* modules.mountTable(shell.renderer, view);

		const activity = { count: 0 };

		const touched = () => {
			activity.count += 1;
		};

		session.stream.on("data", touched);
		session.stream.resume();
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				session.stream.removeListener("data", touched);
			})
		);

		const warned = Math.max(0, limits.maxMs - limits.warnMs);

		const capped = Effect.gen(function* () {
			yield* Effect.sleep(warned);
			yield* SubscriptionRef.set(alert, SANDBOX_CLOSING);
			yield* Effect.sleep(limits.maxMs - warned);
		});

		const why = yield* Effect.raceFirst(
			Effect.as(quietFor(limits.idleMs, activity), "idle"),
			Effect.as(capped, "its time ran out")
		);

		yield* Effect.logInfo(
			`sandbox for ${session.info.identity.actor}: closed, ${why}`
		);
		shell.close();
	});

export const runSandbox = (
	session: RawSession,
	limits: SandboxLimits
): Effect.Effect<
	void,
	never,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const { asShell } = session;

		if (asShell === undefined) {
			session.stderr.write("Try a Table needs a terminal: ssh -t.\n");
			session.exit(1);

			return;
		}

		const modules = yield* tableModules;
		const dir = limits.campaignDir ?? (yield* examplePath);

		const platform = Context.omit(Scope.Scope)(
			yield* Effect.context<FileSystem.FileSystem | Path.Path>()
		);

		yield* Effect.logInfo(
			`sandbox for ${session.info.identity.actor} from ${session.info.remoteAddress}: opened`
		);

		yield* asShell((shell) =>
			played(session, shell, modules, dir, limits).pipe(
				Effect.provideContext(platform),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logError("sandbox: the table failed", cause).pipe(
								Effect.andThen(
									Effect.sync(() => {
										shell.close();
									})
								)
							)
				)
			)
		);
	}).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: Effect.logError("sandbox: couldn't open", cause)
		)
	);
