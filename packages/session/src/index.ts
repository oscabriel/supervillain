export interface TerminalSize {
	readonly columns: number;
	readonly rows: number;
}

/** A connected terminal attached to the table. Transport-neutral: the CLI's
 * local TTY today, the gateway's SSH channel at v0 — never typed to ssh2. */
export interface Session {
	readonly actor: string;
	readonly input: NodeJS.ReadStream;
	readonly output: NodeJS.WriteStream;
	readonly size: () => TerminalSize;
	readonly onResize: (listener: (size: TerminalSize) => void) => () => void;
	readonly onClose: (listener: () => void) => () => void;
	readonly close: () => void;
}

export interface LocalTtyOptions {
	readonly actor: string;
	readonly input?: NodeJS.ReadStream;
	readonly output?: NodeJS.WriteStream;
}

export const attachLocalTty = (options: LocalTtyOptions): Session => {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const closeListeners = new Set<() => void>();
	let closed = false;
	const size = (): TerminalSize => ({
		columns: output.columns ?? 80,
		rows: output.rows ?? 24,
	});
	return {
		actor: options.actor,
		close() {
			if (closed) {
				return;
			}
			closed = true;
			for (const listener of closeListeners) {
				listener();
			}
			closeListeners.clear();
		},
		input,
		onClose(listener) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		onResize(listener) {
			const handleResize = () => listener(size());
			output.on("resize", handleResize);
			return () => output.off("resize", handleResize);
		},
		output,
		size,
	};
};
