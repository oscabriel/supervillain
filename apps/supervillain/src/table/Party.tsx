import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, For } from "solid-js";

import { kept } from "./keep.ts";
import { boxClick } from "./mouse.ts";
import { marked } from "./panels.ts";
import { PARTY_FRAME, partyRows } from "./party.ts";
import type { PartySegment, PartyTone } from "./party.ts";
import { color } from "./theme.ts";
import type { PartyMember } from "./view.ts";

const TONES: Readonly<Record<PartyTone, string>> = {
	name: color.bright,
	mine: color.you,
	player: color.text,
	healthy: color.healthy,
	winded: color.winded,
	dying: color.dying,
	dim: color.dim,
	tag: color.notice,
};

const styleOf = (s: PartySegment) => ({
	fg: TONES[s.tone],
	bold: s.tone === "name" || s.tone === "mine",
});

export const Party = (props: {
	members: ReadonlyArray<PartyMember>;
	height: number;
	width?: number | undefined;
	mark?: string | undefined;
	onPick?: ((id: string) => void) | undefined;
	onTitle?: (() => void) | undefined;
}) => {
	const terminal = useTerminalDimensions();
	const width = () => props.width ?? terminal().width;
	let box: BoxRenderable | undefined;

	const rows = createMemo((was?: ReturnType<typeof partyRows>) =>
		kept(
			was,
			partyRows(props.members, width() - PARTY_FRAME.width).slice(
				0,
				Math.max(0, props.height - PARTY_FRAME.height)
			)
		)
	);

	const more = () =>
		props.members.length - rows().length > 0
			? ` +${props.members.length - rows().length} more `
			: "";

	const title = () => marked(` party ${props.members.length} `, props.mark);

	const click = boxClick(
		() => box,
		title,
		props.onTitle,
		(_col, row) => {
			const picked = rows()[row - PARTY_FRAME.height / 2];

			if (picked !== undefined) {
				props.onPick?.(picked.id);
			}
		}
	);

	return (
		<box
			ref={(el: BoxRenderable) => {
				box = el;
			}}
			onMouseDown={click}
			border
			borderColor={color.heroes}
			title={title()}
			bottomTitle={more()}
			bottomTitleAlignment="right"
			height={props.height}
			flexShrink={0}
			paddingLeft={1}
			paddingRight={1}
		>
			<For each={rows()}>
				{(row) => (
					<text wrapMode="none" selectable={false}>
						<For each={row.segments}>
							{(s) => <span style={styleOf(s)}>{s.text}</span>}
						</For>
					</text>
				)}
			</For>
		</box>
	);
};
