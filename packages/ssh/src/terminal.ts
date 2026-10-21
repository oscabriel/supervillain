import { Readable } from "node:stream";
import type { PseudoTtyInfo, ServerChannel } from "ssh2";

/** The terminal a client asked for, cleaned up. */
export interface Pty {
  readonly term: string;
  readonly cols: number;
  readonly rows: number;
}

const DEFAULT_PTY: Pty = { term: "xterm-256color", cols: 80, rows: 24 };
/** A renderer's memory and every frame's cost grow with its size, so a client can't ask for more. */
const MAX_SIZE = { cols: 300, rows: 100 };
/** Client env keys that describe its terminal. Everything else a client sends is refused. */
const ENV_KEYS = new Set(["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);
const VALUE_BYTES_MAX = 256;
/** C0 and C1 control characters, DEL included. */
const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

const isCleanValue = (value: string) =>
  ![...value].some((char) => isControl(char.codePointAt(0)!)) &&
  Buffer.byteLength(value) <= VALUE_BYTES_MAX;

const dimension = (value: number, fallback: number, max: number) =>
  Number.isFinite(value) && Math.floor(value) > 0 ? Math.min(Math.floor(value), max) : fallback;

/** Clamps a size to 1..300 × 1..100; a missing or bad axis keeps the old value. */
export const sanitizeSize = (cols: number, rows: number, previous: Pty = DEFAULT_PTY) => ({
  cols: dimension(cols, previous.cols, MAX_SIZE.cols),
  rows: dimension(rows, previous.rows, MAX_SIZE.rows),
});

/** A pty request, or the defaults (xterm-256color, 80×24) where it is missing or odd. */
export const sanitizePty = (info: (PseudoTtyInfo & { term?: string }) | undefined): Pty => {
  if (!info) return DEFAULT_PTY;
  const term = info.term && isCleanValue(info.term) ? info.term : DEFAULT_PTY.term;
  return { term, ...sanitizeSize(info.cols, info.rows) };
};

/** Records an allow-listed env request with a clean value. Returns whether it was taken. */
export const takeEnv = (env: Record<string, string>, key: string, value: string): boolean => {
  if (!ENV_KEYS.has(key) || !isCleanValue(value)) return false;
  env[key] = value;
  return true;
};

/**
 * The stream pair a renderer draws through: stdin is a Readable fed from the channel, with
 * backpressure; stdout is the channel itself, carrying the terminal size.
 * Adapted from @opentui/ssh 0.6.6, MIT.
 */
export function rendererStreams(channel: ServerChannel, cols: number, rows: number) {
  let paused = false;
  const stdin = new Readable({
    read() {
      if (!paused) return;
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
  channel.on("data", onData);
  const stdout = channel as unknown as NodeJS.WriteStream;
  stdout.columns = cols;
  stdout.rows = rows;
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    detach: () => {
      channel.removeListener("data", onData);
      stdin.destroy();
      // ssh2 holds a channel's close until its input is read, so drain what the renderer left.
      queueMicrotask(() => channel.resume());
    },
  };
}
