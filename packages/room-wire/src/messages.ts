/**
 * The message layer: what a room-wire exchange says, independent of how it
 * travels. Both the direct RoomStore protocol and the Host pipe's frames carry
 * these same JSON shapes, so the parsers live here rather than in either.
 */
import { isRecord } from "@supervillain/core";
import type {
	Envelope,
	NamespacedType,
	RoomCommand,
	RoomSubmission,
} from "@supervillain/core";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encodeJson = (value: unknown): Uint8Array =>
	encoder.encode(JSON.stringify(value));

export const decodeJson = (message: Uint8Array): unknown =>
	JSON.parse(decoder.decode(message)) as unknown;

export interface RoomInfo {
	readonly gameId: string;
	readonly label: string;
}

export const parseRoomCommand = (value: unknown): RoomCommand => {
	if (
		!isRecord(value) ||
		typeof value.actor !== "string" ||
		!("command" in value)
	) {
		throw new TypeError("RoomStore command is invalid.");
	}
	return { actor: value.actor, command: value.command };
};

/**
 * One submitted command plus the id that makes it idempotent (ADR-0012, NQ-6).
 * The id is optional on the wire: the direct RoomStore protocol predates it and
 * a sender that mints none simply gets no dedupe.
 */
export interface SubmitRequest {
	readonly command: RoomCommand;
	readonly submissionId?: string;
}

export const encodeSubmitRequest = (request: SubmitRequest): Uint8Array =>
	encodeJson(
		request.submissionId === undefined
			? request.command
			: { ...request.command, id: request.submissionId }
	);

export const parseSubmitRequest = (value: unknown): SubmitRequest => {
	const command = parseRoomCommand(value);
	const id = isRecord(value) ? value.id : undefined;
	return typeof id === "string" && id.length > 0
		? { command, submissionId: id }
		: { command };
};

export const parseEnvelope = (value: unknown): Envelope => {
	if (
		!isRecord(value) ||
		typeof value.actor !== "string" ||
		typeof value.seq !== "number" ||
		!Number.isSafeInteger(value.seq) ||
		typeof value.timestamp !== "string" ||
		typeof value.type !== "string" ||
		!value.type.includes(".") ||
		!("payload" in value)
	) {
		throw new TypeError("RoomStore envelope is invalid.");
	}
	return {
		actor: value.actor,
		payload: value.payload,
		seq: value.seq,
		timestamp: value.timestamp,
		type: value.type as NamespacedType,
	};
};

export const parseRoomSubmission = (value: unknown): RoomSubmission => {
	if (!isRecord(value)) {
		throw new TypeError("RoomStore submission is invalid.");
	}
	if (value.accepted === true && Array.isArray(value.envelopes)) {
		return { accepted: true, envelopes: value.envelopes.map(parseEnvelope) };
	}
	if (value.rejected === true && typeof value.message === "string") {
		return { message: value.message, rejected: true };
	}
	throw new TypeError("RoomStore submission is invalid.");
};

export const parseRoomInfo = (value: unknown): RoomInfo => {
	if (
		!isRecord(value) ||
		typeof value.gameId !== "string" ||
		typeof value.label !== "string"
	) {
		throw new TypeError("RoomStore info is invalid.");
	}
	return { gameId: value.gameId, label: value.label };
};

export const parseStreamCredit = (value: unknown): void => {
	if (!isRecord(value) || value.next !== true) {
		throw new TypeError("RoomStore stream credit is invalid.");
	}
};

export const parseStreamOpen = (value: unknown): number => {
	if (
		!isRecord(value) ||
		typeof value.fromSeq !== "number" ||
		!Number.isSafeInteger(value.fromSeq) ||
		value.fromSeq < 1
	) {
		throw new TypeError("RoomStore stream open is invalid.");
	}
	return value.fromSeq;
};

// --- room registration: how a GM-hosted room gets a name at the gateway (ADR-0003) ---

const ROOM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

export const ROOM_NAME_RULE =
	"Room names are 1-32 lowercase letters, digits, and hyphens.";

/** Room names are 1–32 chars of lowercase a–z, 0–9, and interior hyphens. */
export const isValidRoomName = (name: string): boolean => ROOM_NAME.test(name);

export type RegistrationOutcome =
	| {
			readonly accepted: true;
			/** Hostname players ssh to, for the GM's summon line. */
			readonly sshHost: string;
			readonly sshPort: number;
	  }
	| { readonly rejected: true; readonly message: string };

