import { createCliRenderer } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { TerminalConnection } from "@supervillain/session";

/** How a surface gets the renderer it draws on. The caller supplies it: mint
 * one over the connection's streams, or hand over a renderer someone else
 * already owns (the Door's per-session renderer, once `@opentui/ssh` supplies
 * it). The surface never mints its own and never starts a render loop —
 * ADR-0012's "no ambient rendering" clause: the caller decides when, and
 * whether, a loop runs. Typed to `TerminalConnection` rather than `Session`
 * because the lobby draws before any actor exists (ADR-0008). */
export type TableRendererFactory = (
	connection: TerminalConnection
) => CliRenderer | Promise<CliRenderer>;

/** Mints a renderer over the connection's own streams and leaves it idle:
 * frames are drawn on demand, one per change, with no render loop burning CPU
 * between them. The gateway's per-seat default — an ambient loop there is a
 * cost paid once per seat. */
export const createSessionRenderer: TableRendererFactory = (connection) => {
	const size = connection.size();
	return createCliRenderer({
		exitOnCtrlC: true,
		height: size.rows,
		stdin: connection.input,
		stdout: connection.output,
		width: size.columns,
	});
};

/** The local-TTY factory: a session renderer plus the continuous render loop the
 * CLI has always run. One process, one terminal, one loop — the caller that can
 * afford ambient rendering asking for it by name. */
export const createLocalTtyRenderer: TableRendererFactory = async (
	connection
) => {
	const renderer = await createSessionRenderer(connection);
	renderer.start();
	return renderer;
};
