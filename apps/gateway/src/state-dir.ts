import path from "node:path";

/**
 * Where an *operated* gateway keeps its state — the box we run (#40). A
 * gateway only ever lands here because the deployment unit said so with an
 * explicit `--state` or `SUPERVILLAIN_GATEWAY_STATE`: nothing infers this
 * path from the uid, the hostname, or anything else about the machine
 * (ADR-0014). It is exported so the operated posture has one spelling.
 */
export const OPERATED_GATEWAY_STATE_DIR = "/var/lib/supervillain/gateway";

/** The homelab default's leaf, under the XDG state root. Two segments, not
 * one, so a future second role on the same box gets a sibling rather than a
 * name collision. */
const HOMELAB_STATE_LEAF = ["supervillain", "gateway"] as const;

export interface GatewayStateDirInputs {
	/** `--state <dir>` — beats everything. */
	readonly flag?: string | undefined;
	/** `SUPERVILLAIN_GATEWAY_STATE`. */
	readonly env?: string | undefined;
	/** `XDG_STATE_HOME`. */
	readonly xdgStateHome?: string | undefined;
	/** The operator's home directory, for the XDG fallback. */
	readonly homeDir: string;
}

/**
 * The homelab answer to "where does gateway state live" (ADR-0014).
 *
 * `--state` beats `SUPERVILLAIN_GATEWAY_STATE` beats
 * `${XDG_STATE_HOME:-~/.local/state}/supervillain/gateway`. It is **never** the
 * campaign folder: the campaign is the GM's canonical files and moves between
 * machines, while the gateway's identity, SSH host key, and registry belong to
 * the box (ADR-0012's credentials-don't-travel rule, one level up).
 */
export const resolveGatewayStateDir = (
	inputs: GatewayStateDirInputs
): string => {
	const explicit = inputs.flag ?? inputs.env;
	if (explicit !== undefined && explicit.length > 0) {
		return path.resolve(explicit);
	}
	const stateRoot =
		inputs.xdgStateHome !== undefined && inputs.xdgStateHome.length > 0
			? inputs.xdgStateHome
			: path.join(inputs.homeDir, ".local", "state");
	return path.resolve(path.join(stateRoot, ...HOMELAB_STATE_LEAF));
};
