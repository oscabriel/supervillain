import type { Readable } from "node:stream";

import { Effect } from "effect";

import { readKeys } from "../chrome/read.ts";
import { launcherFrame } from "./frame.ts";
import { LAUNCHER_NAV, launcherKeyed, launching } from "./keys.ts";
import type { LauncherChoice } from "./keys.ts";
import type { FoundCampaign } from "./scan.ts";

export interface LauncherProps {
	readonly campaigns: ReadonlyArray<FoundCampaign>;
	readonly home: string;
	readonly handle: string | undefined;
	readonly relay: string | undefined;
	readonly term: string;
	readonly now: number;
}

export interface LauncherInput extends Readable {
	readonly isRaw?: boolean;
	readonly setRawMode?: (raw: boolean) => void;
}

export interface LauncherOutput {
	readonly columns: number;
	readonly rows: number;
	readonly write: (text: string) => void;
	readonly on: (event: "resize", listener: () => void) => void;
	readonly removeListener: (event: "resize", listener: () => void) => void;
}

export interface LauncherTerminal {
	readonly stdin: LauncherInput;
	readonly stdout: LauncherOutput;
}

export const ENTER_ALT_SCREEN = "\u001B[?1049h";

export const LEAVE_ALT_SCREEN = "\u001B[?25h\u001B[?1049l";

const enter = ({ stdin, stdout }: LauncherTerminal): boolean => {
	const wasRaw = stdin.isRaw === true;
	stdout.write(ENTER_ALT_SCREEN);
	stdin.setRawMode?.(true);

	return wasRaw;
};

const leave = ({ stdin, stdout }: LauncherTerminal, wasRaw: boolean) => {
	stdin.setRawMode?.(wasRaw);
	stdin.pause();
	stdout.write(LEAVE_ALT_SCREEN);
};

const choosing = (
	props: LauncherProps,
	{ stdin, stdout }: LauncherTerminal
): Effect.Effect<LauncherChoice> => {
	const { campaigns, home, handle, relay, term, now } = props;
	const state = launching(relay !== undefined && handle === undefined);
	let resized: (() => void) | undefined;

	return readKeys({
		stream: stdin,
		state,
		rules: LAUNCHER_NAV,
		keyed: (_chunk, _at, byte) => {
			const step = launcherKeyed(state, campaigns, relay, handle, byte);

			return step.kind === "done"
				? { result: step.choice, rest: undefined }
				: undefined;
		},
		ended: { kind: "quit" },
		idle: undefined,
		draw: () => {
			stdout.write(
				launcherFrame(
					{ state, campaigns, home, handle, relay, term, now },
					stdout.columns || 80,
					stdout.rows || 24
				)
			);
		},
		redraw: (again) => {
			if (resized !== undefined) {
				stdout.removeListener("resize", resized);
			}

			resized = again;

			if (again !== undefined) {
				stdout.on("resize", again);
			}
		},
	});
};

export const runLauncher = (
	props: LauncherProps,
	terminal: LauncherTerminal
): Effect.Effect<LauncherChoice> =>
	Effect.acquireUseRelease(
		Effect.sync(() => enter(terminal)),
		() => choosing(props, terminal),
		(wasRaw) =>
			Effect.sync(() => {
				leave(terminal, wasRaw);
			})
	);
