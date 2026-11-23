import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { listIfDefined } from "@supervillain/domain";
import { createMemo, For } from "solid-js";

import { kept } from "./keep.ts";
import { MAP_FRAME, mapLayout, squareAt } from "./map.ts";
import type { Focus, MapSegment, MapTone } from "./map.ts";
import { boxClick } from "./mouse.ts";
import { fittedTitle } from "./panels.ts";
import { color } from "./theme.ts";
import type { MapView } from "./view.ts";

const TONES: Readonly<Record<MapTone, string>> = {
	label: color.dim,
	floor: color.floor,
	wall: color.wall,
	difficult: color.difficult,
	terrain: color.terrain,
	heroes: color.heroes,
	director: color.director,
	mine: color.you,
	dead: color.dim,
};

const TOKENS: ReadonlySet<MapTone> = new Set(["heroes", "director", "mine"]);

const BODIES: Readonly<Partial<Record<MapTone, string>>> = {
	heroes: color.heroesBody,
	director: color.directorBody,
	mine: color.youBody,
	dead: color.deadBody,
};

const groundOf = (s: MapSegment) => {
	const body = s.body === true ? BODIES[s.tone] : undefined;

	if (body !== undefined) {
		return { bg: body };
	}

	return s.reach === true ? { bg: color.reach } : {};
};

const styleOf = (s: MapSegment) => ({
	fg: TONES[s.tone],
	...groundOf(s),
	bold: TOKENS.has(s.tone),
	underline: s.acting ?? false,
});

export const MapPane = (props: {
	map: MapView;
	height: number;
	width?: number | undefined;
	focus?: Focus | undefined;
	hint?: string | undefined;
	mark?: string | undefined;
	onSquare?: ((square: Focus) => void) | undefined;
	onTitle?: (() => void) | undefined;
}) => {
	const terminal = useTerminalDimensions();
	const size = () => ({ width: props.width ?? terminal().width });
	let box: BoxRenderable | undefined;

	const layout = createMemo((was?: ReturnType<typeof mapLayout>) => {
		const laid = mapLayout(
			props.map,
			size().width - MAP_FRAME.width,
			props.height - MAP_FRAME.height,
			props.focus
		);

		return { ...laid, lines: kept(was?.lines, laid.lines) };
	});

	const title = () =>
		fittedTitle(
			[
				...listIfDefined(props.hint, (hint) => [
					`${layout().title.trimEnd()} · ${hint} `,
				]),
				layout().title,
				` map · ${props.map.name} `,
			],
			props.mark,
			size().width
		);

	const click = boxClick(
		() => box,
		title,
		props.onTitle,
		(col, row) => {
			const at = squareAt(
				layout().squares,
				col - MAP_FRAME.width / 2,
				row - MAP_FRAME.height / 2
			);

			if (at !== undefined) {
				props.onSquare?.(at);
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
			borderColor={color.border}
			title={title()}
			bottomTitle={layout().bottomTitle}
			bottomTitleAlignment="right"
			height={props.height}
			flexShrink={0}
			paddingLeft={1}
			paddingRight={1}
		>
			<For each={layout().lines}>
				{(line) => (
					<text wrapMode="none" selectable={false}>
						<For each={line}>
							{(s) => <span style={styleOf(s)}>{s.text}</span>}
						</For>
					</text>
				)}
			</For>
		</box>
	);
};
