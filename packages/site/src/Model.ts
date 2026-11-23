import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { AppRoute } from "./Route.ts";
import { Demo } from "./Table.ts";

export const Model = Schema.Struct({
	route: AppRoute,
	demo: Demo,
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
});

export type Message = typeof Message.Type;
