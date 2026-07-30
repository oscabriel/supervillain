export const fullArtifactUrl = (
	capability: string,
	requestUrl: string,
	origin?: string
): string =>
	new URL(`/a/${capability}`, origin ?? new URL(requestUrl).origin).toString();

export const fullArtifactImageUrl = (
	capability: string,
	requestUrl: string,
	origin?: string
): string =>
	new URL(
		`/a/${capability}/og.png`,
		origin ?? new URL(requestUrl).origin
	).toString();
