import type { Readable } from "node:stream";

import { Effect } from "effect";

import { flushEscape } from "./keys.ts";
import type { NavRules, NavState } from "./keys.ts";

const ESCAPE_FLUSH_MS = 50;

export interface KeyPick<Result> {
	readonly result: Result;
	readonly rest: number | undefined;
}

export interface IdleLimit<Result> {
	readonly ms: number;
	readonly result: Result;
}

export interface KeyReading<State extends NavState, Result> {
	readonly stream: Readable;
	readonly state: State;
	readonly rules: NavRules<State>;
	readonly keyed: (
		chunk: Buffer,
		at: number,
		byte: number
	) => KeyPick<Result> | undefined;
	readonly ended: Result;
	readonly idle: IdleLimit<Result> | undefined;
	readonly draw: () => void;
	readonly redraw: (again: (() => void) | undefined) => void;
}

export const readKeys = <State extends NavState, Result>(
	reading: KeyReading<State, Result>
): Effect.Effect<Result> =>
	Effect.callback((resume) => {
		const { stream, state, rules, idle } = reading;
		let escTimer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;

		const stop = () => {
			clearTimeout(idleTimer);
			clearTimeout(escTimer);
			reading.redraw(undefined);
			stream.removeListener("data", onData);
			stream.removeListener("end", onEnd);
		};

		const attempt = (run: () => void) => {
			try {
				run();
			} catch (error) {
				stop();
				resume(Effect.die(error));
			}
		};

		const finish = (result: Result, rest?: Buffer) => {
			stop();
			stream.pause();

			if (rest !== undefined && rest.length > 0) {
				stream.unshift(rest);
			}

			resume(Effect.succeed(result));
		};

		const show = () => {
			attempt(reading.draw);
		};

		const armIdle = () => {
			clearTimeout(idleTimer);

			if (idle !== undefined) {
				idleTimer = setTimeout(() => {
					finish(idle.result);
				}, idle.ms);
			}
		};

		const flush = () => {
			attempt(() => {
				if (flushEscape(rules, state)) {
					reading.draw();
				}
			});
		};

		const read = (chunk: Buffer) => {
			for (const [at, byte] of chunk.entries()) {
				const pick = reading.keyed(chunk, at, byte);

				if (pick !== undefined) {
					finish(
						pick.result,
						pick.rest === undefined ? undefined : chunk.subarray(pick.rest)
					);

					return;
				}
			}

			if (state.escape === "esc") {
				escTimer = setTimeout(flush, ESCAPE_FLUSH_MS);
			}

			reading.draw();
		};

		const onData = (chunk: Buffer) => {
			clearTimeout(escTimer);
			armIdle();
			attempt(() => {
				read(chunk);
			});
		};

		const onEnd = () => {
			finish(reading.ended);
		};

		attempt(() => {
			armIdle();
			reading.draw();
			reading.redraw(show);
			stream.on("data", onData);
			stream.once("end", onEnd);
			stream.resume();
		});

		return Effect.sync(stop);
	});