export const parseRegistrationRequest = (value: unknown): string => {
	if (!isRecord(value) || typeof value.name !== "string") {
		throw new TypeError("Registration request is invalid.");
	}
	return value.name;
};

// --- the link channel: ADR-0005's linking conduit, riding the same pipe ---

/**
 * The room tag every link exchange that belongs to no room carries. A CLI
 * running `supervillain key link` holds a pipe with no rooms on it at all, and
 * `-` can never collide with a room name (a name may not start or end with a
 * hyphen).
 */
export const LINK_ROOM = "-";

/** One linking fact: `actor` and `linked` are the same person. The gateway
 * derives these from its graph; a room materializes them as events. */
export interface ActorLink {
	readonly actor: string;
	readonly linked: string;
}

/** The gateway's ask, opened toward a Host right after registration: name every
 * actor your log knows. The answer is transient — the gateway resolves it
 * against the graph and stores none of it (ADR-0013). */
export const ACTOR_ROSTER_REQUEST = { actors: true } as const;

export const parseActorRosterRequest = (value: unknown): void => {
	if (!isRecord(value) || value.actors !== true) {
		throw new TypeError("Actor roster request is invalid.");
	}
};

export const parseActorRoster = (value: unknown): readonly string[] => {
	if (
		!isRecord(value) ||
		!Array.isArray(value.actors) ||
		value.actors.some((one) => typeof one !== "string")
	) {
		throw new TypeError("Actor roster is invalid.");
	}
	return value.actors as readonly string[];
};

/** What a CLI asks of the gateway on the link channel. Redemption accepts
 * either code kind — the gateway knows what a code maps to (ADR-0005). */
export type LinkRequest =
	| { readonly mint: "device" }
	| { readonly redeem: string };

export const parseLinkRequest = (value: unknown): LinkRequest => {
	if (isRecord(value)) {
		if (value.mint === "device") {
			return { mint: "device" };
		}
		if (typeof value.redeem === "string" && value.redeem.length > 0) {
			return { redeem: value.redeem };
		}
	}
	throw new TypeError("Link request is invalid.");
};

export type LinkCodeOutcome =
	| {
			readonly accepted: true;
			readonly code: string;
			/** ISO-8601, so the CLI can say how long the code lives. */
			readonly expiresAt: string;
	  }
	| { readonly rejected: true; readonly message: string };

export const parseLinkCodeOutcome = (value: unknown): LinkCodeOutcome => {
	if (isRecord(value)) {
		if (
			value.accepted === true &&
			typeof value.code === "string" &&
			typeof value.expiresAt === "string"
		) {
			return { accepted: true, code: value.code, expiresAt: value.expiresAt };
		}
		if (value.rejected === true && typeof value.message === "string") {
			return { message: value.message, rejected: true };
		}
	}
	throw new TypeError("Link code outcome is invalid.");
};

export type LinkRedemptionOutcome =
	| {
			readonly accepted: true;
			/** The actor the redeeming key absorbed — the other machine's key, or
			 * the adopted `guest:X`. */
			readonly linked: string;
			readonly identityId: string;
	  }
	| { readonly rejected: true; readonly message: string };

export const parseLinkRedemptionOutcome = (
	value: unknown
): LinkRedemptionOutcome => {
	if (isRecord(value)) {
		if (
			value.accepted === true &&
			typeof value.linked === "string" &&
			typeof value.identityId === "string"
		) {
			return {
				accepted: true,
				identityId: value.identityId,
				linked: value.linked,
			};
		}
		if (value.rejected === true && typeof value.message === "string") {
			return { message: value.message, rejected: true };
		}
	}
	throw new TypeError("Link redemption outcome is invalid.");
};

export const parseRegistrationOutcome = (
	value: unknown
): RegistrationOutcome => {
	if (isRecord(value)) {
		if (
			value.accepted === true &&
			typeof value.sshHost === "string" &&
			typeof value.sshPort === "number" &&
			Number.isSafeInteger(value.sshPort)
		) {
			return { accepted: true, sshHost: value.sshHost, sshPort: value.sshPort };
		}
		if (value.rejected === true && typeof value.message === "string") {
			return { message: value.message, rejected: true };
		}
	}
	throw new TypeError("Registration outcome is invalid.");
};
