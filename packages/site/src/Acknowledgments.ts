import type { Html, HtmlBuilder } from "foldkit/html";

import { SOURCE } from "./Layout.ts";
import type { Message } from "./Model.ts";

const MEKMODE = "https://mektxt.com/fonts/mekmode";

const ORC_LICENSE = "https://www.azoralaw.com/orclicense";

const ORC_NOTICE = `${SOURCE}/blob/main/docs/ORC-NOTICE.md`;

const NOTICE = `${SOURCE}/blob/main/NOTICE`;

export const acknowledgmentsView = (
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => [
	h.div(
		[h.Class("container")],
		[
			h.article(
				[h.Class("column")],
				[
					h.header(
						[h.Class("doc-head")],
						[
							h.h1([], ["Acknowledgments"]),
							h.p(
								[h.Class("lede")],
								["Credits, licenses, and the work supervillain builds on."]
							),
						]
					),
					h.div(
						[h.Class("prose")],
						[
							h.h2([h.Id("picture-mode-glyphs")], ["Picture mode glyphs"]),
							h.p(
								[],
								[
									"Picture mode's map tiles and character figures use the dings from ",
									h.a([h.Href(MEKMODE)], ["MEKMODE"]),
									" by Michael Micasso (MEK.txt), used with the author's permission.",
								]
							),
							h.h2(
								[h.Id("draw-steel-creator-license")],
								["Draw Steel Creator License"]
							),
							h.p(
								[],
								[
									"supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2024 MCDM Productions, LLC.",
								]
							),
							h.h2(
								[h.Id("open-rpg-creative-license")],
								["Open RPG Creative (ORC) License"]
							),
							h.p(
								[],
								[
									"The ",
									h.code([], ["pf2e"]),
									" ruleset implements open tactical game mechanics licensed under the ",
									h.a(
										[h.Href(ORC_LICENSE)],
										["Open RPG Creative (ORC) License"]
									),
									" (Library of Congress TX 9-307-067). All warranties are disclaimed as set forth therein. supervillain is not affiliated with, endorsed by, or sponsored by Paizo Inc. See ",
									h.a([h.Href(ORC_NOTICE)], ["docs/ORC-NOTICE.md"]),
									" for full attribution and Reserved Material declarations.",
								]
							),
							h.h2([h.Id("third-party-software")], ["Third-party software"]),
							h.p(
								[],
								[
									"Full third-party software notices live in ",
									h.a([h.Href(NOTICE)], ["NOTICE"]),
									" in the repository.",
								]
							),
						]
					),
				]
			),
		]
	),
];
