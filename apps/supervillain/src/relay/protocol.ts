import { createHmac, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

import { Effect, Schema } from "effect";

export const PROTOCOL_VERSION = 2;

export const DEFAULT_PLAYER_PORT = 2222;

export const DEFAULT_GM_PORT = 7022;

export const DEFAULT_RELAY = "supervillain.sh:7022";

export const DEFAULT_RELAY_PLAYER_PORT = 22;

export const RELAYED_ACTOR_ENV = "SV_ACTOR";

export const RELAYED_CLIENT_ENV = "SV_CLIENT";

export const RELAYED_INVITE_ENV = "SV_INVITE";

export const RELAYED_BUCKET_ENV = "SV_BUCKET";

export const RELAY_USERNAME = "relay";

export const HANDLE = /^[a-z][a-z0-9-]{0,23}$/u;

export const TABLE = /^[a-z][a-z0-9-]{0,31}$/u;

export const isHandle = (name: string): boolean => HANDLE.test(name);

export const isTableName = (name: string): boolean => TABLE.test(name);

const SYSTEM_NAMES = [
	"root admin administrator user guest test ubuntu debian fedora centos rocky alma alpine arch",
	"ec2-user azureuser opc pi git nobody daemon www www-data ftp mail oracle postgres mysql",
	"support info operator ansible vagrant docker ubnt",
].flatMap((line) => line.split(" "));

const RELAY_WORDS = [
	..."lobby help watch join relay supervillain new about status".split(" "),
	..."gm host pair claim invite sv www api".split(" "),
];

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
	...SYSTEM_NAMES,
	...RELAY_WORDS,
]);

export const RESERVED_SHORT_TABLES: ReadonlySet<string> = new Set([
	...SYSTEM_NAMES,
	...RELAY_WORDS,
]);

export const isReservedHandle = (name: string): boolean =>
	RESERVED_HANDLES.has(name);

export const isReservedShortTable = (name: string): boolean =>
	RESERVED_SHORT_TABLES.has(name);

export type Address =
	| {
			readonly kind: "table";
			readonly handle: string;
			readonly table: string;
			readonly invite?: string;
	  }
	| { readonly kind: "short"; readonly table: string; readonly invite?: string }
	| { readonly kind: "none"; readonly invite?: string };

const INVITE_TOKEN = /^[a-z0-9_-]{1,64}$/u;

const withInvite = <A extends Address>(address: A, invite: string): A =>
	invite === "" ? address : { ...address, invite };

export const parseAddress = (user: string): Address => {
	const lower = user.trim().toLowerCase();
	const tilde = lower.indexOf("~");
	const name = tilde === -1 ? lower : lower.slice(0, tilde);
	const token = tilde === -1 ? "" : lower.slice(tilde + 1);
	const invite = INVITE_TOKEN.test(token) ? token : "";
	const split = /^(?<handle>[^/.]+)[/.](?<table>[^/.]+)$/u.exec(name)?.groups;

	if (split !== undefined) {
		const { handle = "", table = "" } = split;

		return isHandle(handle) && isTableName(table)
			? withInvite({ kind: "table", handle, table }, invite)
			: withInvite({ kind: "none" }, invite);
	}

	return isTableName(name)
		? withInvite({ kind: "short", table: name }, invite)
		: withInvite({ kind: "none" }, invite);
};

const RELAY_ADDRESS =
	/^(?:\[(?<v6>[0-9A-Fa-f:.]+)\]|(?<name>[^\s:[\]]+))(?::(?<port>\d{1,5}))?$/u;

export const parseRelayAddress = (
	text: string
): { readonly host: string; readonly port: number } | undefined => {
	const groups = RELAY_ADDRESS.exec(text)?.groups;
	const host = groups?.v6 ?? groups?.name;

	if (host === undefined) {
		return undefined;
	}

	const port =
		groups?.port === undefined ? DEFAULT_GM_PORT : Number(groups.port);

	return port < 1 || port > 65_535 ? undefined : { host, port };
};

export const addressText = (handle: string, table: string): string =>
	`${handle}/${table}`;

const HELLO_HEAD = "SUPERVILLAIN ";

const HELLO_PREFIX = `${HELLO_HEAD}${PROTOCOL_VERSION} TABLE `;

export const MAX_LINE_BYTES = 192;

export const LINE_TIMEOUT_MS = 10_000;

