import type { Demo } from "./Table.ts";
import { gmSaid, restarted, sent } from "./Table.ts";

export type AutoplayBeat =
	| {
			readonly kind: "gm";
			readonly text: string;
			readonly delayMs: number;
	  }
	| {
			readonly kind: "preview";
			readonly line: string;
			readonly delayMs: number;
	  }
	| {
			readonly kind: "send";
			readonly line: string;
			readonly delayMs: number;
	  }
	| {
			readonly kind: "restart";
			readonly delayMs: number;
	  };

export interface AutoplayStepResult {
	readonly demo: Demo;
	readonly autoplayLine: string;
	readonly nextStep: number;
}

export const AUTOPLAY_SCRIPT: ReadonlyArray<AutoplayBeat> = [
	{
		kind: "gm",
		text: "Rain hammers the stone arch over the ford. Two bandits step out from the reeds.",
		delayMs: 1100,
	},
	{
		kind: "preview",
		line: "/move brann g4",
		delayMs: 1500,
	},
	{
		kind: "send",
		line: "/move brann g4",
		delayMs: 650,
	},
	{
		kind: "preview",
		line: "/pr brann driving on b",
		delayMs: 1700,
	},
	{
		kind: "send",
		line: "/pr brann driving on b",
		delayMs: 700,
	},
	{
		kind: "preview",
		line: "Holding the ford. Watch the reeds!",
		delayMs: 1600,
	},
	{
		kind: "send",
		line: "Holding the ford. Watch the reeds!",
		delayMs: 650,
	},
	{
		kind: "preview",
		line: "/done",
		delayMs: 1500,
	},
	{
		kind: "send",
		line: "/done",
		delayMs: 600,
	},
	{
		kind: "gm",
		text: "Sling stones skip off the cobblestones. Brann's wrath rises to 4.",
		delayMs: 2000,
	},
	{
		kind: "preview",
		line: "/move brann i4",
		delayMs: 1700,
	},
	{
		kind: "send",
		line: "/move brann i4",
		delayMs: 650,
	},
	{
		kind: "preview",
		line: "/pr brann glare on s",
		delayMs: 1700,
	},
	{
		kind: "send",
		line: "/pr brann glare on s",
		delayMs: 700,
	},
	{
		kind: "preview",
		line: "/done",
		delayMs: 1800,
	},
	{
		kind: "send",
		line: "/done",
		delayMs: 600,
	},
	{
		kind: "restart",
		delayMs: 4600,
	},
];

export const delayOfStep = (step: number): number =>
	AUTOPLAY_SCRIPT[step]?.delayMs ?? 1500;

export const advanceAutoplay = (
	demo: Demo,
	step: number
): AutoplayStepResult => {
	const beat = AUTOPLAY_SCRIPT[step];

	if (beat === undefined) {
		return { demo: restarted(demo), autoplayLine: "", nextStep: 0 };
	}

	const nextStep = (step + 1) % AUTOPLAY_SCRIPT.length;

	if (beat.kind === "gm") {
		return { demo: gmSaid(demo, beat.text), autoplayLine: "", nextStep };
	}

	if (beat.kind === "preview") {
		return { demo, autoplayLine: beat.line, nextStep };
	}

	if (beat.kind === "send") {
		return { demo: sent(demo, beat.line), autoplayLine: "", nextStep };
	}

	return { demo: restarted(demo), autoplayLine: "", nextStep };
};
