import type {
	FeedLine,
	GamePanel,
	GamePanelInput,
	GameView,
	PanelKey,
	TextRun,
} from "@supervillain/core";

import { terminology } from "./content.js";
import { playOf, sheetOfEnteredEvent } from "./model.js";
import type {
	DsCharacteristic,
	DsCharacterSheet,
	DsCommand,
	DsEvent,
	DsSide,
	DsState,
} from "./model.js";

const CHARACTERISTICS: readonly DsCharacteristic[] = [
	"might",
	"agility",
	"reason",
	"intuition",
	"presence",
];

const line = (...runs: readonly TextRun[]): FeedLine => ({ runs });
const nameRun = (text: string): TextRun => ({
	attrs: ["bold"],
	text,
	token: "accent",
});
const signed = (value: number): string =>
	value >= 0 ? `+${value}` : `−${Math.abs(value)}`;
const arithmeticModifier = (value: number): string =>
	value >= 0 ? `+ ${value}` : `− ${Math.abs(value)}`;
const mutedSuffix = (value: string | null): TextRun[] =>
	value === null ? [] : [{ text: ` · ${value}`, token: "muted" }];
const characteristicSummary = (sheet: DsCharacterSheet): string =>
	CHARACTERISTICS.map(
		(characteristic) =>
			`${terminology.characteristics[characteristic][0]}${signed(sheet.characteristics[characteristic])}`
	).join(" ");

const selectedCharacter = (
	input: GamePanelInput<DsState, DsCommand>,
	selectedIndex: number
): DsCharacterSheet | undefined => {
	const selected = input.state.encounter.combatants[selectedIndex];
	return selected === undefined
		? undefined
		: input.state.characters.find(
				(character) => character.name === selected.name
			);
};

const nextSideText = (state: Readonly<DsState>): string => {
	const { encounter } = state;
	if (encounter.lastSide === null) {
		return "either side";
	}
	const opposite: DsSide =
		encounter.lastSide === "heroes" ? "enemies" : "heroes";
	const oppositeCanAct = encounter.combatants.some(
		(combatant) =>
			combatant.side === opposite && combatant.actedRound !== encounter.round
	);
	return oppositeCanAct ? opposite : encounter.lastSide;
};

type PanelMode =
	| { readonly kind: "normal" }
	| {
			readonly kind: "roll";
			readonly characteristic: DsCharacteristic;
			readonly edges: number;
			readonly banes: number;
	  };

