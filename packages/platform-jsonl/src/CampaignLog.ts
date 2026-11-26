import { isUtf8 } from "node:buffer";

import {
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Predicate,
	Schema,
	SynchronizedRef,
} from "effect";
import type { PlatformError, Scope } from "effect";

import { LineJson } from "./envelope.ts";
import type { Line } from "./envelope.ts";
import { parseLog } from "./parseLog.ts";
import type { ParsedLog } from "./parseLog.ts";

export class LogError extends Schema.TaggedError<LogError>()("LogError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

interface WriterState {
	readonly seq: number;
	readonly size: number;
	readonly tail: ReadonlyArray<Line>;
}

const TAIL_LIMIT = 64;

export const MEMORY_PATH = ":memory:";

const io =
	(what: string) =>
	<A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
		Effect.mapError(
			effect,
			(cause) => new LogError({ message: `${what}: ${cause.message}`, cause })
		);

const NEWLINE = 0x0a;

const utf8Exact = new TextDecoder("utf-8", { ignoreBOM: true });

interface ReadLog {
	readonly parsed: ParsedLog;
	readonly size: number;
	readonly problem: LogError | undefined;
}

const garbledLine = (whole: Uint8Array): number | undefined => {
	if (isUtf8(whole)) {
		return undefined;
	}

	let line = 1;
	let start = 0;

	while (start < whole.length) {
		const end = whole.indexOf(NEWLINE, start);

		if (end === -1 || !isUtf8(whole.subarray(start, end))) {
			return line;
		}

		start = end + 1;
		line += 1;
	}

	return line;
};

const problemIn = (
	path: string,
	parsed: ParsedLog,
	garbled: number | undefined
) => {
	const before = parsed.error?.line ?? Number.POSITIVE_INFINITY;

	if (garbled !== undefined && garbled <= before) {
		return new LogError({ message: `${path}:${garbled}: not valid UTF-8` });
	}

	return parsed.error === undefined
		? undefined
		: new LogError({
				message: `${path}:${parsed.error.line}: ${parsed.error.message}`,
			});
};

const readBytes = (path: string, bytes: Uint8Array): ReadLog => {
	const size = bytes.lastIndexOf(NEWLINE) + 1;
	const parsed = parseLog(utf8Exact.decode(bytes));
	const garbled = garbledLine(bytes.subarray(0, size));

	return { parsed, size, problem: problemIn(path, parsed, garbled) };
};

const escapeForLog = (text: string) => {
	let out = "";

	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;

		out +=
			code < 0x20 || code === 0x7f
				? `\\x${code.toString(16).padStart(2, "0")}`
				: char;
	}

	return out;
};

const isRunning = (pid: number): boolean => {
	try {
		process.kill(pid, 0);

		return true;
	} catch (error) {
		return Predicate.hasProperty(error, "code") && error.code === "EPERM";
	}
};

const live = (owner: number) => owner > 0 && isRunning(owner);

const lockOwner = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		return yield* fs.readFileString(path).pipe(
			Effect.map((text) => Option.some(Number(text.trim()))),
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.succeed(Option.none<number>())
			)
		);
	});

const heldBy = (owner: number, path: string) =>
	new LogError({
		message: `lock campaign: another host (pid ${owner}) has this campaign open; if no host has it open, delete ${path} and start again`,
	});

const takeLock = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const now = yield* Clock.currentTimeMillis;
		const temporary = `${path}.${process.pid}.${now}.tmp`;
		const takeover = `${path}.takeover`;

		const linked = (target: string) =>
			fs.link(temporary, target).pipe(
				Effect.as(true),
				Effect.catchReason("PlatformError", "AlreadyExists", () =>
					Effect.succeed(false)
				)
			);

		const refuseLive = (owner: Option.Option<number>) =>
			Option.isSome(owner) && live(owner.value)
				? Effect.fail(heldBy(owner.value, path))
				: Effect.void;

		const clearStale = Effect.gen(function* () {
			const owner = yield* lockOwner(path);
			yield* refuseLive(owner);

			if (Option.isSome(owner)) {
				yield* fs
					.remove(path)
					.pipe(
						Effect.catchReason("PlatformError", "NotFound", () => Effect.void)
					);
			}
		});

		const takeOver = Effect.acquireUseRelease(
			linked(takeover),
			(mine) =>
				mine
					? clearStale
					: Effect.fail(
							new LogError({
								message: `lock campaign: another host is taking over this campaign's stale lock; if no host is, delete ${takeover} and start again`,
							})
						),
			(mine) => (mine ? fs.remove(takeover).pipe(Effect.ignore) : Effect.void)
		);

		const acquire = Effect.gen(function* () {
			while (!(yield* linked(path))) {
				const owner = yield* lockOwner(path);
				yield* refuseLive(owner);

				if (Option.isSome(owner)) {
					yield* takeOver;
				}
			}
		});

		yield* fs.writeFileString(temporary, `${process.pid}\n`);
		yield* acquire.pipe(
			Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore))
		);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) =>
			Effect.fail(
				new LogError({ message: `lock campaign: ${cause.message}`, cause })
			)
		)
	);

