import type {
	BoxRenderable,
	MouseEvent,
	ScrollBoxRenderable,
} from "@opentui/core";
import { For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { MapPane } from "./MapPane.tsx";
import { boxClick, isLeftButton, wheel } from "./mouse.ts";
import { fittedTitle } from "./panels.ts";
import type { ProseLine, ProseTone } from "./prose.ts";
import {
	cardPlan,
	codexLabel,
	pinnedColumns,
	STAGE_FRAME,
	stageTitle,
} from "./stage.ts";
import type { CardPlan, CodexState, StagePlan } from "./stage.ts";
import { color } from "./theme.ts";
import type { CodexEntry, Prose, StageView } from "./view.ts";

const PROSE: Readonly<Record<ProseTone, string>> = {
	text: color.text,
	heading: color.bright,
	quote: color.dim,
	pre: color.terrain,
	list: color.text,
};

const KIND_TITLE: Readonly<Record<CodexEntry["kind"], string>> = {
	scene: "scene",
	npc: "npc",
	handout: "handout",
	item: "item",
	ancestry: "ancestry",
	class: "class",
	ability: "ability",
	party: "party",
	monster: "creature",
};

const entryColour = (entry: CodexEntry, chosen: boolean): string => {
	if (chosen) {
		return color.bright;
	}

	return entry.tier === "on-table" ? color.tierTable : color.text;
};

const left = (fn: () => void) => (event: MouseEvent) => {
	if (!isLeftButton(event) || event.defaultPrevented) {
		return;
	}

	event.preventDefault();
	fn();
};

const ProseRows = (props: { lines: ReadonlyArray<ProseLine> }) => (
	<For each={props.lines}>
		{(line) => (
			<text wrapMode="none" flexShrink={0} selectable={false}>
				<span style={{ fg: PROSE[line.tone], bold: line.tone === "heading" }}>
					{line.text === "" ? " " : line.text}
				</span>
			</text>
		)}
	</For>
);

const Boxed = (props: {
	title: string;
	fg: string;
	lines: ReadonlyArray<ProseLine>;
	tint?: string;
}) => (
	<box
		border
		borderColor={props.fg}
		title={props.title}
		marginTop={1}
		flexShrink={0}
		flexDirection="column"
		paddingLeft={1}
		paddingRight={1}
	>
		<For each={props.lines}>
			{(line) => (
				<text wrapMode="none" flexShrink={0} selectable={false}>
					<span
						style={{
							fg: props.tint ?? PROSE[line.tone],
							bold: line.tone === "heading",
						}}
					>
						{line.text === "" ? " " : line.text}
					</span>
				</text>
			)}
		</For>
	</box>
);

export const StageCard = (props: {
	plan: CardPlan;
	width: number;
	scene?: boolean;
}) => {
	const inner = () => props.width - 4;

	const tier = () =>
		props.plan.card.tier === "on-table" ? color.tierTable : color.tierCodex;

	return (
		<box
			border
			borderColor={props.scene === true ? color.brand : tier()}
			title={` ${KIND_TITLE[props.plan.card.kind]} `}
			width={props.width}
			height={props.plan.height}
			flexShrink={0}
			flexDirection="column"
			paddingLeft={1}
			paddingRight={1}
		>
			<text wrapMode="none" flexShrink={0} selectable={false}>
				<span style={{ fg: color.bright, bold: true }}>{props.plan.head}</span>
			</text>
			<Show when={props.plan.tags}>
				{(tags: Accessor<string>) => (
					<text fg={color.dim} wrapMode="none" flexShrink={0}>
						{tags()}
					</text>
				)}
			</Show>
			<Show when={props.plan.readAloud.length > 0}>
				<Boxed
					title=" read aloud "
					fg={color.readAloud}
					tint={color.readAloud}
					lines={props.plan.readAloud}
				/>
			</Show>
			<Show when={props.plan.body.length > 0}>
				<box marginTop={1} flexDirection="column" flexShrink={0}>
					<ProseRows lines={props.plan.body} />
				</box>
			</Show>
			<Show when={props.plan.art.length > 0}>
				<box marginTop={1} flexDirection="column" flexShrink={0}>
					<text fg={color.terrain} wrapMode="none" selectable={false}>
						{props.plan.art.join("\n")}
					</text>
				</box>
			</Show>
			<Show when={props.plan.map}>
				{(map) => (
					<box marginTop={1} flexShrink={0}>
						<MapPane map={map()} height={props.plan.mapRows} width={inner()} />
					</box>
				)}
			</Show>
			<Show when={props.plan.notes.length > 0}>
				<Boxed
					title=" GM notes · only you see these "
					fg={color.gm}
					lines={props.plan.notes}
				/>
			</Show>
		</box>
	);
};

const heading = (label: string, width: number) => (
	<text fg={color.border} wrapMode="none" flexShrink={0} selectable={false}>
		<span style={{ fg: color.dim }}>{label}</span>
		{` ${"─".repeat(Math.max(0, width - 1 - Bun.stringWidth(label)))}`}
	</text>
);

const chip = (label: string, fg: string, onClick: () => void): JSX.Element => (
	<box onMouseDown={left(onClick)} flexShrink={0} marginRight={1}>
		<text selectable={false} wrapMode="none">
			<span style={{ fg, bg: color.mineBg }}>{` ${label} `}</span>
		</text>
	</box>
);

export const Stage = (props: {
	stage: StageView;
	plan: StagePlan;
	height: number;
	width: number;
	notes?: ((key: string) => Prose | undefined) | undefined;
	codex?: CodexState | undefined;
	mark?: string | undefined;
	onCodex?: ((codex: CodexState | undefined) => void) | undefined;
	onTitle?: (() => void) | undefined;
	ref?: (el: ScrollBoxRenderable) => void;
}) => {
	let box: BoxRenderable | undefined;
	const inner = () => props.width - STAGE_FRAME.width;
	const columns = () => pinnedColumns(inner());

	const cardWidth = () =>
		columns() === 1 ? inner() : Math.floor((inner() - 1) / 2);

	const title = () =>
		fittedTitle([stageTitle(props.stage), " stage "], props.mark, props.width);

	const picked = (): CodexEntry | undefined => {
		const key = props.codex?.key;

		return key === undefined
			? undefined
			: props.stage.codex.find((e) => e.key === key);
	};

	const empty = () =>
		props.plan.scene === undefined &&
		props.plan.pinned.length === 0 &&
		props.plan.trackers.length === 0 &&
		props.plan.recap.length === 0;

	return (
		<box
			ref={(el: BoxRenderable) => {
				box = el;
			}}
			onMouseDown={boxClick(() => box, title, props.onTitle)}
			border
			borderColor={props.codex === undefined ? color.border : color.tierCodex}
			title={title()}
			height={props.height}
			width={props.width}
			flexShrink={0}
			flexDirection="column"
			paddingLeft={1}
			paddingRight={1}
		>
			<scrollbox
				ref={(el: ScrollBoxRenderable) => props.ref?.(el)}
				scrollAcceleration={wheel}
				flexGrow={1}
			>
				<Show
					when={props.codex}
					fallback={
						<>
							<Show when={props.stage.codex.length > 0}>
								<box flexDirection="row" height={1} flexShrink={0}>
									{chip(
										`codex ${props.stage.codex.length}`,
										color.tierCodex,
										() => {
											props.onCodex?.({});
										}
									)}
								</box>
							</Show>
							<Show when={empty()}>
								<text fg={color.dim} wrapMode="none" flexShrink={0}>
									nothing is on the stage yet
								</text>
							</Show>
							<Show when={props.plan.scene}>
								{(scene: Accessor<CardPlan>) => (
									<StageCard plan={scene()} width={inner()} scene />
								)}
							</Show>
							<For each={props.plan.pinned}>
								{(row) => (
									<box flexDirection="row" flexShrink={0}>
										<For each={row}>
											{(card, i) => (
												<box marginLeft={i() === 0 ? 0 : 1} flexShrink={0}>
													<StageCard plan={card} width={cardWidth()} />
												</box>
											)}
										</For>
									</box>
								)}
							</For>
							<Show when={props.plan.trackers.length > 0}>
								{heading("trackers", inner())}
								<For each={props.plan.trackers}>
									{(line) => (
										<text fg={color.tracker} wrapMode="none" flexShrink={0}>
											{line}
										</text>
									)}
								</For>
							</Show>
							<Show when={props.plan.recap.length > 0}>
								{heading("recap", inner())}
								<For each={props.plan.recap}>
									{(line) => (
										<text fg={color.dim} wrapMode="none" flexShrink={0}>
											{line}
										</text>
									)}
								</For>
							</Show>
						</>
					}
				>
					<box flexDirection="row" height={1} flexShrink={0}>
						{chip("← stage", color.bright, () => {
							props.onCodex?.(undefined);
						})}
						<text fg={color.dim} wrapMode="none">
							{props.stage.codex.length === 0
								? "the codex is empty"
								: "click a card to read it · Esc closes"}
						</text>
					</box>
					<For each={props.stage.codex}>
						{(entry) => (
							<box
								height={1}
								flexShrink={0}
								onMouseDown={left(() => {
									props.onCodex?.({ key: entry.key });
								})}
							>
								<text
									wrapMode="none"
									selectable={false}
									fg={entryColour(entry, picked()?.key === entry.key)}
								>
									{`${picked()?.key === entry.key ? "▸" : " "}${codexLabel(entry, inner() - 1)}`}
								</text>
							</box>
						)}
					</For>
					<Show when={picked()}>
						{(entry: Accessor<CodexEntry>) => (
							<box marginTop={1} flexShrink={0}>
								<StageCard
									plan={cardPlan(
										entry().card,
										inner(),
										props.notes?.(entry().key)
									)}
									width={inner()}
								/>
							</box>
						)}
					</Show>
				</Show>
			</scrollbox>
		</box>
	);
};
