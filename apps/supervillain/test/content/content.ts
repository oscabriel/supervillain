import { Context, Effect, Layer } from "effect";

import { CampaignContent } from "../../src/content/index.ts";

export const withContent = <A, E, R>(
	dir: string,
	body: (content: CampaignContent["Service"]) => Effect.Effect<A, E, R>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(CampaignContent.layer(dir));

			return yield* body(Context.get(context, CampaignContent));
		})
	);
