import { createHmac, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

import { Effect, Schema } from "effect";

const PROTOCOL_VERSION = 1;

export const DEFAULT_PLAYER_PORT = 2222;

export const DEFAULT_GM_PORT = 7022;

export const RELAYED_ACTOR_ENV = "SV_ACTOR";

export const RELAYED_CLIENT_ENV = "SV_CLIENT";

export const RELAY_USERNAME = "relay";

const ROOM_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

export const isRoomName = (name: string): boolean => ROOM_NAME.test(name);

const RESERVED_ROOMS = new Set(
	[
		"root admin administrator user guest test ubuntu debian fedora centos rocky alma alpine arch",
		"ec2-user azureuser opc pi git nobody daemon www www-data ftp mail oracle postgres mysql",
		"support info operator ansible vagrant docker ubnt",
		"lobby help watch join relay supervillain new about status",
	].flatMap((line) => line.split(" "))
);

export const isReservedRoom = (name: string): boolean =>
	RESERVED_ROOMS.has(name);

const HELLO_PREFIX = `SUPERVILLAIN ${PROTOCOL_VERSION} ROOM `;

export const MAX_LINE_BYTES = 128;

export const LINE_TIMEOUT_MS = 10_000;

export const helloLine = (room: string): string => `${HELLO_PREFIX}${room}\n`;

export const OK_LINE = "OK\n";

export const errLine = (reason: string): string =>
	`ERR ${reason.replaceAll(/[\r\n]/gu, " ")}\n`;

export type Hello =
	| { readonly ok: true; readonly room: string }
	| { readonly ok: false; readonly reason: string };

export const parseHello = (line: string): Hello => {
	if (!line.startsWith("SUPERVILLAIN ")) {
		return { ok: false, reason: "not a supervillain host" };
	}

	if (!line.startsWith(HELLO_PREFIX)) {
		return { ok: false, reason: "unsupported protocol version" };
	}

	const room = line.slice(HELLO_PREFIX.length);

	if (!isRoomName(room)) {
		return {
			ok: false,
			reason: "bad room name (1-32 of a-z, 0-9 and -, starting with a letter)",
		};
	}

	if (isReservedRoom(room)) {
		return { ok: false, reason: `room name ${room} is reserved: pick another` };
	}

	return { ok: true, room };
};

export type Answer =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

export const parseAnswer = (line: string): Answer => {
	if (line === "OK") {
		return { ok: true };
	}

	if (line.startsWith("ERR ")) {
		return { ok: false, reason: line.slice(4) };
	}

	return {
		ok: false,
		reason: `unexpected answer ${JSON.stringify(line.slice(0, 64))}`,
	};
};

export const closedRoomMessage = (room: string): string =>
	`The table ${room} isn't open right now.`;

export const JOIN_HINT =
	"To join a table, put its room's name before the @ (ssh <room>@…). Your GM has it.";

export const KNOWS_SUBSYSTEM = "knows-1@supervillain.sh";

export const MAX_KNOWS_ANSWER_BYTES = 16;

export const KNOWS_NONCE_BYTES = 16;

const B64URL = (n: number) => new RegExp(`^[A-Za-z0-9_-]{${n}}$`, "u");

const NONCE = B64URL(22);

const MAC = B64URL(43);

const macOf = (nonce: Buffer, actor: string) =>
	createHmac("sha256", nonce).update(actor).digest("base64url");

export interface KnowsQuery {
	readonly nonce: string;
	readonly mac: string;
}

export const knowsQueryLine = (actor: string, nonce: Uint8Array): string => {
	if (nonce.length !== KNOWS_NONCE_BYTES) {
		throw new Error(`a nonce is ${KNOWS_NONCE_BYTES} bytes`);
	}

	const bytes = Buffer.from(nonce);

	return `${bytes.toString("base64url")} ${macOf(bytes, actor)}\n`;
};

export const parseKnowsQuery = (line: string): KnowsQuery | undefined => {
	const [nonce, mac, ...rest] = line.split(" ");

	if (rest.length > 0 || nonce === undefined || mac === undefined) {
		return undefined;
	}

	return NONCE.test(nonce) && MAC.test(mac) ? { nonce, mac } : undefined;
};

export const knownActor = (
	query: KnowsQuery,
	actors: Iterable<string>
): string | undefined => {
	const nonce = Buffer.from(query.nonce, "base64url");
	const asked = Buffer.from(query.mac, "base64url");

	for (const actor of actors) {
		if (!actor.startsWith("key:")) {
			continue;
		}

		if (timingSafeEqual(Buffer.from(macOf(nonce, actor), "base64url"), asked)) {
			return actor;
		}
	}

	return undefined;
};

export type KnowsAnswer =
	| { readonly known: false }
	| { readonly known: true; readonly seated: number };

export const knowsAnswerLine = (answer: KnowsAnswer): string =>
	answer.known
		? `yes ${Math.max(0, Math.min(9999, Math.floor(answer.seated)))}\n`
		: "no\n";

export const parseKnowsAnswer = (text: string): KnowsAnswer => {
	const seated = /^yes (?<seated>\d{1,4})\n?$/u.exec(text)?.groups?.seated;

	return seated === undefined
		? { known: false }
		: { known: true, seated: Number(seated) };
};

export const TABLE_CLOSED_MESSAGE = "The table closed.";

export class LineError extends Schema.TaggedError<LineError>()("LineError", {
	message: Schema.String,
}) {}

export const readLine = (
	socket: Duplex,
	timeoutMs: number = LINE_TIMEOUT_MS
): Effect.Effect<string, LineError> =>
	Effect.callback((resume) => {
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
			resume(Effect.fail(new LineError({ message })));
		};

		const onData = (chunk: Buffer) => {
			buffered =
				buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
			const newline = buffered.indexOf(0x0a);

			if (newline === -1) {
				if (buffered.length >= MAX_LINE_BYTES) {
					fail("line too long");
				}

				return;
			}

			if (newline + 1 > MAX_LINE_BYTES) {
				fail("line too long");

				return;
			}

			done();
			const rest = buffered.subarray(newline + 1);

			if (rest.length > 0) {
				socket.unshift(rest);
			}

			resume(Effect.succeed(buffered.subarray(0, newline).toString("utf-8")));
		};

		const onEnd = () => {
			fail("the link closed before its first line");
		};

		const onError = (cause: Error) => {
			fail(cause.message);
		};

		const timer = setTimeout(() => {
			fail("no line in time");
		}, timeoutMs);

		socket.on("data", onData);
		socket.once("end", onEnd);
		socket.once("close", onEnd);
		socket.once("error", onError);

		return Effect.sync(done);
	});