export const helloLine = (
	handle: string,
	table: string,
	proof?: string
): string =>
	`${HELLO_PREFIX}${addressText(handle, table)}${proof === undefined ? "" : ` CLAIM ${proof}`}\n`;

const B64URL = (n: number) => new RegExp(`^[A-Za-z0-9_-]{${n}}$`, "u");

const PROOF = B64URL(43);

export const isClaimProof = (text: string): boolean => PROOF.test(text);

export const claimProof = (code: string, fingerprint: string): string =>
	createHmac("sha256", code).update(fingerprint).digest("base64url");

export const provesClaim = (
	code: string,
	fingerprint: string,
	proof: string
): boolean => {
	if (!isClaimProof(proof)) {
		return false;
	}

	return timingSafeEqual(
		Buffer.from(claimProof(code, fingerprint), "base64url"),
		Buffer.from(proof, "base64url")
	);
};

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export const crockford = (bytes: Uint8Array, length: number): string => {
	let bits = 0;
	let value = 0;
	let text = "";

	for (const byte of bytes) {
		if (text.length >= length) {
			break;
		}

		value = value * 256 + byte;
		bits += 8;

		while (bits >= 5 && text.length < length) {
			bits -= 5;
			const unit = 2 ** bits;
			text += CROCKFORD[Math.floor(value / unit)] ?? "0";
			value %= unit;
		}
	}

	return text.padEnd(length, "0");
};

export const PAIRING_PREFIX = "sv-";

export const PAIRING_CHARS = 20;

const PAIRING = new RegExp(
	`^${PAIRING_PREFIX}[${CROCKFORD}]{${PAIRING_CHARS}}$`,
	"u"
);

export const isPairingCode = (code: string): boolean => PAIRING.test(code);

export const OK_LINE = "OK\n";

export const errLine = (reason: string): string =>
	`ERR ${reason.replaceAll(/[\r\n]/gu, " ")}\n`;

export type Hello =
	| {
			readonly ok: true;
			readonly handle: string;
			readonly table: string;
			readonly proof?: string;
	  }
	| { readonly ok: false; readonly reason: string };

export const HANDLE_RULE = "1-24 of a-z, 0-9 and -, starting with a letter";

export const TABLE_RULE = "1-32 of a-z, 0-9 and -, starting with a letter";

const UPGRADE =
	"this relay speaks protocol 2 (handle/table); upgrade supervillain on the GM's machine";

const HELLO_BODY = /^(?<handle>\S+)\/(?<table>\S+)(?: CLAIM (?<proof>\S+))?$/u;

export const parseHello = (line: string): Hello => {
	if (!line.startsWith(HELLO_HEAD)) {
		return { ok: false, reason: "not a supervillain host" };
	}

	if (line.startsWith(`${HELLO_HEAD}1 `)) {
		return { ok: false, reason: UPGRADE };
	}

	if (!line.startsWith(HELLO_PREFIX)) {
		return { ok: false, reason: "unsupported protocol version" };
	}

	const body = HELLO_BODY.exec(line.slice(HELLO_PREFIX.length))?.groups;

	if (body === undefined) {
		return { ok: false, reason: "a hello names <handle>/<table>" };
	}

	const { handle = "", table = "", proof } = body;

	if (!isHandle(handle)) {
		return { ok: false, reason: `bad handle (${HANDLE_RULE})` };
	}

	if (isReservedHandle(handle)) {
		return {
			ok: false,
			reason: `the handle ${handle} is reserved: pick another`,
		};
	}

	if (!isTableName(table)) {
		return { ok: false, reason: `bad table name (${TABLE_RULE})` };
	}

	if (proof !== undefined && !isClaimProof(proof)) {
		return {
			ok: false,
			reason:
				"a claim is proven with a key-bound HMAC of its code, never the code itself; upgrade supervillain on the GM's machine",
		};
	}

	return proof === undefined
		? { ok: true, handle, table }
		: { ok: true, handle, table, proof };
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

export const closedTableMessage = (address: string): string =>
	`${address} isn't open right now.`;

export const JOIN_HINT =
	"To join a table, put its name before the @ (ssh <handle>/<table>@…). Your GM has it.";

export const KNOWS_SUBSYSTEM = "knows-1@supervillain.sh";

export const MCP_SUBSYSTEM = "mcp-1@supervillain.sh";

export const MAX_KNOWS_ANSWER_BYTES = 16;

export const KNOWS_NONCE_BYTES = 16;

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
