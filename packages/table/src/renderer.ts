import { createCliRenderer } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { TerminalConnection } from "@supervillain/session";

/** How a *surface* mints the one renderer it owns for a session (ADR-0016):
 * the Door calls this once per SSH session, the CLI once per process, and each
 * destroys what it minted when the session ends. Screens never call this —
 * they borrow the surface's renderer through their options. Whether a render
 * loop runs is the surface's decision too — ADR-0012's "no ambient rendering"
 * clause. Typed to `TerminalConnection` rather than `Session` because the
 * lobby draws before any actor exists (ADR-0008). */
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
