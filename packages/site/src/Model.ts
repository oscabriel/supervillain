import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { AppRoute } from "./Route.ts";
import { Demo, restarted, sent } from "./Table.ts";

export const MapMode = Schema.Literals(["pictures", "text"]);

export type MapMode = typeof MapMode.Type;

export const Model = Schema.Struct({
	route: AppRoute,
	demo: Demo,
	copied: Schema.Boolean,
	copiedBlock: Schema.String,
	copyToken: Schema.Int,
	mapMode: MapMode,
});

export type Model = typeof Model.Type;

export const Key = Schema.Literals(["ArrowUp", "ArrowDown", "Escape"]);

export type Key = typeof Key.Type;

export const Message = defineMessageUnion({
	ClickedLink: { request: UrlRequest },
	ChangedUrl: { url: Url },
	CompletedNavigate: {},
	TypedLine: { line: Schema.String },
	SubmittedLine: {},
	ClickedSuggestion: { line: Schema.String },
	ClickedSquare: { square: Schema.String },
	ClickedToken: { id: Schema.String },
	PressedKey: { key: Key },
	ClickedCloseReply: {},
	ClickedLogToggle: {},
	ClickedRestart: {},
	ClickedMapMode: { mode: MapMode },
	ClickedCopyCommand: {},
	ResetCopyCommand: { token: Schema.Int },
	ClickedCopyCode: { id: Schema.String, text: Schema.String },
	ResetCopyCode: { id: Schema.String, token: Schema.Int },
});

export type Message = typeof Message.Type;

const modeOf = (word: string, current: MapMode): MapMode | undefined => {
	if (word === "pictures" || word === "text") {
		return word;
	}

	if (word !== "") {
		return undefined;
	}

	return current === "pictures" ? "text" : "pictures";
};

const viewed = (model: Model, text: string, word: string): Model => {
	const mode = modeOf(word, model.mapMode);

	const demo: Demo = {
		...model.demo,
		line: "",
		refusal: mode === undefined ? "Refused: /view takes pictures or text." : "",
		sent: [...model.demo.sent, text],
		recall: 0,
	};

	return { ...model, demo, mapMode: mode ?? model.mapMode };
};

export const ranLine = (model: Model, line: string): Model => {
	const text = line.trim();
	const [rawHead = "", word = "", ...rest] = text.split(/\s+/u);
	const head = rawHead.toLowerCase();

	if (head === "/view") {
		return viewed(model, text, rest.length === 0 ? word.toLowerCase() : "?");
	}

	if (head === "/reset") {
		if (word !== "") {
			return {
				...model,
				demo: {
					...model.demo,
					line: "",
					refusal: "Refused: /reset takes no arguments.",
					sent: [...model.demo.sent, text],
					recall: 0,
				},
			};
		}

		return { ...model, demo: restarted(model.demo) };
	}

	return { ...model, demo: sent(model.demo, line) };
};