const createInitiativePanel = (): GamePanel<DsState, DsCommand> => {
	let selectedIndex = 0;
	let mode: PanelMode = { kind: "normal" };

	const renderHints = (): FeedLine => {
		if (mode.kind === "roll") {
			return line({
				text: `roll ${mode.characteristic} e${mode.edges} b${mode.banes} — enter rolls`,
				token: "muted",
			});
		}
		return line({ text: "↑/↓ select · s/e · t · a/m · r", token: "muted" });
	};

	const render = (input: GamePanelInput<DsState, DsCommand>): FeedLine[] => {
		const { combatants } = input.state.encounter;
		selectedIndex = Math.max(0, Math.min(selectedIndex, combatants.length - 1));
		const lines: FeedLine[] = [
			line({ text: terminology.panelTitle, token: "primary" }),
		];
		if (input.state.encounter.active) {
			lines.push(
				line({
					text: `round ${input.state.encounter.round} — ${nextSideText(input.state)} act next`,
					token: "primary",
				})
			);
			for (const [index, combatant] of combatants.entries()) {
				const selected = index === selectedIndex;
				const acted = combatant.actedRound === input.state.encounter.round;
				const side = combatant.side === "heroes" ? "H" : "E";
				lines.push(
					line(
						{
							text: `${selected ? "▸" : " "} ${acted ? "✓" : "·"} ${combatant.name} [${side}]`,
							token: selected ? "accent" : "primary",
						},
						...(combatant.conditions.length === 0
							? []
							: [
									{
										text: ` · ${combatant.conditions.join(", ")}`,
										token: "muted" as const,
									},
								])
					)
				);
			}
			const character = selectedCharacter(input, selectedIndex);
			if (character !== undefined) {
				lines.push(
					line({
						text: `${characteristicSummary(character)} · stamina ${character.stamina}`,
						token: "muted",
					})
				);
			}
		} else {
			lines.push(line({ text: "no encounter", token: "muted" }));
		}
		if (input.focused) {
			lines.push(renderHints());
		}
		return lines;
	};

	// oxlint-disable-next-line eslint/complexity -- branches directly implement the pinned modal key grammar.
	const onKey = (
		key: PanelKey,
		input: GamePanelInput<DsState, DsCommand>
	): boolean => {
		if (mode.kind === "roll") {
			const selectedCharacteristic = {
				a: "agility",
				i: "intuition",
				m: "might",
				p: "presence",
				r: "reason",
			} as const;
			const characteristic =
				selectedCharacteristic[key.name as keyof typeof selectedCharacteristic];
			if (characteristic !== undefined) {
				mode = { ...mode, characteristic };
				return true;
			}
			if (key.name === "e") {
				mode = { ...mode, edges: (mode.edges + 1) % 3 };
				return true;
			}
			if (key.name === "b") {
				mode = { ...mode, banes: (mode.banes + 1) % 3 };
				return true;
			}
			if (key.name === "return") {
				const character = selectedCharacter(input, selectedIndex);
				input.dispatch({
					banes: mode.banes,
					characteristic: mode.characteristic,
					edges: mode.edges,
					...(character === undefined ? {} : { characterName: character.name }),
					type: "ds.power-roll",
				});
				mode = { kind: "normal" };
				return true;
			}
			if (key.name === "escape") {
				mode = { kind: "normal" };
				return true;
			}
			return false;
		}
		const lastIndex = input.state.encounter.combatants.length - 1;
		if (key.name === "up") {
			selectedIndex = Math.max(0, selectedIndex - 1);
			return true;
		}
		if (key.name === "down") {
			selectedIndex = Math.min(Math.max(0, lastIndex), selectedIndex + 1);
			return true;
		}
		if (key.name === "s") {
			input.dispatch({ type: "ds.start-encounter" });
			return true;
		}
		if (key.name === "e") {
			input.dispatch({ type: "ds.end-encounter" });
			return true;
		}
		if (key.name === "t") {
			const selected = input.state.encounter.combatants[selectedIndex];
			if (selected !== undefined) {
				input.dispatch({ combatantId: selected.id, type: "ds.take-turn" });
			}
			return true;
		}
		if (key.name === "a" || key.name === "m") {
			const side: DsSide = key.name === "a" ? "heroes" : "enemies";
			input.requestMessageTask({
				submit: (name) => ({
					name: name.trim(),
					side,
					type: "ds.add-combatant",
				}),
				title: side === "heroes" ? "add hero" : "add enemy",
			});
			return true;
		}
		if (key.name === "r") {
			mode = { banes: 0, characteristic: "might", edges: 0, kind: "roll" };
			return true;
		}
		return false;
	};

	return { id: "ds-initiative", onKey, render, slot: "sidebar" };
};

const boundSheets = (input: GamePanelInput<DsState, DsCommand>) =>
	input.table.seats.flatMap((seat) => {
		if (seat.characterId === null) {
			return [];
		}
		const sheet = input.state.characters.find(
			(character) => character.name === seat.characterId
		);
		return sheet === undefined ? [] : [{ seat, sheet }];
	});

