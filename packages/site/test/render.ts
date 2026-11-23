import { Effect } from "effect";
import { Server } from "foldkit/experimental";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message, Model } from "../src/Model.ts";
import { AppRoute } from "../src/Route.ts";
import { DEMO } from "../src/Table.ts";
import type { Demo } from "../src/Table.ts";

export const htmlOf = async (
	body: (model: Model, h: HtmlBuilder<Message>) => Html,
	demo: Demo = DEMO
): Promise<string> => {
	const rendered = await Effect.runPromise(
		Server.renderToString<Model, Message>(
			{
				init: () => ({
					model: { route: AppRoute.Home(), demo, copied: false },
				}),
				view: (model, h) => ({ title: "test", body: body(model, h) }),
			},
			{ isHydratable: false }
		)
	);

	return rendered.html;
};

export const countOf = (html: string, needle: string): number =>
	html.split(needle).length - 1;
