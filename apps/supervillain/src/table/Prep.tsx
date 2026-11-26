import { NativeImage } from "@opentui/core";
import type {
	BoxRenderable,
	MouseEvent,
	ScrollBoxRenderable,
} from "@opentui/core";
import { charsOf } from "@supervillain/domain";
import { createSignal, For, Index, onCleanup, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { DINGS_ATLAS } from "./atlas/dings.ts";
import { boxClick, isLeftButton, wheel } from "./mouse.ts";
import { fittedTitle } from "./panels.ts";
import { Canvas, figureOf, SIDES, tileFor } from "./picture.ts";
import { useCellPixels } from "./PictureMap.tsx";
import { chipLabel, chipRows, figureText, stageEntries } from "./prep.ts";
import type { PrepArmed, PrepNext, StageEntry } from "./prep.ts";
import { color } from "./theme.ts";
import type { PrepFigure, PrepItem, PrepSection, PrepView } from "./view.ts";

const TITLES = [" GM prep ", " prep "];

const NEXT = color.brand;

const READY = color.healthy;

const PLAY = ["█▄  ", "███▄", "███▀", "█▀  "];

const SLOT_ROWS = 4;

const PROBLEMS_SHOWN = 4;

const TIER_BADGE: Readonly<
	Record<NonNullable<StageEntry["tier"]>, { text: string; fg: string }>
> = {
	"on-table": { text: "◆ table", fg: color.tierTable },
	"in-codex": { text: "◇ codex", fg: color.tierCodex },
};

const left = (fn: (() => void) | undefined) => (event: MouseEvent) => {
	if (fn === undefined || !isLeftButton(event) || event.defaultPrevented) {
		return;
	}

	event.preventDefault();
	fn();
};

const fit = (s: string, n: number) =>
	Bun.stringWidth(s) <= n
		? s
		: `${charsOf(s)
				.slice(0, Math.max(0, n - 1))
				.join("")}…`;

const SHORT_END = / (?<end>\S{1,3})$/u;

const nameColour = (marked: boolean, dim: boolean) => {
	if (marked) {
		return color.bright;
	}

	return dim ? color.dim : color.text;
};

const stepMark = (done: boolean, now: boolean) => {
	if (done) {
		return { glyph: "◆", fg: READY, label: color.dim };
	}

	return now
		? { glyph: "◈", fg: color.notice, label: color.bright }
		: { glyph: "◇", fg: color.border, label: color.border };
};

const fitName = (s: string, n: number) => {
	const end = SHORT_END.exec(s)?.groups?.end;

	if (Bun.stringWidth(s) <= n || end === undefined) {
		return fit(s, n);
	}

	return `${fit(s.slice(0, -end.length - 1), n - end.length - 1)} ${end}`;
};

const added = (next: PrepNext) => (next.kind === "add" ? `+${next.n}  ` : "");

const sideColour = (figure: PrepFigure) =>
	figure.side === "heroes" ? color.heroes : color.director;

export const Prep = (props: {
	view: PrepView;
	next: PrepNext | undefined;
	armed: PrepArmed | undefined;
	width: number;
	mark: string;
	pictures: boolean;
	onSend: (line: string, then?: (refused: string | undefined) => void) => void;
	onFill: (line: string) => void;
	onAll: (lines: ReadonlyArray<string>) => void;
	stage?: ReadonlyArray<PrepSection>;
	sync?: PrepItem | undefined;
	problems?: ReadonlyArray<string>;
	onArm: (armed: PrepArmed | undefined) => void;
	onCount: (item: PrepItem, by: 1 | -1) => void;
	onStart: (line: string) => void;
	onTitle: () => void;
	ref?: (el: ScrollBoxRenderable) => void;
}) => {
	let box: BoxRenderable | undefined;
	const title = () => fittedTitle(TITLES, props.mark, props.width);
	const inner = () => props.width - 5;
	const [mapsOpen, setMapsOpen] = createSignal(false);
	const cell = useCellPixels();
	const images = new Map<string, NativeImage>();
	onCleanup(() => {
		for (const image of images.values()) {
			image.dispose();
		}
	});

	const image = (figure: PrepFigure, squares: number) => {
		const t = tileFor(cell());
		const key = `${figure.side}:${figure.id}:${squares}:${t.width}x${t.height}`;
		const had = images.get(key);

		if (had !== undefined) {
			return had;
		}

		const w = t.width * squares;
		const h = t.height * squares;
		const scale = Math.max(1, Math.floor(Math.min(w / 8, h / 12)));
		const tone = SIDES[figure.side];
		const c = new Canvas(w, h);
		c.rect(0, 0, w, h, [
			Math.round(14 + (tone[0] - 14) * 0.18),
			Math.round(15 + (tone[1] - 15) * 0.18),
			Math.round(18 + (tone[2] - 18) * 0.18),
		]);
		const glyph = DINGS_ATLAS[figureOf(figure)];
		c.glyph(
			glyph,
			Math.floor((w - 8 * scale) / 2),
			Math.floor((h - 12 * scale) / 2),
			scale,
			tone
		);
		const made = NativeImage.decode(c.png());
		images.set(key, made);

		return made;
	};

	const token = (figure: PrepFigure): JSX.Element =>
		props.pictures ? (
			<image
				width={4}
				height={2}
				fit="fill"
				protocol="kitty"
				source={image(figure, 1)}
			/>
		) : (
			<text
				fg={sideColour(figure)}
				wrapMode="none"
				flexShrink={0}
				selectable={false}
			>
				{figureText(DINGS_ATLAS[figureOf(figure)]).join("\n")}
			</text>
		);

	const bar = (on: boolean, rows: number) => (
		<text fg={NEXT} wrapMode="none" flexShrink={0} selectable={false}>
			{Array.from({ length: rows }, () => (on ? "▌" : " ")).join("\n")}
		</text>
	);

	const entry = (o: {
		figure: PrepFigure;
		name: string;
		note?: () => JSX.Element;
		marked?: () => boolean;
		dim?: boolean;
		onClick: () => void;
		extra?: () => JSX.Element;
	}) => (
		<box
			flexDirection="row"
			height={2}
			flexShrink={0}
			onMouseDown={left(o.onClick)}
		>
			{bar(o.marked?.() ?? false, 2)}
			{token(o.figure)}
			<box flexDirection="column" marginLeft={1} flexGrow={1} minWidth={0}>
				<text
					wrapMode="none"
					selectable={false}
					fg={nameColour(o.marked?.() === true, o.dim === true)}
				>
					{fitName(o.name, inner() - 6 - (o.extra === undefined ? 0 : 3))}
				</text>
				<text wrapMode="none" selectable={false}>
					{o.note?.() ?? ""}
				</text>
			</box>
			{o.extra?.()}
		</box>
	);

	const heading = (label: string, count?: number) => {
		const counted = count === undefined ? "" : ` ${count}`;

		return (
			<text
				fg={color.border}
				wrapMode="none"
				flexShrink={0}
				marginTop={1}
				selectable={false}
			>
				<span style={{ fg: color.dim }}>{label}</span>
				<span style={{ fg: color.notice }}>{counted}</span>
				{` ${"─".repeat(Math.max(0, inner() - 1 - Bun.stringWidth(label + counted)))}`}
			</text>
		);
	};

	const chip = (
		label: string,
		onClick: () => void,
		fg: string = color.bright
	) => (
		<box onMouseDown={left(onClick)} flexShrink={0} marginLeft={1}>
			<text selectable={false} wrapMode="none">
				<span style={{ fg, bg: color.mineBg }}>{` ${label} `}</span>
			</text>
		</box>
	);

	const sendItem = (item: PrepItem) => {
		if (item.lines !== undefined) {
			props.onAll(item.lines);
		} else if (item.kind === "fill") {
			props.onFill(item.line);
		} else {
			props.onSend(item.line);
		}
	};

	const itemChip = (item: PrepItem, label: string) =>
		chip(
			label,
			() => {
				sendItem(item);
			},
			item.lines === undefined ? color.bright : READY
		);

	const problems = () => props.problems ?? [];

	const stageCard = (card: StageEntry) => {
		const labels = card.items.map(chipLabel);
		const badge = card.tier === undefined ? undefined : TIER_BADGE[card.tier];

		const badgeWidth =
			badge === undefined ? 0 : Bun.stringWidth(badge.text) + 1;

		return (
			<box flexDirection="column" flexShrink={0}>
				<box flexDirection="row" height={1} flexShrink={0}>
					<text
						wrapMode="none"
						fg={color.text}
						flexGrow={1}
						minWidth={0}
						selectable={false}
					>
						{fitName(card.name, inner() - badgeWidth)}
					</text>
					<Show when={badge}>
						{(b: Accessor<{ text: string; fg: string }>) => (
							<text wrapMode="none" flexShrink={0} fg={b().fg}>
								{` ${b().text}`}
							</text>
						)}
					</Show>
				</box>
				<For each={chipRows(labels, inner())}>
					{(row) => (
						<box flexDirection="row" height={1} flexShrink={0}>
							<For each={row}>
								{(i) => {
									const item = card.items[i];

									return item === undefined
										? undefined
										: itemChip(item, labels[i] ?? item.label);
								}}
							</For>
						</box>
					)}
				</For>
			</box>
		);
	};

	const ready = () =>
		props.next === undefined &&
		"line" in props.view.start &&
		props.view.steps.every((s) => s.done);

	const startLine = () =>
		"line" in props.view.start ? props.view.start.line : undefined;

	const queued = () =>
		props.view.place.filter(
			(t) => props.next?.kind !== "place" || t.id !== props.next.id
		);

	const maps = () => props.view.maps;
	const showMaps = () => maps().loaded === undefined || mapsOpen();

	const named = () =>
		props.view.steps.reduce((w, s) => w + 3 + Bun.stringWidth(s.label), 3) <=
		inner() + 1;

	const pip = (
		label: string,
		done: boolean,
		now: boolean,
		o: { always?: boolean; onClick?: () => void } = {}
	) => (
		<text
			wrapMode="none"
			flexShrink={0}
			marginRight={1}
			selectable={false}
			onMouseDown={left(o.onClick)}
		>
			<span style={{ fg: stepMark(done, now).fg }}>
				{stepMark(done, now).glyph}
			</span>
			<span style={{ fg: stepMark(done, now).label }}>
				{named() || now || o.always === true ? ` ${label}` : ""}
			</span>
		</text>
	);

	return (
		<box
			ref={(el: BoxRenderable) => {
				box = el;
			}}
			onMouseDown={boxClick(() => box, title, props.onTitle)}
			border
			borderColor={props.next === undefined ? color.gm : NEXT}
			title={title()}
			width={props.width}
			flexShrink={0}
			flexDirection="column"
			paddingLeft={1}
			paddingRight={1}
		>
			<box flexDirection="row" height={1} flexShrink={0}>
				<For each={props.view.steps}>
					{(step, i) =>
						pip(
							step.label,
							step.done,
							!step.done && props.view.steps.slice(0, i()).every((s) => s.done)
						)
					}
				</For>
				{pip("▶", false, ready(), {
					always: true,
					onClick: () => {
						const line = startLine();

						if (line !== undefined) {
							props.onStart(line);
						}
					},
				})}
			</box>

			<box
				marginTop={1}
				height={SLOT_ROWS}
				flexShrink={0}
				flexDirection="column"
			>
				<Show when={props.next}>
					{(next: Accessor<PrepNext>) => (
						<box
							flexDirection="row"
							flexShrink={0}
							height={props.pictures ? 4 : 2}
						>
							{bar(true, props.pictures ? 4 : 2)}
							<Show when={props.pictures} fallback={token(next().figure)}>
								<image
									width={8}
									height={4}
									fit="fill"
									protocol="kitty"
									source={image(next().figure, 2)}
								/>
							</Show>
							<box
								flexDirection="column"
								marginLeft={1}
								justifyContent="center"
								flexGrow={1}
								minWidth={0}
							>
								<text fg={color.bright} wrapMode="none" selectable={false}>
									{fitName(next().name, inner() - (props.pictures ? 10 : 6))}
								</text>
								<text wrapMode="none" selectable={false}>
									<span style={{ fg: color.notice }}>{added(next())}</span>
									<span style={{ fg: NEXT }}>⌖</span>
								</text>
							</box>
						</box>
					)}
				</Show>
				<Show when={ready()}>
					<box
						flexDirection="row"
						flexShrink={0}
						onMouseDown={left(() => {
							const line = startLine();

							if (line !== undefined) {
								props.onStart(line);
							}
						})}
					>
						<text fg={READY} wrapMode="none" selectable={false}>
							{PLAY.join("\n")}
						</text>
						<box flexDirection="column" justifyContent="center" marginLeft={1}>
							<text fg={READY} wrapMode="none" selectable={false}>
								fight
							</text>
						</box>
					</box>
				</Show>
				<Show when={"note" in props.view.start && props.next === undefined}>
					<text fg={color.dim} wrapMode="none" flexShrink={0}>
						{"note" in props.view.start ? props.view.start.note : ""}
					</text>
				</Show>
			</box>

			<scrollbox
				ref={(el) => props.ref?.(el)}
				scrollAcceleration={wheel}
				flexGrow={1}
			>
				<Show when={problems().length > 0}>
					<text
						fg={color.dying}
						wrapMode="none"
						flexShrink={0}
						marginTop={1}
						selectable={false}
					>
						{fit(
							`⚠ ${problems().length === 1 ? "a file has a problem" : `${problems().length} file problems`}; the table keeps the last good files`,
							inner()
						)}
					</text>
					<For each={problems().slice(0, PROBLEMS_SHOWN)}>
						{(problem) => (
							<text fg={color.notice} wrapMode="word" flexShrink={0}>
								{problem}
							</text>
						)}
					</For>
					<Show when={problems().length > PROBLEMS_SHOWN}>
						<text fg={color.dim} wrapMode="none" flexShrink={0}>
							{`+${problems().length - PROBLEMS_SHOWN} more · supervillain check lists them`}
						</text>
					</Show>
				</Show>
				<Show when={props.sync}>
					{(sync: Accessor<PrepItem>) => (
						<>
							{heading("sheets changed")}
							<text fg={color.dim} wrapMode="none" flexShrink={0}>
								{fit(sync().label, inner())}
							</text>
							<box flexDirection="row" height={1} flexShrink={0}>
								{chip(
									"↻ sync",
									() => {
										sendItem(sync());
									},
									color.notice
								)}
							</box>
						</>
					)}
				</Show>
				<Show
					when={showMaps()}
					fallback={
						<>
							{heading("map")}
							<box flexDirection="row" height={1} flexShrink={0}>
								<text wrapMode="none" fg={color.text} flexGrow={1} minWidth={0}>
									{fit(maps().loaded?.name ?? "", inner() - 9)}
								</text>
								<Show when={maps().loaded?.again}>
									{(again: Accessor<string>) =>
										chip(
											"↻",
											() => {
												props.onSend(again());
											},
											color.notice
										)
									}
								</Show>
								{chip(
									"⇄",
									() => {
										setMapsOpen(true);
									},
									color.dim
								)}
							</box>
						</>
					}
				>
					{heading("maps")}
					<For each={maps().items}>
						{(item) => (
							<box
								flexDirection="row"
								height={1}
								flexShrink={0}
								onMouseDown={left(() => {
									setMapsOpen(false);

									if (item.kind === "fill") {
										props.onFill(item.line);
									} else {
										props.onSend(item.line);
									}
								})}
							>
								<text wrapMode="none" selectable={false}>
									<span
										style={{
											fg: item.line.startsWith("/map new")
												? color.notice
												: color.text,
										}}
									>
										{item.line.startsWith("/map new") ? "+ " : "  "}
										{fit(item.label.replace(/^New,? ?/u, ""), inner() - 2)}
									</span>
								</text>
							</box>
						)}
					</For>
				</Show>

				<Show when={queued().length > 0}>
					{heading("to place", queued().length)}
					<For each={queued()}>
						{(t) =>
							entry({
								figure: t.figure,
								name: t.name,
								note: () => <span style={{ fg: color.notice }}>◌</span>,
								onClick: () => {
									props.onArm({ kind: "token", id: t.id });
								},
							})
						}
					</For>
				</Show>

				<Index each={props.view.sections}>
					{(section) => (
						<Show
							when={section().items.length > 0 || section().note !== undefined}
						>
							{heading(section().title)}
							<Show when={section().all}>
								{(all: Accessor<ReadonlyArray<string>>) => (
									<box flexDirection="row" height={1} flexShrink={0}>
										{chip(
											"+ all",
											() => {
												props.onAll(all());
											},
											color.heroes
										)}
									</box>
								)}
							</Show>
							<Show when={section().note}>
								{(note: Accessor<string>) => (
									<text fg={color.dim} wrapMode="none">
										{fit(note(), inner())}
									</text>
								)}
							</Show>
							<For each={section().items}>
								{(item) => {
									const counted = () => {
										const a = props.armed;

										return a?.kind === "count" && a.line === item.line
											? a.n
											: undefined;
									};

									const { figure } = item;

									if (figure === undefined) {
										return (
											<box flexDirection="row" height={1} flexShrink={0}>
												{chip(`+ ${item.label}`, () => {
													sendItem(item);
												})}
											</box>
										);
									}

									if (item.kind !== "count") {
										return entry({
											figure,
											name: item.label,
											dim: true,
											onClick: () => {
												if (item.kind === "fill") {
													props.onFill(item.line);

													return;
												}

												props.onArm({ kind: "token", id: figure.id });
												props.onSend(item.line, (refused) => {
													const a = props.armed;

													if (
														refused !== undefined &&
														a?.kind === "token" &&
														a.id === figure.id
													) {
														props.onArm(undefined);
													}
												});
											},
										});
									}

									return entry({
										figure,
										name: item.label,
										marked: () => counted() !== undefined,
										dim: item.note === undefined,
										note: () =>
											counted() === undefined ? (
												<span style={{ fg: color.director }}>
													{item.note ?? ""}
												</span>
											) : (
												<span
													style={{ fg: color.notice }}
												>{`+${counted()}`}</span>
											),
										onClick: () => {
											props.onCount(item, 1);
										},
										extra: () => (
											<Show when={counted() !== undefined}>
												{chip(
													"−",
													() => {
														props.onCount(item, -1);
													},
													color.notice
												)}
											</Show>
										),
									});
								}}
							</For>
						</Show>
					)}
				</Index>

				<For each={props.stage ?? []}>
					{(section) => (
						<Show when={section.items.length > 0}>
							{heading(section.title)}
							<For each={stageEntries(section.items)}>
								{(found) => stageCard(found)}
							</For>
						</Show>
					)}
				</For>
			</scrollbox>
		</box>
	);
};
