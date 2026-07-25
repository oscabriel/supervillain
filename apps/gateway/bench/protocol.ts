/**
 * The one line-protocol between the R9 harness and the gateway it measures.
 *
 * The gateway under test runs in **its own process** for one reason: CPU and
 * RSS have to be the gateway's, not the harness's. A hundred SSH clients and a
 * Host in the same process would put their own cost in the number the caps are
 * chosen from, which is exactly the number that must not be guessed.
 *
 * Both halves are plain JSON lines on stdin/stdout, so nothing here needs a
 * transport of its own.
 */

/** What the harness asks the gateway process for. */
export type BenchRequest =
	| { readonly kind: "sample" }
	| { readonly kind: "stop" };

/** One reading of the gateway process's own resource use. `cpuMs` is
 * cumulative since process start (user + system), so a window's cost is the
 * difference between two samples. */
export interface BenchSample {
	readonly kind: "sample";
	readonly cpuMs: number;
	readonly rssBytes: number;
	/** The largest RSS this process has reached, sampled on a timer — a window's
	 * peak survives a garbage collection that lands before the mark. */
	readonly peakRssBytes: number;
}

export type BenchReply =
	| BenchSample
	| { readonly kind: "ready"; readonly url: string; readonly sshPort: number }
	| { readonly kind: "stopped" }
	| { readonly kind: "failed"; readonly message: string };

export const encodeLine = (value: unknown): string =>
	`${JSON.stringify(value)}\n`;

/** Splits a growing buffer into whole lines, returning the remainder. Neither
 * half of this protocol may assume one chunk is one line. */
export const takeLines = (
	buffer: string
): { readonly lines: readonly string[]; readonly rest: string } => {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.filter((line) => line.length > 0), rest };
};
