import {
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	Predicate,
	Schema,
	SynchronizedRef,
} from "effect";
import type { PlatformError } from "effect";

import { LineJson } from "./envelope.ts";
import type { Line } from "./envelope.ts";
import { parseLog } from "./parseLog.ts";

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

const io =
	(what: string) =>
	<A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
		Effect.mapError(
			effect,
			(cause) => new LogError({ message: `${what}: ${cause.message}`, cause })
		);

const byteLength = (text: string) => Buffer.byteLength(text, "utf-8");

const utf8Exact = new TextDecoder("utf-8", { ignoreBOM: true });

const readExactText = (fs: FileSystem.FileSystem, path: string) =>
	fs.readFile(path).pipe(Effect.map((bytes) => utf8Exact.decode(bytes)));

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
			Effect.map((text) => Number(text.trim())),
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.succeed(Number.NaN)
			)
		);
	});

const takeLock = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const now = yield* Clock.currentTimeMillis;
		const temporary = `${path}.${process.pid}.${now}.tmp`;
		const aside = `${temporary}.stale`;

		const linked = fs.link(temporary, path).pipe(
			Effect.as(true),
			Effect.catchReason("PlatformError", "AlreadyExists", () =>
				Effect.succeed(false)
			)
		);

		const moveAside = Effect.gen(function* () {
			const moved = yield* fs.rename(path, aside).pipe(
				Effect.as(true),
				Effect.catchReason("PlatformError", "NotFound", () =>
					Effect.succeed(false)
				)
			);

			if (moved && live(yield* lockOwner(aside))) {
				yield* fs
					.link(aside, path)
					.pipe(
						Effect.catchReason(
							"PlatformError",
							"AlreadyExists",
							() => Effect.void
						)
					);
			}

			if (moved) {
				yield* fs.remove(aside);
			}
		});

		const takeOver = Effect.gen(function* () {
			const owner = yield* lockOwner(path);

			if (live(owner)) {
				return yield* new LogError({
					message: `lock campaign: another host (pid ${owner}) has this campaign open; if no host has it open, delete ${path} and start again`,
				});
			}

			return yield* moveAside;
		});

		const acquire = Effect.gen(function* () {
			while (!(yield* linked)) {
				yield* takeOver;
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

		if (owner === process.pid) {
			yield* fs.remove(path);
		}
	}).pipe(Effect.ignore);

const encodeLine = Schema.encodeEffect(LineJson);

export class CampaignLog extends Context.Service<
	CampaignLog,
	{
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
>()("@supervillain/platform-jsonl/CampaignLog") {
	static readonly make = (dir: string) =>
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

			const parsed = parseLog(
				yield* readExactText(fs, path).pipe(io("read log"))
			);

			if (parsed.torn !== undefined) {
				yield* file
					.truncate(byteLength(parsed.intact))
					.pipe(io("cut half-written line"));
				yield* Effect.logWarning(
					`Cut a half-written last line from ${path}: ${escapeForLog(parsed.torn.slice(0, 80))}`
				);
			}

			if (parsed.error !== undefined) {
				return yield* new LogError({
					message: `${path}:${parsed.error.line}: ${parsed.error.message}`,
				});
			}

			const state = yield* SynchronizedRef.make<WriterState>({
				seq: parsed.lines.length,
				size: byteLength(parsed.intact),
				tail: parsed.lines.slice(-TAIL_LIMIT),
			});

			const readWritten = (written: WriterState) =>
				Effect.gen(function* () {
					const reread = parseLog(
						yield* readExactText(fs, path).pipe(io("read log"))
					);

					if (reread.error !== undefined) {
						return yield* new LogError({
							message: `${path}:${reread.error.line}: ${reread.error.message}`,
						});
					}

					return reread.lines.slice(0, written.seq);
				});

			const lines = Effect.fn("CampaignLog.lines")(function* (after: number) {
				const written = yield* SynchronizedRef.modifyEffect(state, (current) =>
					Effect.map(readWritten(current), (read) => [read, current] as const)
				);

				return written.filter((line) => line.seq > after);
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

	static readonly layer = (dir: string) => Layer.effect(this, this.make(dir));
}
