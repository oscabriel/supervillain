// The relay protocol, both ends. A GM's host dials the relay's GM port and says one line; the relay
// answers one line; then SSH runs over the same socket with the GM as the SSH server and the relay
// as the SSH client. No trust comes from the lines: the relay pins each room's GM host key
// (rooms.json, first link claims), and the GM pins the relay's client key (--relay-key or
// <campaign>/relay_known, first link stores).
import type { Socket } from "node:net";

const PROTOCOL_VERSION = 1;

/** Where players connect: `ssh -p 2222 <room>@<relay>`. */
export const DEFAULT_PLAYER_PORT = 2222;
/** Where GMs' hosts dial in. */
export const DEFAULT_GM_PORT = 7022;

/** The env variable a relay sets on each channel to name the player it seats. */
export const RELAYED_ACTOR_ENV = "SV_ACTOR";

/** The env variable a relay sets on each channel to name the software the player connected with. */
export const RELAYED_CLIENT_ENV = "SV_CLIENT";

/** The ssh username the relay logs in to a GM's host with. Its key, not this, is what's trusted. */
export const RELAY_USERNAME = "relay";

/** A room's name: 1-32 of `a-z`, `0-9` and `-`, starting with a letter. */
const ROOM_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const isRoomName = (name: string): boolean => ROOM_NAME.test(name);

/**
 * Names no room may take. A bare `ssh relay` logs in as the local user, and scanners try the usual
 * accounts, so a GM holding one of these would seat strangers who never meant to join a table.
 * The service words are kept for the relay's own use.
 */
const RESERVED_ROOMS = new Set(
  [
    // Accounts ssh clients, cloud images and scanners log in as.
    "root admin administrator user guest test ubuntu debian fedora centos rocky alma alpine arch",
    "ec2-user azureuser opc pi git nobody daemon www www-data ftp mail oracle postgres mysql",
    "support info operator ansible vagrant docker ubnt",
    // Words the relay may answer itself one day.
    "lobby help watch join relay supervillain new about status",
  ].flatMap((line) => line.split(" ")),
);

/** Whether `name` is one no room may take: see `RESERVED_ROOMS`. */
export const isReservedRoom = (name: string): boolean => RESERVED_ROOMS.has(name);

const HELLO_PREFIX = `SUPERVILLAIN ${PROTOCOL_VERSION} ROOM `;

/**
 * The longest line either end reads, newline included. The hello is at most 20 + 32 + 1 bytes;
 * an answer's reason is short. A peer that sends more without a newline is cut.
 */
export const MAX_LINE_BYTES = 128;

/** How long either end waits for the other's line before giving up on the link. */
export const LINE_TIMEOUT_MS = 10_000;

/** The GM's first line: `SUPERVILLAIN 1 ROOM <room>\n`. */
export const helloLine = (room: string): string => `${HELLO_PREFIX}${room}\n`;

/** The relay's answer when it takes the link. SSH follows on the same socket. */
export const OK_LINE = "OK\n";

/** The relay's answer when it won't; it closes the socket after. */
export const errLine = (reason: string): string => `ERR ${reason.replace(/[\r\n]/g, " ")}\n`;

export type Hello =
  | { readonly ok: true; readonly room: string }
  | { readonly ok: false; readonly reason: string };

/** Parses the GM's line, without its `\n`. Strict: no `\r`, no extra spaces, one version. */
export const parseHello = (line: string): Hello => {
  if (!line.startsWith("SUPERVILLAIN ")) return { ok: false, reason: "not a supervillain host" };
  if (!line.startsWith(HELLO_PREFIX)) return { ok: false, reason: "unsupported protocol version" };
  const room = line.slice(HELLO_PREFIX.length);
  if (!isRoomName(room))
    return { ok: false, reason: "bad room name (1-32 of a-z, 0-9 and -, starting with a letter)" };
  if (isReservedRoom(room))
    return { ok: false, reason: `room name ${room} is reserved: pick another` };
  return { ok: true, room };
};

export type Answer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Parses the relay's line, without its `\n`. */
export const parseAnswer = (line: string): Answer => {
  if (line === "OK") return { ok: true };
  if (line.startsWith("ERR ")) return { ok: false, reason: line.slice(4) };
  return { ok: false, reason: `unexpected answer ${JSON.stringify(line.slice(0, 64))}` };
};

/** What a player hears for a room that exists but has no GM linked. */
export const closedRoomMessage = (room: string): string =>
  `The table ${room} isn't open right now.`;

/** What a player hears for a username that can't name a room, such as the one a bare `ssh` sends. */
export const JOIN_HINT =
  "To join a table, put its room's name before the @ (ssh <room>@…). Your GM has it.";

/** What a seated player hears when the GM's link drops. */
export const TABLE_CLOSED_MESSAGE = "The table closed.";

export class LineError extends Error {}

/**
 * Reads one `\n`-terminated line from a socket and leaves the socket paused, with any bytes after
 * the line pushed back, so the SSH that follows reads from the very next byte. ssh2 resumes the
 * socket itself once its reader is attached; resuming it here would lose bytes.
 * Fails on a line longer than `MAX_LINE_BYTES`, a timeout, or the socket ending first.
 */
export const readLine = (socket: Socket, timeoutMs: number = LINE_TIMEOUT_MS): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let buffered: Buffer = Buffer.alloc(0);
    const done = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onEnd);
      socket.removeListener("error", onError);
      socket.pause();
    };
    const fail = (message: string) => {
      done();
      reject(new LineError(message));
    };
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length >= MAX_LINE_BYTES) fail("line too long");
        return;
      }
      if (newline + 1 > MAX_LINE_BYTES) return fail("line too long");
      done();
      const rest = buffered.subarray(newline + 1);
      if (rest.length > 0) socket.unshift(rest);
      resolve(buffered.subarray(0, newline).toString("utf8"));
    };
    const onEnd = () => fail("the link closed before its first line");
    const onError = (e: Error) => fail(e.message);
    const timer = setTimeout(() => fail("no line in time"), timeoutMs);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", onError);
  });
