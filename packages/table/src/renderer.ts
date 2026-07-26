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
 * between them. The default for both local and gateway table surfaces. */
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

/** A session renderer plus a continuous render loop. Kept as the benchmark's
 * ambient-loop control so on-demand rendering can be measured against the
 * historical local-TTY behavior. Product surfaces use on-demand rendering. */
export const createLocalTtyRenderer: TableRendererFactory = async (
	connection
) => {
	const renderer = await createSessionRenderer(connection);
	renderer.start();
	return renderer;
};
