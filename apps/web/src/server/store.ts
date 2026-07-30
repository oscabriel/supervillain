/**
 * The tracer's in-memory middle — deliberately fake, replaced by the real
 * backend store (#103: Drizzle over bun:sqlite, snapshot files on disk) and
 * the real publish API (#104: auth, re-publish semantics, tombstones).
 *
 * Shape per the #43 spike: a Map seeded with one Artifact so the SSR route
 * has something to render before any ingest happens. Nothing here survives
 * a restart, and nothing here is a contract — the document shape is #100's
 * to define, the token format is #102's.
 */

/** The closed artifact type set (ADR-0009). */
export type ArtifactType = "character" | "log" | "map";

export interface Artifact {
	readonly type: ArtifactType;
	readonly name: string;
	/** #100's snapshot document, opaque to the tracer. */
	readonly document: unknown;
}

const ARTIFACT_TYPES: readonly ArtifactType[] = ["character", "log", "map"];

export const isArtifactType = (value: unknown): value is ArtifactType =>
	typeof value === "string" &&
	(ARTIFACT_TYPES as readonly string[]).includes(value);

/** The seeded artifact's capability — a fixture, not a minted token. */
export const SEED_CAPABILITY = "seed-artifact-capability";

const artifacts = new Map<string, Artifact>([
	[
		SEED_CAPABILITY,
		{
			document: { note: "seeded tracer artifact — replaced by #100's schema" },
			name: "Doctor Malignant",
			type: "character",
		},
	],
]);

export const getArtifact = (capability: string): Artifact | undefined =>
	artifacts.get(capability);

/**
 * Placeholder minting: random hex via the web crypto global. The real token
 * format, entropy, and hash-at-rest scheme are #102's spec — do not let this
 * shape calcify.
 */
export const ingestArtifact = (artifact: Artifact): string => {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const capability = Array.from(bytes, (b) =>
		b.toString(16).padStart(2, "0")
	).join("");
	artifacts.set(capability, artifact);
	return capability;
};
