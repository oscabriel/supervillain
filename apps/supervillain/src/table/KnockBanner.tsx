import type { MouseEvent } from "@opentui/core";
import { Show } from "solid-js";

import { isLeftButton } from "./mouse.ts";
import { color } from "./theme.ts";
import type { KnockShown } from "./view.ts";

export const knockLead = (knock: KnockShown): string =>
	`⚑ ${knock.name} (${knock.short}) knocks · `;

export const KnockBanner = (props: {
	knocks: ReadonlyArray<KnockShown>;
	onDecide: (knock: KnockShown, verdict: "admit" | "deny") => void;
}) => {
	const oldest = () => props.knocks[0];
	const more = () => props.knocks.length - 1;

	return (
		<Show when={oldest()}>
			{(knock: () => KnockShown) => (
				<box
					height={1}
					flexShrink={0}
					paddingLeft={1}
					paddingRight={1}
					flexDirection="row"
				>
					<text wrapMode="none" flexShrink={0} fg={color.gm}>
						{knockLead(knock())}
					</text>
					<text
						wrapMode="none"
						flexShrink={0}
						selectable={false}
						onMouseDown={(event: MouseEvent) => {
							if (isLeftButton(event)) {
								props.onDecide(knock(), "admit");
							}
						}}
					>
						<span style={{ fg: color.cursorFg, bg: color.healthy }}>
							{"[Admit]"}
						</span>
					</text>
					<text wrapMode="none" flexShrink={0}>
						{" "}
					</text>
					<text
						wrapMode="none"
						flexShrink={0}
						selectable={false}
						onMouseDown={(event: MouseEvent) => {
							if (isLeftButton(event)) {
								props.onDecide(knock(), "deny");
							}
						}}
					>
						<span style={{ fg: color.cursorFg, bg: color.dying }}>
							{"[Deny]"}
						</span>
					</text>
					<text wrapMode="none" truncate fg={color.dim}>
						{`  Alt+Y / Alt+N${more() > 0 ? ` · ${more()} more knocking` : ""}`}
					</text>
				</box>
			)}
		</Show>
	);
};
