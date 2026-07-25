import { createCliRenderer } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { Session } from "@supervillain/session";

/** How a table gets the renderer it draws on. The caller supplies it: mint one
 * over the session's streams, or hand over a renderer someone else already owns
 * (the Door's per-session renderer, once `@opentui/ssh` supplies it). The table
 * never mints its own and never starts a render loop — ADR-0012's "no ambient
 * rendering" clause: the caller decides when, and whether, a loop runs. */
export type TableRendererFactory = (
	session: Session
) => CliRenderer | Promise<CliRenderer>;

/** Mints a renderer over the session's own streams and leaves it idle: frames
 * are drawn on demand, one per change, with no render loop burning CPU between
 * them. The gateway's per-seat default — an ambient loop there is a cost paid
 * once per seat. */
export const createSessionRenderer: TableRendererFactory = (session) => {
	const size = session.size();
	return createCliRenderer({
		exitOnCtrlC: true,
		height: size.rows,
		stdin: session.input,
		stdout: session.output,
		width: size.columns,
	});
};

/** The local-TTY factory: a session renderer plus the continuous render loop the
 * CLI has always run. One process, one terminal, one loop — the caller that can
 * afford ambient rendering asking for it by name. */
export const createLocalTtyRenderer: TableRendererFactory = async (session) => {
	const renderer = await createSessionRenderer(session);
	renderer.start();
	return renderer;
};
