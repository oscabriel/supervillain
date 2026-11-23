import { Readable } from "node:stream";

import { Predicate } from "effect";
import type { PseudoTtyInfo, ServerChannel } from "ssh2";

export interface Pty {
	readonly term: string;
	readonly cols: number;
	readonly rows: number;
}

export const TERMINAL_RESET =
	"\u001B[0m\u001B[?1049l\u001B[?25h\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?1004l\u001B[?2004l\u001B[<u\u001B[>4;0m";

const DEFAULT_PTY: Pty = { term: "xterm-256color", cols: 80, rows: 24 };

const MAX_SIZE = { cols: 300, rows: 100 };

const ENV_KEYS = new Set(["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);

const VALUE_BYTES_MAX = 256;

const isControl = (code: number) =>
	code < 0x20 || (code >= 0x7f && code <= 0x9f);

const hasControl = (value: string) => {
	for (const char of value) {
		if (isControl(char.codePointAt(0) ?? 0)) {
			return true;
		}
	}

	return false;
};

const isCleanValue = (value: string) =>
	!hasControl(value) && Buffer.byteLength(value) <= VALUE_BYTES_MAX;

const dimension = (value: number, fallback: number, max: number) =>
	Number.isFinite(value) && Math.floor(value) > 0
		? Math.min(Math.floor(value), max)
		: fallback;

export const sanitizeSize = (
	cols: number,
	rows: number,
	previous: Pty = DEFAULT_PTY
) => ({
	cols: dimension(cols, previous.cols, MAX_SIZE.cols),
	rows: dimension(rows, previous.rows, MAX_SIZE.rows),
});

export const sanitizePty = (
	info: (PseudoTtyInfo & { term?: string }) | undefined
): Pty => {
	if (!info) {
		return DEFAULT_PTY;
	}

	const term =
		info.term && isCleanValue(info.term) ? info.term : DEFAULT_PTY.term;

	return { term, ...sanitizeSize(info.cols, info.rows) };
};

export const takeEnv = (
	env: Record<string, string>,
	key: string,
	value: string
): boolean => {
	if (!ENV_KEYS.has(key) || !isCleanValue(value)) {
		return false;
	}

	env[key] = value;

	return true;
};

export interface RendererStreams {
	readonly stdin: NodeJS.ReadStream;
	readonly stdout: NodeJS.WriteStream;
	readonly detach: () => void;
}

const isTerminalIn = (stream: Readable): stream is NodeJS.ReadStream =>
	Predicate.isBoolean(stream.readable);

const isTerminalOut = (
	stream: ServerChannel & { columns: number; rows: number }
): stream is ServerChannel & NodeJS.WriteStream =>
	Predicate.isBoolean(stream.writable) &&
	Predicate.isNumber(stream.columns) &&
	Predicate.isNumber(stream.rows);

export const rendererStreams = (
	channel: ServerChannel,
	cols: number,
	rows: number
): RendererStreams | undefined => {
	let paused = false;

	const stdin = new Readable({
		read() {
			if (!paused) {
				return;
			}

			paused = false;
			channel.resume();
		},
	});

	const onData = (chunk: Buffer) => {
		if (!stdin.push(chunk) && !paused) {
			paused = true;
			channel.pause();
		}
	};

	const stdout = Object.assign(channel, { columns: cols, rows });

	if (!isTerminalIn(stdin) || !isTerminalOut(stdout)) {
		return undefined;
	}

	channel.on("data", onData);

	return {
		stdin,
		stdout,
		detach: () => {
			channel.removeListener("data", onData);
			stdin.destroy();
			queueMicrotask(() => {
				channel.resume();
			});
		},
	};
};
