import { labelOf, plainText, readLog } from "@supervillain/domain";
import type { RulesetName, Skipped, TableState } from "@supervillain/domain";
import { parseLog } from "@supervillain/platform-jsonl";

const counted = (n: number, one: string, many: string) =>
	`[${n} ${n === 1 ? one : many}]`;

export const shownState = (state: TableState) => ({
	...state,
	feed: `[${state.feed.length} lines]`,
	undo: counted(state.undo.length, "batch", "batches"),
	redo: counted(state.redo.length, "batch", "batches"),
});

export interface CheckReport {
	readonly out: ReadonlyArray<string>;
	readonly warnings: ReadonlyArray<string>;
	readonly error?: string;
}

const warningOf = (skipped: Skipped): string => {
	const where =
		skipped.seq === undefined ? `line ${skipped.line}` : `seq ${skipped.seq}`;

	return skipped.reason.startsWith("unknown event type")
		? `${where}: skipped ${skipped.reason}`
		: `${where}: skipped ${skipped.type ?? "a line"}: ${skipped.reason}`;
};

export const checkLog = (
	path: string,
	text: string,
	ruleset: RulesetName
): CheckReport => {
	const parsed = parseLog(text);
	const intact = parsed.intact.split("\n").slice(0, parsed.lines.length);
	const read = readLog(intact, ruleset);
	const { state } = read;
	const skippedLines = new Set(read.skipped.map((s) => s.line));

	const torn =
		parsed.torn === undefined
			? []
			: [
					"the last line has no newline (a write that never finished); ignoring it",
				];

	const warnings = [...torn, ...read.skipped.map(warningOf)];

	const halt = read.error?.line ?? Number.POSITIVE_INFINITY;
	const counts = new Map<string, number>();

	for (const [index, line] of parsed.lines.entries()) {
		const number = index + 1;

		if (number < halt && !skippedLines.has(number)) {
			counts.set(line.type, (counts.get(line.type) ?? 0) + 1);
		}
	}

	const label = labelOf(state);
	const events = [...counts].map(([type, n]) => `${type} ×${n}`).join(", ");
	const actors = state.actors.map((a) => `${label(a)} (${a})`).join(", ");

	const out = [
		`${path}: ${parsed.lines.length} events, through seq ${state.seq}, ${read.skipped.length} skipped`,
		`events: ${events === "" ? "none" : events}`,
		`actors: ${actors === "" ? "none" : actors}`,
		"",
		"feed:",
		...read.feed.map(
			(line) => `${String(line.seq).padStart(6)}  ${plainText(line)}`
		),
		"",
		"state:",
		JSON.stringify(shownState(state), null, 2),
	];

	if (parsed.error !== undefined) {
		return {
			out,
			warnings,
			error: `${path}:${parsed.error.line}: ${parsed.error.message} (read ${parsed.lines.length} lines before it)`,
		};
	}

	if (read.error !== undefined) {
		return {
			out,
			warnings,
			error: `${path}: stopped at seq ${read.error.seq}: ${read.error.message}`,
		};
	}

	return { out, warnings };
};
