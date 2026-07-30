export interface ResolvedPublishIdentity {
	readonly identityId?: string;
	/** Current identity first, then former ids retained across lone-key moves. */
	readonly ownerIdentityIds: readonly string[];
	readonly revoked: boolean;
}

/** The awaited hosted-web face of ADR-0013's synchronous identity seam. */
export interface AsyncIdentityDirectory {
	readonly resolveKey: (key: string) => Promise<ResolvedPublishIdentity>;
}

export interface RemoteIdentityDirectoryOptions {
	readonly conduitUrl: string;
	readonly fetch?: typeof fetch;
}

const isStringArray = (value: unknown): value is readonly string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const parseResolution = (value: unknown): ResolvedPublishIdentity => {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("identityId" in value) ||
		(value.identityId !== null && typeof value.identityId !== "string") ||
		!("ownerIdentityIds" in value) ||
		!isStringArray(value.ownerIdentityIds) ||
		!("revoked" in value) ||
		typeof value.revoked !== "boolean"
	) {
		throw new Error("Identity conduit returned an invalid response");
	}
	return {
		identityId:
			typeof value.identityId === "string" ? value.identityId : undefined,
		ownerIdentityIds: value.ownerIdentityIds,
		revoked: value.revoked,
	};
};

/** ADR-0013's remote implementation: one local call on the publish cold path.
 * The synchronous `IdentityDirectory` remains untouched; awaiting belongs here. */
export const createRemoteIdentityDirectory = (
	options: RemoteIdentityDirectoryOptions
): AsyncIdentityDirectory => {
	const request = options.fetch ?? fetch;
	const endpoint = new URL("/identity/resolve", options.conduitUrl);
	return {
		resolveKey: async (key) => {
			const response = await request(endpoint, {
				body: JSON.stringify({ key }),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			if (!response.ok) {
				throw new Error(`Identity conduit failed with ${response.status}`);
			}
			return parseResolution(await response.json());
		},
	};
};
