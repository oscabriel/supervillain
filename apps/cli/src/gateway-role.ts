/**
 * The one door between the two roles the single compiled binary carries
 * (ADR-0012's "same single compiled binary", shaped by ADR-0015).
 *
 * `apps/gateway` is the **server half**: `bun:sqlite`, the SSH door, the
 * broker. None of it belongs on the client path — a GM running `create` or a
 * player running `join` must never evaluate a line of it. So this file is the
 * only place in `apps/cli` allowed to name `@supervillain/gateway`
 * (dependency-cruiser rule `gateway-role-behind-one-door` enforces that), and
 * the import is deferred: the module graph is compiled into the artifact, but
 * nothing in it runs until an operator actually asks for the gateway role.
 */
export const runGatewayRole = async (
	args: readonly string[]
): Promise<number> => {
	const { serveGateway } = await import("@supervillain/gateway");
	return await serveGateway(args);
};
