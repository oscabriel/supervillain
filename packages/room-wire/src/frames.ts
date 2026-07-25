/**
 * The frame protocol: a versioned wire contract for the one pipe a Host dials
 * out to its gateway (ADR-0012, NQ-5). Every frame is tagged (room, channel),
 * so all Rooms and all logical channels multiplex over one connection, and a
 * large message chunks into bounded frames rather than one giant write.
 *
 * The contract never assumes process-locality: a frame carries everything a
 * reader needs — room, channel, stream, and whether more is coming — so nothing
 * here depends on the two ends sharing a process, a machine, or a replica.
 *
 * A frame is a JSON header line, a newline, then the raw payload bytes. Keeping
 * the payload raw means chunk bounds are byte bounds, and no base64 tax is paid
 * on the hot path.
 */
import { isRecord } from "@supervillain/core";

/** The wire version. Bumping it is a breaking change to the contract above:
 * the handshake refuses an unknown version outright, never downgrades. */
export const PIPE_PROTOCOL_VERSION = 1;

/** Versions this build can speak, newest first. */
export const SUPPORTED_PIPE_PROTOCOL_VERSIONS: readonly number[] = [
	PIPE_PROTOCOL_VERSION,
];

/** The chunk bound. A message longer than this travels as several frames. */
export const MAX_FRAME_PAYLOAD_BYTES = 32 * 1024;

/**
 * The logical channels. `register`, `info`, `submit`, and `stream` carry a
 * Room; `link` is ADR-0005's linking conduit and is the one channel both ends
 * open — the gateway asks a freshly registered room for its actor roster, and a
 * CLI running `key link` opens it on a pipe that carries no rooms at all.
 */
export type PipeChannel = "info" | "link" | "register" | "stream" | "submit";

const CHANNELS: ReadonlySet<string> = new Set([
	"info",
	"link",
	"register",
	"stream",
	"submit",
]);

export const isPipeChannel = (value: unknown): value is PipeChannel =>
	typeof value === "string" && CHANNELS.has(value);

/**
 * `part` — a chunk with more to come; `last` — the chunk that completes a
 * message; `close` — the stream is finished; `error` — the stream failed, and
 * the payload is a metadata-only reason (never game content).
 */
export type FrameKind = "close" | "error" | "last" | "part";

const FRAME_KINDS: ReadonlySet<string> = new Set([
	"close",
	"error",
	"last",
	"part",
]);

export interface PipeFrame {
	/** The Room this frame belongs to — the routing tag. */
	readonly room: string;
	readonly channel: PipeChannel;
	/** The logical exchange within (room, channel); odd ids belong to the
	 * dialing side, even ids to the accepting side, so neither can collide. */
	readonly stream: number;
	readonly kind: FrameKind;
	readonly payload: Uint8Array;
}

/** Liveness only: the heartbeat that makes a dead pipe a detected fact. */
export type PipeControlKind = "ping" | "pong";

export interface PipeControlFrame {
	readonly control: PipeControlKind;
}

export type DecodedFrame = PipeControlFrame | PipeFrame;

/** A frame the contract cannot read. Ends the pipe; never a silent skip. */
export class PipeProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PipeProtocolError";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NEWLINE = 0x0a;
const EMPTY = new Uint8Array(0);

export const isControlFrame = (
	frame: DecodedFrame
): frame is PipeControlFrame => "control" in frame;

const withHeader = (header: string, payload: Uint8Array): Uint8Array => {
	const head = encoder.encode(`${header}\n`);
	const message = new Uint8Array(head.byteLength + payload.byteLength);
	message.set(head);
	message.set(payload, head.byteLength);
	return message;
};

export const encodeFrame = (frame: PipeFrame): Uint8Array =>
	withHeader(
		JSON.stringify({
			c: frame.channel,
			k: frame.kind,
			r: frame.room,
			s: frame.stream,
		}),
		frame.payload
	);

export const encodeControlFrame = (control: PipeControlKind): Uint8Array =>
	withHeader(JSON.stringify({ k: control }), EMPTY);

