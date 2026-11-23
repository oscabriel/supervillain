import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { For } from "solid-js";

import { boxClick, wheel } from "./mouse.ts";
import { marked } from "./panels.ts";
import { color, feedStyle } from "./theme.ts";
import type { FeedLine } from "./view.ts";

export const Feed = (props: {
	lines: ReadonlyArray<FeedLine>;
	ref: (el: ScrollBoxRenderable) => void;
	mark?: string | undefined;
	onTitle?: (() => void) | undefined;
}) => {
	let box: BoxRenderable | undefined;
	const title = () => marked(" feed ", props.mark);

	return (
		<box
			ref={(el: BoxRenderable) => {
				box = el;
			}}
			onMouseDown={boxClick(() => box, title, props.onTitle)}
			border
			borderColor={color.border}
			title={title()}
			flexGrow={1}
			minWidth={0}
		>
			<scrollbox
				ref={props.ref}
				scrollAcceleration={wheel}
				flexGrow={1}
				stickyScroll
				stickyStart="bottom"
				paddingLeft={1}
				paddingRight={1}
			>
				<For each={props.lines}>
					{(l) => {
						const style = feedStyle(l.kind);

						return (
							<text wrapMode="word">
								<span style={{ fg: l.gm ? color.gm : style.who }}>
									{style.speaker ? l.who : ""}
								</span>
								<span style={{ fg: style.text }}>
									{style.speaker ? `${style.separator}${l.text}` : l.text}
								</span>
							</text>
						);
					}}
				</For>
			</scrollbox>
		</box>
	);
};
