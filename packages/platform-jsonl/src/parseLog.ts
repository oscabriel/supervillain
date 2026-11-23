import { Predicate, Result, Schema, SchemaIssue } from "effect";
import type { StandardSchema } from "effect";

import { LineJson } from "./envelope.ts";
import type { Line } from "./envelope.ts";

const decodeLine = Schema.decodeUnknownResult(LineJson);

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: (issue) =>
		Predicate.isTagged(issue, "MissingKey")
			? "missing"
			: SchemaIssue.defaultLeafHook(issue),
});

const keyName = (
	segment: PropertyKey | StandardSchema.StandardSchemaV1.PathSegment
) => {
	const key = Predicate.isPropertyKey(segment) ? segment : segment.key;

	return Predicate.isSymbol(key) ? key.toString() : String(key);
};

const problem = (issue: SchemaIssue.Issue) => {
	const [first] = formatIssue(issue).issues;

	const message = (first?.message ?? "not an envelope").replace(
		/^\w/u,
		(letter) => letter.toLowerCase()
	);

	const field = first?.path?.[0];

	if (field === undefined) {
		return message;
	}

	return `${keyName(field)}: ${message}`;
};

export interface LineProblem {
	readonly line: number;
	readonly message: string;
}

export interface ParsedLog {
	readonly lines: ReadonlyArray<Line>;
	readonly intact: string;
	readonly torn?: string;
	readonly error?: LineProblem;
}

const finish = (
	intact: string,
	tail: string,
	lines: ReadonlyArray<Line>,
	error: LineProblem | undefined
): ParsedLog => {
	const base: ParsedLog =
		tail === "" ? { lines, intact } : { lines, intact, torn: tail };

	return error === undefined ? base : { ...base, error };
};

export const parseLog = (text: string): ParsedLog => {
	const end = text.lastIndexOf("\n") + 1;
	const intact = text.slice(0, end);
	const tail = text.slice(end);
	const lines: Array<Line> = [];
	const raws = intact.split("\n").slice(0, -1);

	for (const [index, raw] of raws.entries()) {
		const number = index + 1;
		const result = decodeLine(raw);

		if (Result.isFailure(result)) {
			return finish(intact, tail, lines, {
				line: number,
				message: problem(result.failure.issue),
			});
		}

		if (result.success.seq !== number) {
			return finish(intact, tail, lines, {
				line: number,
				message: `seq ${result.success.seq} on line ${number}`,
			});
		}

		lines.push(result.success);
	}

	return finish(intact, tail, lines, undefined);
};