const releaseLock = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const owner = yield* lockOwner(path);

		if (Option.contains(owner, process.pid)) {
			yield* fs.remove(path);
		}
	}).pipe(Effect.ignore);

const encodeLine = Schema.encodeEffect(LineJson);

export interface CampaignLogService {
	readonly path: string;
	readonly lines: (
		after: number
	) => Effect.Effect<ReadonlyArray<Line>, LogError>;
	readonly recent: (
		count: number
	) => Effect.Effect<ReadonlyArray<Line>, LogError>;
	readonly append: (
		lines: ReadonlyArray<Line>
	) => Effect.Effect<void, LogError>;
}

export interface MemoryPlace {
	readonly cap: number;
}

const diskLog = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* Path.Path;
		const path = paths.join(dir, "events.jsonl");
		const lockPath = paths.join(dir, "events.lock");
		yield* fs
			.makeDirectory(dir, { recursive: true })
			.pipe(io("create campaign folder"));
		yield* Effect.acquireRelease(takeLock(lockPath), () =>
			releaseLock(lockPath)
		);
		const file = yield* fs.open(path, { flag: "a+" }).pipe(io("open log"));

		const read = fs.readFile(path).pipe(
			io("read log"),
			Effect.map((bytes) => readBytes(path, bytes))
		);

		const opened = yield* read;

		if (opened.parsed.torn !== undefined) {
			yield* file.truncate(opened.size).pipe(io("cut half-written line"));
			yield* Effect.logWarning(
				`Cut a half-written last line from ${path}: ${escapeForLog(opened.parsed.torn.slice(0, 80))}`
			);
		}

		if (opened.problem !== undefined) {
			return yield* opened.problem;
		}

		const state = yield* SynchronizedRef.make<WriterState>({
			seq: opened.parsed.lines.length,
			size: opened.size,
			tail: opened.parsed.lines.slice(-TAIL_LIMIT),
		});

		const lines = Effect.fn("CampaignLog.lines")(function* (after: number) {
			const written = yield* SynchronizedRef.get(state);

			if (written.seq - after <= written.tail.length) {
				return written.tail.filter((line) => line.seq > after);
			}

			const reread = yield* read;

			if (reread.problem !== undefined) {
				return yield* reread.problem;
			}

			return reread.parsed.lines
				.slice(0, written.seq)
				.filter((line) => line.seq > after);
		});

		const recent = Effect.fn("CampaignLog.recent")(function* (count: number) {
			if (count <= 0) {
				return [];
			}

			if (count <= TAIL_LIMIT) {
				const current = yield* SynchronizedRef.get(state);

				return current.tail.slice(-count);
			}

			const written = yield* lines(0);

			return written.slice(-count);
		});

		const write = (current: WriterState, bytes: Uint8Array) =>
			Effect.gen(function* () {
				let written = 0;

				while (written < bytes.length) {
					const taken = yield* file.write(bytes.subarray(written));

					if (taken === 0) {
						return yield* new LogError({
							message: "append: the disk took nothing",
						});
					}

					written += taken;
				}

				return yield* file.sync;
			}).pipe(
				Effect.catchTag("PlatformError", (cause) =>
					Effect.fail(
						new LogError({ message: `append: ${cause.message}`, cause })
					)
				),
				Effect.tapError(() => file.truncate(current.size).pipe(Effect.ignore))
			);

		const commit = (current: WriterState, batch: ReadonlyArray<Line>) =>
			Effect.gen(function* () {
				for (const [index, line] of batch.entries()) {
					if (line.seq !== current.seq + index + 1) {
						return yield* new LogError({
							message: `append: seq ${line.seq} after seq ${current.seq + index}; nothing written`,
						});
					}
				}

				if (batch.length === 0) {
					return current;
				}

				const info = yield* file.stat.pipe(io("append"));
				const onDisk = Number(info.size);

				if (onDisk !== current.size) {
					return yield* new LogError({
						message: `append: something else wrote ${path} (${onDisk} bytes, not the ${current.size} this host left); nothing written`,
					});
				}

				const encoded = yield* Effect.forEach(
					batch,
					(line) => encodeLine(line),
					{ concurrency: 1 }
				).pipe(
					Effect.mapError(
						(cause) =>
							new LogError({
								message: `append: ${cause.message}; nothing written`,
								cause,
							})
					)
				);

				const bytes = Buffer.from(
					encoded.map((text) => `${text}\n`).join(""),
					"utf-8"
				);

				yield* write(current, bytes);

				return {
					seq: current.seq + batch.length,
					size: current.size + bytes.length,
					tail: [...current.tail, ...batch].slice(-TAIL_LIMIT),
				};
			}).pipe(Effect.uninterruptible);

		const append = Effect.fn("CampaignLog.append")(function* (
			batch: ReadonlyArray<Line>
		) {
			yield* SynchronizedRef.updateEffect(state, (current) =>
				commit(current, batch)
			);
		});

		return { path, lines, recent, append };
	});

