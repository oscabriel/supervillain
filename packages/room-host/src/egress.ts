/**
 * Log egress (ADR-0033, #135): `supervillain campaign pull` materializes a
 * room's Log into a fresh Campaign folder. One direction only — a source is
 * read, a destination is written, and nothing here can ever append to a room.
 * The single-writer rule holds by construction because no writer exists.
 *
 * What lands is the Envelope stream byte for byte, and nothing else: no
 * sidecars, no derived state, no receipt. The result is an ordinary Campaign
 * folder that `RoomHost.open` replays to the same state as its source.
 *
 * This module imports the filesystem and the core. It has no transport, no
 * tier check, and no metering hook, and must never grow one: pull is pillar
 * infrastructure, free at every rung of the sovereignty ladder. Pulling a
 * local room touches no network.
 */

import { mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
	CORE_ROOM_CREATED,
	isRecord,
	isSeatedInLog,
	LOG_EGRESS_REFUSAL,
} from "@supervillain/core";
import type { Envelope, NamespacedType, Rejection } from "@supervillain/core";

import { LOG_FILE } from "./room-host.js";

/** The envelope fields the authorization fold reads. */
export type LogLine = Pick<Envelope, "actor" | "payload" | "type">;

/**
 * A room's Log as pull reads it: the exact bytes to write, plus the lines
 * those bytes parse to for the authorization fold. Today the only source is a
 * campaign folder on this disk; a gateway-attached room becomes a second way
 * to produce this same shape when the broker/attachment work lands.
 */
export interface LogSource {
	readonly bytes: Uint8Array;
	readonly envelopes: readonly LogLine[];
}

export interface PullLogOptions {
	/** The invoking identity — the key asking to pull. */
	readonly actor: string;
	/** The fresh Campaign folder to write. Must not exist, or must be empty. */
	readonly destination: string;
	readonly source: LogSource;
}

export interface PulledLog {
	readonly eventCount: number;
	readonly logPath: string;
}

const isNodeError = (
	error: unknown
): error is Error & { readonly code: string } =>
	error instanceof Error && "code" in error && typeof error.code === "string";

const notARoomLog = (campaignFolder: string, cause?: unknown): Error =>
	new Error(`${path.join(campaignFolder, LOG_FILE)} is not a room log.`, {
		cause,
	});

/** The three envelope fields the authorization fold reads, or `null` when a
 * line is not shaped like an envelope at all. */
const readLogLine = (value: unknown): LogLine | null => {
	if (
		!isRecord(value) ||
		typeof value.actor !== "string" ||
		typeof value.type !== "string" ||
		!value.type.includes(".")
	) {
		return null;
	}
	return {
		actor: value.actor,
		payload: value.payload,
		type: value.type as NamespacedType,
	};
};

/**
 * Parses the lines the authorization fold needs. This is a reader (ADR-0010):
 * it asks only that every line be a JSON object naming an actor and a type and
 * that the first one creates a room. Sequence and payload validity are the
 * Host's business when the pulled folder is opened, not pull's — refusing a
 * log the Host would also refuse would leave its owner unable to rescue it.
 */
const parseEnvelopes = (
	text: string,
	campaignFolder: string
): readonly LogLine[] => {
	const lines = text.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	const envelopes = lines.map((line): LogLine => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			throw notARoomLog(campaignFolder, error);
		}
		const logLine = readLogLine(value);
		if (logLine === null) {
			throw notARoomLog(campaignFolder);
		}
		return logLine;
	});
	if (envelopes[0]?.type !== CORE_ROOM_CREATED) {
		throw notARoomLog(campaignFolder);
	}
	return envelopes;
};

/**
 * Reads a room's Log from a campaign folder on this disk. The bytes are kept
 * as read — never re-serialized — so what pull writes is what the Host wrote.
 */
export const openLocalLogSource = async (
	campaignFolder: string
): Promise<LogSource> => {
	const logPath = path.join(campaignFolder, LOG_FILE);
	let bytes: Uint8Array;
	try {
		bytes = await readFile(logPath);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			throw new Error(`No room log at ${logPath}.`, { cause: error });
		}
		throw error;
	}
	return {
		bytes,
		envelopes: parseEnvelopes(new TextDecoder().decode(bytes), campaignFolder),
	};
};

/** A destination is fresh when it does not exist yet or holds nothing. */
const assertFreshFolder = async (destination: string): Promise<void> => {
	let entries: readonly string[];
	try {
		entries = await readdir(destination);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return;
		}
		if (isNodeError(error) && error.code === "ENOTDIR") {
			throw new Error(`${destination} is not a folder.`, { cause: error });
		}
		throw error;
	}
	if (entries.length > 0) {
		throw new Error(
			`${destination} is not empty. pull writes only into a fresh campaign folder.`
		);
	}
};

/**
 * Writes the source Log into a fresh Campaign folder, or refuses. Authorization
 * is decided from the source stream alone (`isSeatedInLog`) and before the
 * destination is touched, so a refused pull leaves no folder behind. The
 * write is exclusive and fsynced: a folder that gained a log between the
 * freshness check and the write is refused rather than overwritten.
 */
export const pullLog = async (
	options: PullLogOptions
): Promise<PulledLog | Rejection> => {
	const { actor, destination, source } = options;
	if (!isSeatedInLog(source.envelopes, actor)) {
		return { message: LOG_EGRESS_REFUSAL, rejected: true };
	}
	await assertFreshFolder(destination);
	await mkdir(destination, { recursive: true });
	const logPath = path.join(destination, LOG_FILE);
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(logPath, "wx");
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") {
			throw new Error(
				`${logPath} already exists. pull writes only into a fresh campaign folder.`,
				{ cause: error }
			);
		}
		throw error;
	}
	try {
		await file.write(source.bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	return { eventCount: source.envelopes.length, logPath };
};
