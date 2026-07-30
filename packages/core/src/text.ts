/** Semantic foreground intents shared by terminal FeedLines and snapshots. */
export const THEME_TOKENS = [
	"accent",
	"danger",
	"muted",
	"primary",
	"success",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** The zero-palette styling axis. Blink is deliberately absent. */
export const TEXT_ATTRIBUTES = [
	"bold",
	"dim",
	"italic",
	"reverse",
	"underline",
] as const;

export type TextAttribute = (typeof TEXT_ATTRIBUTES)[number];

export interface TextRun {
	readonly text: string;
	readonly token: ThemeToken;
	readonly attrs?: readonly TextAttribute[];
}

/** A semantic line: text runs and theme intent, never terminal escape bytes. */
export interface FeedLine {
	readonly runs: readonly TextRun[];
}