const commitInMemory = (
	cap: number,
	current: ReadonlyArray<Line>,
	batch: ReadonlyArray<Line>
) =>
	Effect.gen(function* () {
		const last = current.length;

		for (const [index, line] of batch.entries()) {
			if (line.seq !== last + index + 1) {
				return yield* new LogError({
					message: `append: seq ${line.seq} after seq ${last + index}; nothing written`,
				});
			}
		}

		if (last + batch.length > cap) {
			return yield* new LogError({
				message: `append: this log holds at most ${cap} lines; nothing written`,
			});
		}

		yield* Effect.forEach(batch, (line) => encodeLine(line), {
			concurrency: 1,
			discard: true,
		}).pipe(
			Effect.mapError(
				(cause) =>
					new LogError({
						message: `append: ${cause.message}; nothing written`,
						cause,
					})
			)
		);

		return [...current, ...batch];
	});

const memoryLog = (cap: number) =>
	Effect.gen(function* () {
		const state = yield* SynchronizedRef.make<ReadonlyArray<Line>>([]);

		const lines = Effect.fn("CampaignLog.lines")(function* (after: number) {
			const written = yield* SynchronizedRef.get(state);

			return written.filter((line) => line.seq > after);
		});

		const recent = Effect.fn("CampaignLog.recent")(function* (count: number) {
			if (count <= 0) {
				return [];
			}

			const written = yield* SynchronizedRef.get(state);

			return written.slice(-count);
		});

		const append = Effect.fn("CampaignLog.append")(function* (
			batch: ReadonlyArray<Line>
		) {
			yield* SynchronizedRef.updateEffect(state, (current) =>
				commitInMemory(cap, current, batch)
			);
		});

		const log: CampaignLogService = {
			path: MEMORY_PATH,
			lines,
			recent,
			append,
		};

		return log;
	});

export class CampaignLog extends Context.Service<
	CampaignLog,
	CampaignLogService
>()("@supervillain/platform-jsonl/CampaignLog") {
	static make(
		dir: string
	): Effect.Effect<
		CampaignLogService,
		LogError,
		FileSystem.FileSystem | Path.Path | Scope.Scope
	>;

	static make(memory: MemoryPlace): Effect.Effect<CampaignLogService, LogError>;

	static make(
		place: string | MemoryPlace
	): Effect.Effect<
		CampaignLogService,
		LogError,
		FileSystem.FileSystem | Path.Path | Scope.Scope
	> {
		return Predicate.isString(place) ? diskLog(place) : memoryLog(place.cap);
	}

	static readonly layer = (dir: string) => Layer.effect(this, this.make(dir));

	static readonly layerMemory = (cap: number) =>
		Layer.effect(this, this.make({ cap }));
}
