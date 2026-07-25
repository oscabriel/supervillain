/** Returns whether a value is a non-array object with string keys. */
export const isRecord = (
	value: unknown
): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export interface ValidationIssue {
	readonly message: string;
}

export type ValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export type ContentValidator = (bytes: Uint8Array) => ValidationResult;
