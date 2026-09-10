/**
 * Submission identity and the dedupe that rides on it (ADR-0012, NQ-6).
 *
 * A command lands exactly once or not at all. The rule that buys it: every
 * submission carries an id minted once by the sender, and the Host remembers
 * the answer it gave each id. A replayed id is answered from memory — never
 * applied a second time — so the one place the wire may resend (a write that
 * failed on an already-dead stream) can never double-append.
 *
 * What this deliberately is *not*: an auto-retry. ADR-0001's never-auto-retry
 * governs submits unchanged — a lost ack surfaces as
 * {@link SubmissionUncertainError} and waits for a human, which is what the
 * retry affordance in the chrome is for.
 *
 * The memory binds every id to a canonical digest of the command it was first
 * used for (#137). A replayed id wearing a different command is refused as a
 * Rejection — the wire then never lies about which command an answer belongs
 * to, and the dedupe holds against a buggy or hostile client, not just a
 * well-behaved one. A resend that survives an eviction carries no evidence and
 * is applied fresh: that is the accepted NQ-11 window, not a bug.
 *
 * Memory scope follows the path: the pipe path keeps one memory per Room, so
 * a binding outlives a reconnect; the direct protocol keeps one per connection,
 * which is enough because its senders mint no ids today.
 */
import { createHash } from "node:crypto";

import { isRecord } from "@supervillain/core";
import type { RoomCommand, RoomSubmission } from "@supervillain/core";

/**
 * How many answered submissions one Room remembers. Memory only, per NQ-11 —
 * it dies with the Host process, and losing it costs at worst one
 * double-append on a resend that crossed a restart. The number is a tunable
 * default (R9-gated), the shape is the decision.
 */
export const DEFAULT_SUBMISSION_MEMORY = 256;

/**
 * The answer to a submission was lost in flight: it may have landed, it may
 * not have. Never retried automatically — surfaced, so a person decides.
 */
export class SubmissionUncertainError extends Error {
	constructor(options?: { readonly cause?: unknown }) {
		super(
			"The answer to this command was lost. It may or may not have landed — check the table before sending it again.",
			options
		);
		this.name = "SubmissionUncertainError";
	}
}

/** The Host's bounded memory of answers it has already given. Each remembered
 * id is bound to the canonical digest of the command that earned the answer. */
export interface SubmissionMemory {
	readonly recall: (
		submissionId: string
	) =>
		| { readonly digest: string; readonly submission: RoomSubmission }
		| undefined;
	readonly remember: (
		submissionId: string,
		digest: string,
		submission: RoomSubmission
	) => void;
	readonly size: () => number;
}

/** A fixed-size memory, oldest id evicted first. */
export const createSubmissionMemory = (
	limit: number = DEFAULT_SUBMISSION_MEMORY
): SubmissionMemory => {
	const answers = new Map<
		string,
		{ readonly digest: string; readonly submission: RoomSubmission }
	>();
	return {
		recall: (submissionId) => answers.get(submissionId),
		remember(submissionId, digest, submission) {
			if (limit <= 0) {
				return;
			}
			answers.delete(submissionId);
			answers.set(submissionId, { digest, submission });
			while (answers.size > limit) {
				const [oldest] = answers.keys();
				if (oldest === undefined) {
					return;
				}
				answers.delete(oldest);
			}
		},
		size: () => answers.size,
	};
};

/** Canonical JSON: object keys sorted recursively, so a command and its
 * reserialized copy digest identically. Arrays keep their order; primitives
 * pass through untouched. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a RoomCommand's payload is deliberately opaque (core-owned); the canonical digest is defined over whatever JSON shape it takes.
const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.toSorted()
				.map((key) => [key, canonicalize(value[key])])
		);
	}
	return value;
};

/** A canonical digest of a RoomCommand: SHA-256 over the command's stable-key-
 * order JSON. This is what binds a submissionId to the command it was first
 * used for — the same command arriving in a different byte order digests the
 * same, a different command digests differently. */
export const digestRoomCommand = (command: RoomCommand): string =>
	createHash("sha256")
		.update(JSON.stringify(canonicalize(command)))
		.digest("hex");

/**
 * The one submission rule both wire paths serve (ADR-0012, NQ-6, #137).
 *
 * A submission carrying no id is applied every time — there is nothing to
 * dedupe on. A submission carrying an id is answered from memory when that id
 * has been seen before, which only holds if the command digests the same as
 * the one the id was first used for; a different command under a used id is
 * refused as a Rejection on the submit channel, never applied and never
 * answered from memory. A first-seen id is applied, then remembered with its
 * digest.
 */
export const serveSubmission = async (
	command: RoomCommand,
	submissionId: string | undefined,
	memory: SubmissionMemory,
	submit: (command: RoomCommand) => Promise<RoomSubmission>
): Promise<RoomSubmission> => {
	if (submissionId === undefined) {
		return await submit(command);
	}
	const digest = digestRoomCommand(command);
	const remembered = memory.recall(submissionId);
	if (remembered !== undefined) {
		return remembered.digest === digest
			? remembered.submission
			: {
					message:
						"This submission id was already used for a different command. Send a fresh id to submit it.",
					rejected: true,
				};
	}
	const submission = await submit(command);
	memory.remember(submissionId, digest, submission);
	return submission;
};

/** A fresh submission id. Opaque, and never derived from the command — the id
 * is routing metadata, never game content. */
export const mintSubmissionId = (): string => globalThis.crypto.randomUUID();