const createSheetPanel = (): GamePanel<DsState, DsCommand> => {
	let pageSeatId: string | null = null;

	const shownIndex = (
		input: GamePanelInput<DsState, DsCommand>,
		bound: ReturnType<typeof boundSheets>
	): number => {
		const ownIndex = bound.findIndex(
			({ seat }) => seat.actor === input.table.actor
		);
		const defaultIndex = ownIndex === -1 ? 0 : ownIndex;
		if (pageSeatId === null) {
			return defaultIndex;
		}
		const pageIndex = bound.findIndex(({ seat }) => seat.id === pageSeatId);
		return pageIndex === -1 ? defaultIndex : pageIndex;
	};

	const render = (input: GamePanelInput<DsState, DsCommand>): FeedLine[] => {
		const bound = boundSheets(input);
		if (bound.length === 0) {
			return [
				line({ text: "no character bound", token: "muted" }),
				...(input.focused
					? [line({ text: "[/] other sheets", token: "muted" })]
					: []),
			];
		}
		const shown = bound[shownIndex(input, bound)];
		if (shown === undefined) {
			return [];
		}
		const { sheet } = shown;
		const lines: FeedLine[] = [
			line(
				{ text: sheet.name, token: "accent" },
				{ text: ` — ${sheet.ancestry} ${sheet.className}`, token: "primary" },
				...mutedSuffix(sheet.kit)
			),
			line({ text: characteristicSummary(sheet), token: "primary" }),
			line({ text: `stamina ${sheet.stamina}`, token: "primary" }),
		];
		const play = playOf(input.state, sheet.name);
		if (play !== undefined) {
			lines.push(
				line({
					text: `${sheet.heroicResource.toLowerCase()} ${play.heroicResource}`,
					token: "primary",
				}),
				line({
					text: `recoveries ${play.recoveries}/${sheet.recoveries}`,
					token: "primary",
				}),
				line({ text: `surges ${play.surges}`, token: "primary" }),
				line({ text: `victories ${play.victories}`, token: "primary" })
			);
		}
		const combatant = input.state.encounter.active
			? input.state.encounter.combatants.find(
					(candidate) => candidate.name === sheet.name
				)
			: undefined;
		if (combatant !== undefined && combatant.conditions.length > 0) {
			lines.push(
				line({
					text: `conditions: ${combatant.conditions.join(", ")}`,
					token: "muted",
				})
			);
		}
		for (const ability of sheet.abilities) {
			lines.push(
				line(
					{ text: ability.name, token: "primary" },
					...mutedSuffix(ability.cost)
				),
				line({ text: ability.text, token: "muted" })
			);
		}
		if (input.focused) {
			lines.push(line({ text: "[/] other sheets", token: "muted" }));
		}
		return lines;
	};

	const onKey = (
		key: PanelKey,
		input: GamePanelInput<DsState, DsCommand>
	): boolean => {
		if (!input.focused) {
			return false;
		}
		let direction = 0;
		if (key.name === "]" || key.name === "right") {
			direction = 1;
		} else if (key.name === "[" || key.name === "left") {
			direction = -1;
		}
		if (direction === 0) {
			return false;
		}
		const bound = boundSheets(input);
		if (bound.length > 0) {
			const currentIndex = shownIndex(input, bound);
			const nextIndex =
				(((currentIndex + direction) % bound.length) + bound.length) %
				bound.length;
			pageSeatId = bound[nextIndex]?.seat.id ?? null;
		}
		return true;
	};

	return { id: "sheet", onKey, render, slot: "sidebar" };
};

const tierToken = (tier: 1 | 2 | 3) => {
	if (tier === 3) {
		return "success" as const;
	}
	return tier === 2 ? ("primary" as const) : ("danger" as const);
};

const edgeBaneLabel = (edges: number, banes: number) => {
	const net = edges - banes;
	if (net === 1) {
		return { rollAdjustment: " + 2 (edge)", tierShift: "" };
	}
	if (net === -1) {
		return { rollAdjustment: " − 2 (bane)", tierShift: "" };
	}
	if (net === 2) {
		return {
			rollAdjustment: "",
			tierShift: " (double edge: tier up)",
		};
	}
	if (net === -2) {
		return {
			rollAdjustment: "",
			tierShift: " (double bane: tier down)",
		};
	}
	return { rollAdjustment: "", tierShift: "" };
};