type FrameHeader = Omit<PipeFrame, "payload">;

const parseHeader = (value: unknown): FrameHeader => {
	if (
		!isRecord(value) ||
		typeof value.r !== "string" ||
		!isPipeChannel(value.c) ||
		typeof value.s !== "number" ||
		!Number.isSafeInteger(value.s) ||
		value.s < 1 ||
		typeof value.k !== "string" ||
		!FRAME_KINDS.has(value.k)
	) {
		throw new PipeProtocolError("Pipe frame header is invalid.");
	}
	return {
		channel: value.c,
		kind: value.k as FrameKind,
		room: value.r,
		stream: value.s,
	};
};

export const decodeFrame = (message: Uint8Array): DecodedFrame => {
	const split = message.indexOf(NEWLINE);
	if (split === -1) {
		throw new PipeProtocolError("Pipe frame has no header.");
	}
	let header: unknown;
	try {
		header = JSON.parse(decoder.decode(message.subarray(0, split)));
	} catch {
		throw new PipeProtocolError("Pipe frame header is not JSON.");
	}
	if (isRecord(header) && (header.k === "ping" || header.k === "pong")) {
		return { control: header.k };
	}
	const parsed = parseHeader(header);
	return { ...parsed, payload: message.subarray(split + 1) };
};

/** Splits one message into bounded chunks, never returning an empty list —
 * a zero-length message is one zero-length chunk, which still says "here". */
export const chunkPayload = (
	payload: Uint8Array,
	maxBytes: number = MAX_FRAME_PAYLOAD_BYTES
): readonly Uint8Array[] => {
	if (payload.byteLength <= maxBytes) {
		return [payload];
	}
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < payload.byteLength; offset += maxBytes) {
		chunks.push(payload.subarray(offset, offset + maxBytes));
	}
	return chunks;
};

// --- the handshake: two plain JSON messages before any frame flows ---

export interface PipeHello {
	readonly versions: readonly number[];
}

export type PipeHandshakeOutcome =
	| { readonly accepted: true; readonly version: number }
	| { readonly rejected: true; readonly message: string };

export const encodePipeHello = (hello: PipeHello): Uint8Array =>
	encoder.encode(JSON.stringify({ versions: [...hello.versions] }));

export const parsePipeHello = (message: Uint8Array): PipeHello => {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(message));
	} catch {
		throw new PipeProtocolError("Pipe hello is not JSON.");
	}
	if (
		!isRecord(value) ||
		!Array.isArray(value.versions) ||
		value.versions.some((one) => typeof one !== "number")
	) {
		throw new PipeProtocolError("Pipe hello is invalid.");
	}
	return { versions: value.versions as readonly number[] };
};

export const encodePipeHandshakeOutcome = (
	outcome: PipeHandshakeOutcome
): Uint8Array => encoder.encode(JSON.stringify(outcome));

export const parsePipeHandshakeOutcome = (
	message: Uint8Array
): PipeHandshakeOutcome => {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(message));
	} catch {
		throw new PipeProtocolError("Pipe handshake outcome is not JSON.");
	}
	if (isRecord(value)) {
		if (value.accepted === true && typeof value.version === "number") {
			return { accepted: true, version: value.version };
		}
		if (value.rejected === true && typeof value.message === "string") {
			return { message: value.message, rejected: true };
		}
	}
	throw new PipeProtocolError("Pipe handshake outcome is invalid.");
};

/** The highest version both ends speak, or undefined when there is none —
 * which the accepting side must answer with a refusal, never a downgrade. */
export const negotiatePipeVersion = (
	offered: readonly number[]
): number | undefined => {
	const shared = SUPPORTED_PIPE_PROTOCOL_VERSIONS.filter((one) =>
		offered.includes(one)
	);
	return shared.length === 0 ? undefined : Math.max(...shared);
};

export const UNSUPPORTED_VERSION_MESSAGE =
	"This gateway speaks no version of the pipe protocol this Host offered.";
