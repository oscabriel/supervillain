import type {
	FeedLine,
	GamePanel,
	GamePanelInput,
	GameView,
	PanelKey,
	TextRun,
} from "@supervillain/core";

import { independenceNotice, terminology } from "./content.js";
import type {
	DsCharacteristic,
	DsCommand,
	DsEvent,
	DsSide,
	DsStatBlock,
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
const signed = (value: number): string =>
	value >= 0 ? `+${value}` : `${value}`;
const arithmeticModifier = (value: number): string =>
	value >= 0 ? `+ ${value}` : `- ${Math.abs(value)}`;
const characteristicSummary = (statBlock: DsStatBlock): string =>
	CHARACTERISTICS.map(
		(characteristic) =>
			`${terminology.characteristics[characteristic][0]}${signed(statBlock.characteristics[characteristic])}`
	).join(" ");

const selectedCharacter = (
	input: GamePanelInput<DsState, DsCommand>,
	selectedIndex: number
): DsStatBlock | undefined => {
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
	| { readonly kind: "add"; readonly side: DsSide }
	| {
			readonly kind: "roll";
			readonly characteristic: DsCharacteristic;
			readonly edges: number;
			readonly banes: number;
	  };

const createInitiativePanel = (): GamePanel<DsState, DsCommand> => {
	let selectedIndex = 0;
	let mode: PanelMode = { kind: "normal" };
	let buffer = "";

	const renderHints = (): FeedLine => {
		if (mode.kind === "add") {
			const side = mode.side === "heroes" ? "hero" : "enemy";
			return line({ text: `add ${side}: ${buffer}_`, token: "muted" });
		}
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
					line({
						text: `${selected ? "▸" : " "} ${acted ? "✓" : "·"} ${combatant.name} [${side}]`,
						token: selected ? "accent" : "primary",
					})
				);
			}
			const character = selectedCharacter(input, selectedIndex);
			if (character !== undefined) {
				const stamina =
					character.stamina === undefined
						? ""
						: ` · stamina ${character.stamina}`;
				lines.push(
					line({
						text: `${characteristicSummary(character)}${stamina}`,
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
		if (mode.kind === "add") {
			if (key.name === "backspace") {
				buffer = buffer.slice(0, -1);
				return true;
			}
			if (key.name === "return") {
				input.dispatch({
					name: buffer.trim(),
					side: mode.side,
					type: "ds.add-combatant",
				});
				buffer = "";
				mode = { kind: "normal" };
				return true;
			}
			if (key.name === "escape") {
				buffer = "";
				mode = { kind: "normal" };
				return true;
			}
			if (key.text !== undefined) {
				buffer += key.text;
				return true;
			}
			return false;
		}
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
			buffer = "";
			mode = { kind: "add", side: key.name === "a" ? "heroes" : "enemies" };
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

const tierToken = (tier: 1 | 2 | 3) => {
	if (tier === 3) {
		return "success" as const;
	}
	return tier === 2 ? ("primary" as const) : ("danger" as const);
};

const edgeBaneLabel = (net: number): string => {
	if (net === 0) {
		return "flat";
	}
	if (net === 1) {
		return "edge";
	}
	if (net === 2) {
		return "2 edges";
	}
	return net === -1 ? "bane" : "2 banes";
};

export const view: GameView<DsState, DsCommand, DsEvent> = {
	notices: [line({ text: independenceNotice, token: "muted" })],
	panels: [createInitiativePanel()],
	renderEvent(event, state) {
		switch (event.type) {
			case "ds.character-entered": {
				return line(
					{ text: event.statBlock.name, token: "accent" },
					{ text: " enters play ", token: "primary" },
					{
						text: `(${characteristicSummary(event.statBlock)})`,
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
				return line(
					{ text: event.name, token: "accent" },
					{ text: ` joins the ${event.side}.`, token: "primary" }
				);
			}
			case "ds.turn-taken": {
				const name =
					state.encounter.combatants.find(
						(combatant) => combatant.id === event.combatantId
					)?.name ?? event.combatantId;
				return line(
					{ text: name, token: "accent" },
					{ text: " takes their turn", token: "primary" }
				);
			}
			case "ds.round-started": {
				return line({ text: `round ${event.round} begins`, token: "primary" });
			}
			case "ds.power-rolled": {
				const edgeBane = edgeBaneLabel(event.edges - event.banes);
				const modifier = arithmeticModifier(event.modifier);
				const prefix =
					event.characterName === null ? "" : `${event.characterName} — `;
				return line(
					{
						text: `${prefix}power roll (${event.characteristic}): ${event.dice[0]} + ${event.dice[1]} ${modifier}, ${edgeBane} = `,
						token: "primary",
					},
					{ text: String(event.total), token: "accent" },
					{ text: " → ", token: "primary" },
					{ text: terminology.tiers[event.tier], token: tierToken(event.tier) },
					...(event.critical
						? ([{ text: " · crit!", token: "success" }] as const)
						: [])
				);
			}
			// No default
		}
	},
};
