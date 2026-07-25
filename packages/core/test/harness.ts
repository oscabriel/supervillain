const harness = process.versions.bun
	? await import("bun:test")
	: await import("vitest");

export const { describe, expect, test } = harness;
