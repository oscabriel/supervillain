import { CliRenderEvents, NativeImage } from "@opentui/core";
import type { BoxRenderable, CliRenderer } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { columnLabel } from "@supervillain/domain";
import { createMemo, createSignal, Index, onCleanup } from "solid-js";

import { MAP_FRAME } from "./map.ts";
import type { Focus } from "./map.ts";
import { boxClick } from "./mouse.ts";
import { fittedTitle } from "./panels.ts";
import {
	cellPixels,
	GUTTER,
	LABEL_ROWS,
	outOfView,
	paintPicture,
	pictureSquareAt,
	pictureWindow,
	SQUARE,
	tileFor,
} from "./picture.ts";
import type { CellPixels } from "./picture.ts";
import { color } from "./theme.ts";
import type { MapView } from "./view.ts";

const showsPictures = (renderer: CliRenderer): boolean =>
	renderer.capabilities?.kitty_graphics === true &&
	renderer.capabilities.multiplexer === "none";

export const usePicturesShown = (): (() => boolean) => {
	const renderer = useRenderer();
	const [shown, setShown] = createSignal(showsPictures(renderer));

	const update = () => {
		setShown(showsPictures(renderer));
	};

	renderer.on(CliRenderEvents.CAPABILITIES, update);

	onCleanup(() => {
		renderer.off(CliRenderEvents.CAPABILITIES, update);
	});

	return shown;
};

const isWindowPixels = (sequence: string) =>
	sequence.startsWith("\u001B[4;") && sequence.endsWith("t");

export const useCellPixels = (): (() => CellPixels | undefined) => {
	const renderer = useRenderer();

	const read = () =>
		cellPixels(
			renderer.resolution,
			renderer.terminalWidth,
			renderer.terminalHeight
		);

	const [cell, setCell] = createSignal(read(), {
		equals: (a, b) => a?.width === b?.width && a?.height === b?.height,
	});

	const update = () => {
		const now = read();

		if (now !== undefined) {
			setCell(now);
		}
	};

	const watch = (sequence: string) => {
		if (isWindowPixels(sequence)) {
			queueMicrotask(update);
		}

		return false;
	};

	renderer.prependInputHandler(watch);
	onCleanup(() => {
		renderer.removeInputHandler(watch);
	});

	return cell;
};

export const PictureMap = (props: {
	map: MapView;
	height: number;
	width?: number | undefined;
	focus?: Focus | undefined;
	mark?: string | undefined;
	onSquare?: ((square: Focus) => void) | undefined;
	onTitle?: (() => void) | undefined;
}) => {
	const terminal = useTerminalDimensions();
	const size = () => ({ width: props.width ?? terminal().width });
	const renderer = useRenderer();
	let box: BoxRenderable | undefined;
	renderer.kittyImageTransport = "zlib";

	const win = createMemo(
		() =>
			pictureWindow(
				props.map,
				Math.floor((size().width - MAP_FRAME.width - GUTTER) / SQUARE.cols),
				Math.floor(
					(props.height - MAP_FRAME.height - LABEL_ROWS) / SQUARE.rows
				),
				props.focus
			),
		undefined,
		{
			equals: (a, b) =>
				a.x0 === b.x0 &&
				a.y0 === b.y0 &&
				a.cols === b.cols &&
				a.rows === b.rows,
		}
	);

	const cell = useCellPixels();
	const tile = createMemo(() => tileFor(cell(), win().cols * win().rows));

	const image = createMemo((previous: NativeImage | undefined) => {
		previous?.dispose();

		return NativeImage.decode(paintPicture(props.map, win(), tile()).png());
	});

	onCleanup(() => {
		image().dispose();
	});

	const columns = createMemo(() => {
		const w = win();
		let line = " ".repeat(GUTTER);

		for (let sx = 0; sx < w.cols; sx += 1) {
			line += ` ${columnLabel(w.x0 + sx).padEnd(SQUARE.cols - 1)}`;
		}

		return line;
	});

	const hidden = createMemo(() => {
		const out = outOfView(props.map, win());

		return out.length === 0
			? ""
			: ` out of view: ${out.map((t) => t.mark).join(" ")} `;
	});

	const title = () =>
		fittedTitle(
			[` ${props.map.name} · /view text `, ` ${props.map.name} `],
			props.mark,
			size().width
		);

	const click = boxClick(
		() => box,
		title,
		props.onTitle,
		(col, row) => {
			const at = pictureSquareAt(
				win(),
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
			bottomTitle={hidden()}
			bottomTitleAlignment="right"
			height={props.height}
			flexShrink={0}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={color.dim} wrapMode="none">
				{columns()}
			</text>
			<box flexDirection="row">
				<box width={GUTTER} flexDirection="column">
					<Index each={Array.from({ length: win().rows * SQUARE.rows })}>
						{(_, i) => (
							<text fg={color.dim} wrapMode="none">
								{i % SQUARE.rows === 0
									? String(win().y0 + i / SQUARE.rows + 1).padStart(2)
									: ""}
							</text>
						)}
					</Index>
				</box>
				<image
					width={win().cols * SQUARE.cols}
					height={win().rows * SQUARE.rows}
					fit="fill"
					protocol="kitty"
					source={image()}
				/>
			</box>
		</box>
	);
};
