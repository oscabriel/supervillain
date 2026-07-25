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
 */
import type { RoomSubmission } from "@supervillain/core";

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

/** The Host's bounded memory of answers it has already given. */
export interface SubmissionMemory {
	readonly recall: (submissionId: string) => RoomSubmission | undefined;
	readonly remember: (submissionId: string, submission: RoomSubmission) => void;
	readonly size: () => number;
}

/** A fixed-size memory, oldest id evicted first. */
export const createSubmissionMemory = (
	limit: number = DEFAULT_SUBMISSION_MEMORY
): SubmissionMemory => {
	const answers = new Map<string, RoomSubmission>();
	return {
		recall: (submissionId) => answers.get(submissionId),
		remember(submissionId, submission) {
			if (limit <= 0) {
				return;
			}
			answers.delete(submissionId);
			answers.set(submissionId, submission);
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

/** A fresh submission id. Opaque, and never derived from the command — the id
 * is routing metadata, never game content. */
export const mintSubmissionId = (): string => globalThis.crypto.randomUUID();
