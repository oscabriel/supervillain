import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Option } from "effect";

const Website = Cloudflare.Website.Foldkit(
	"Website",
	Effect.gen(function* () {
		const set = yield* Effect.orDie(
			Config.option(Config.String("SUPERVILLAIN_SITE_DOMAIN"))
		);

		const domain = Option.filter(set, (name) => name !== "");

		return {
			domain: Option.getOrNull(domain),
			assets: { htmlHandling: "drop-trailing-slash" as const },
			dev: { host: "127.0.0.1", port: 3026, strictPort: true },
		};
	})
);

export default Alchemy.Stack(
	"SupervillainSite",
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const website = yield* Website;

		return { url: website.url };
	})
);