export const view: GameView<DsState, DsCommand, DsEvent> = {
	createPanels: () => [createInitiativePanel(), createSheetPanel()],
	// oxlint-disable-next-line eslint/complexity -- branches mirror the pinned event register for exhaustive rendering.
	renderEvent(event, state) {
		switch (event.type) {
			case "ds.character-entered": {
				const sheet = sheetOfEnteredEvent(event);
				return line(
					nameRun(sheet.name),
					{ text: " enters play ", token: "primary" },
					{
						attrs: ["italic"],
						text: `(${characteristicSummary(sheet)})`,
						token: "muted",
					}
				);
			}
			case "ds.encounter-started": {
				return line({ text: "encounter started — round 1", token: "primary" });
			}
			case "ds.encounter-ended": {
				const noun = event.rounds === 1 ? "round" : "rounds";
				return line({
					text: `encounter ends after ${event.rounds} ${noun}`,
					token: "primary",
				});
			}
			case "ds.combatant-added": {
				return line(nameRun(event.name), {
					text: ` joins the ${event.side}.`,
					token: "primary",
				});
			}
			case "ds.turn-taken": {
				const name =
					state.encounter.combatants.find(
						(combatant) => combatant.id === event.combatantId
					)?.name ?? event.combatantId;
				return line(nameRun(name), {
					text: " takes their turn",
					token: "primary",
				});
			}
			case "ds.round-started": {
				return line({ text: `round ${event.round} begins`, token: "primary" });
			}
			case "ds.condition-applied":
			case "ds.condition-removed": {
				const name =
					state.encounter.combatants.find(
						(combatant) => combatant.id === event.combatantId
					)?.name ?? event.combatantId;
				const change =
					event.type === "ds.condition-applied"
						? ` is ${event.condition}`
						: ` is no longer ${event.condition}`;
				return line(nameRun(name), { text: change, token: "primary" });
			}
			case "ds.resource-changed": {
				const resourceName =
					state.characters.find(
						(character) => character.name === event.characterName
					)?.heroicResource ?? "heroic resource";
				return line(nameRun(event.characterName), {
					text: ` ${signed(event.delta)} ${resourceName.toLowerCase()} → ${event.total}`,
					token: "primary",
				});
			}
			case "ds.recovery-spent": {
				return line(nameRun(event.characterName), {
					text: ` spends a recovery (${event.remaining} left)`,
					token: "primary",
				});
			}
			case "ds.surges-changed": {
				return line(nameRun(event.characterName), {
					text: ` ${signed(event.delta)} surges → ${event.total}`,
					token: "primary",
				});
			}
			case "ds.victory-gained": {
				return line(nameRun(event.characterName), {
					text: ` earns a victory (${event.total})`,
					token: "primary",
				});
			}
			case "ds.power-rolled": {
				const edgeBane = edgeBaneLabel(event.edges, event.banes);
				const modifier = arithmeticModifier(event.modifier);
				const actorRuns: readonly TextRun[] =
					event.characterName === null
						? []
						: [nameRun(event.characterName), { text: " — ", token: "primary" }];
				return line(
					...actorRuns,
					{
						text: `power roll (${event.characteristic}): ${event.dice[0]} + ${event.dice[1]} ${modifier}${edgeBane.rollAdjustment} = `,
						token: "primary",
					},
					{ attrs: ["bold"], text: String(event.total), token: "accent" },
					{ text: " → ", token: "primary" },
					{ text: terminology.tiers[event.tier], token: tierToken(event.tier) },
					{ text: edgeBane.tierShift, token: "primary" },
					...(event.critical
						? ([
								{ attrs: ["bold"], text: " · crit!", token: "success" },
							] as const)
						: [])
				);
			}
			// Unknown runtime events are skipped for forward compatibility.
			// No default
		}
		return null;
	},
};
