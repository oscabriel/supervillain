import type { Duplex, Writable } from "node:stream";

import { BunSink, BunStream } from "@effect/platform-bun";
import { Effect, PlatformError, Sink, Stdio } from "effect";

const STREAM_FAILED = "the agent's stream failed";

export const duplexStdio = (stream: Duplex, stderr?: Writable): Stdio.Stdio =>
	Stdio.make({
		args: Effect.succeed([]),
		stdin: BunStream.fromReadable({
			evaluate: () => stream,
			onError: (cause) =>
				PlatformError.badArgument({
					module: "Stdio",
					method: "stdin",
					description: STREAM_FAILED,
					cause,
				}),
			closeOnDone: false,
		}),
		stdout: () =>
			BunSink.fromWritable({
				evaluate: () => stream,
				onError: (cause) =>
					PlatformError.badArgument({
						module: "Stdio",
						method: "stdout",
						description: STREAM_FAILED,
						cause,
					}),
				endOnDone: false,
			}),
		stderr: () =>
			stderr === undefined
				? Sink.drain
				: BunSink.fromWritable({
						evaluate: () => stderr,
						onError: (cause) =>
							PlatformError.badArgument({
								module: "Stdio",
								method: "stderr",
								description: STREAM_FAILED,
								cause,
							}),
						endOnDone: false,
					}),
	});
