import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";

import type { Completion } from "./input.ts";
import { isLeftButton } from "./mouse.ts";
import { shownAgainText } from "./panels.ts";
import type { Panel } from "./panels.ts";
import { color } from "./theme.ts";

export const SHOWS_LEAD = " · show";

export const showsWidth = (shows: ReadonlyArray<Panel>): number =>
	shows.length === 0
		? 0
		: Bun.stringWidth(SHOWS_LEAD) +
			shows.reduce((n, p) => n + 1 + Bun.stringWidth(shownAgainText(p)), 0);

export const HintRow = (props: {
	hint: string;
	completion: Completion | undefined;
	lead?: string | undefined;
	shows?: ReadonlyArray<Panel> | undefined;
	onShow?: ((panel: Panel) => void) | undefined;
}) => {
	const shows = () =>
		props.completion === undefined ? (props.shows ?? []) : [];

	return (
		<box
			height={1}
			flexShrink={1}
			paddingLeft={1}
			paddingRight={1}
			flexDirection="row"
		>
			<text wrapMode="none" truncate flexShrink={1} minWidth={0}>
				<Show
					when={props.completion}
					fallback={
						<>
							<Show when={props.lead}>
								{(lead: Accessor<string>) => (
									<>
										<span style={{ fg: color.text, bg: color.reach }}>
											{lead()}
										</span>
										<Show when={props.hint !== ""}>
											<span style={{ fg: color.dim }}>{" · "}</span>
										</Show>
									</>
								)}
							</Show>
							<span style={{ fg: color.dim }}>{props.hint}</span>
						</>
					}
				>
					{(c: Accessor<Completion>) => (
						<>
							<span style={{ fg: color.dim }}>Tab:</span>
							<For each={c().candidates}>
								{(candidate, i) => (
									<>
										<span>{"  "}</span>
										<span
											style={
												i() === c().index
													? { fg: color.cursorFg, bg: color.cursorBg }
													: { fg: color.dim }
											}
										>
											{candidate.trim()}
										</span>
									</>
								)}
							</For>
						</>
					)}
				</Show>
			</text>
			<Show when={shows().length > 0}>
				<text wrapMode="none" flexShrink={0} fg={color.dim}>
					{SHOWS_LEAD}
				</text>
				<For each={shows()}>
					{(panel) => (
						<text
							wrapMode="none"
							flexShrink={0}
							selectable={false}
							onMouseDown={(event) => {
								if (isLeftButton(event)) {
									props.onShow?.(panel);
								}
							}}
						>
							<span> </span>
							<span style={{ fg: color.text, bg: color.mineBg }}>
								{shownAgainText(panel)}
							</span>
						</text>
					)}
				</For>
			</Show>
		</box>
	);
};
