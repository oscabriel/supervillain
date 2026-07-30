import { RGBA, TextAttributes } from "@opentui/core";
import type { TextAttribute, ThemeToken } from "@supervillain/core";

const ANSI_INDEX: Readonly<Record<ThemeToken, number>> = {
	accent: 6,
	danger: 1,
	muted: 8,
	primary: 7,
	success: 2,
};

/** Resolves semantic tokens to indexed ANSI-16 colors, preserving palette intent. */
export const resolveThemeToken = (token: ThemeToken): RGBA =>
	RGBA.fromIndex(ANSI_INDEX[token]);

const ATTRIBUTE_BIT: Readonly<Record<TextAttribute, number>> = {
	bold: TextAttributes.BOLD,
	dim: TextAttributes.DIM,
	italic: TextAttributes.ITALIC,
	// DESIGN.md's "reverse" is OpenTUI's INVERSE bit.
	reverse: TextAttributes.INVERSE,
	underline: TextAttributes.UNDERLINE,
};

/** Resolves a run's named attributes to OpenTUI's packed bitmask. */
export const resolveTextAttributes = (
	attrs?: readonly TextAttribute[]
): number =>
	// oxlint-disable-next-line eslint/no-bitwise, oxc/bad-bitwise-operator -- OpenTUI's attribute field is a bitmask by contract.
	(attrs ?? []).reduce((mask, attr) => mask | ATTRIBUTE_BIT[attr], 0);
