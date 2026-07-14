import { RGBA } from "@opentui/core";
import type { ThemeToken } from "@supervillain/core";

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
