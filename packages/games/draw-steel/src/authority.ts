import type { GameAuthority, Rejection, TableView } from "@supervillain/core";

import { validate } from "./content.js";
import { apply, DS_CONDITIONS, DS_SIDES, init, playOf } from "./model.js";
import type {
	DsCharacteristic,
	DsCharacterSheet,
	DsCommand,
	DsEvent,
	DsSide,
	DsState,
} from "./model.js";

const CHARACTERISTICS: ReadonlySet<DsCharacteristic> = new Set([
	"might",
	"agility",
	"reason",
	"intuition",
	"presence",
]);
const CONDITIONS = new Set(DS_CONDITIONS);
const SIDES = new Set(DS_SIDES);

const rejection = (message: string): Rejection => ({ message, rejected: true });

const isGm = (table: TableView): boolean =>
	table.seats.find((seat) => seat.id === table.gmSeatId)?.actor === table.actor;

const deriveSheet = (text: string): DsCharacterSheet => {
	const value = JSON.parse(text) as {
		readonly abilities?: readonly {
			readonly cost?: string;
			readonly name: string;
			readonly text: string;
		}[];
		readonly ancestry: string;
		readonly characteristics: Record<DsCharacteristic, number>;
		readonly class: string;
		readonly heroicResource: string;
		readonly kit?: string;
		readonly name: string;
		readonly recoveries: number;
		readonly stamina: number;
		readonly surges?: number;
		readonly victories?: number;
	};
	return {
		abilities: (value.abilities ?? []).map((ability) => ({
			cost: ability.cost?.trim() ?? null,
			name: ability.name.trim(),
			text: ability.text.trim(),
		})),
		ancestry: value.ancestry.trim(),
		characteristics: {
			agility: value.characteristics.agility,
			intuition: value.characteristics.intuition,
			might: value.characteristics.might,
			presence: value.characteristics.presence,
			reason: value.characteristics.reason,
		},
		className: value.class.trim(),
		heroicResource: value.heroicResource.trim(),
		kit: value.kit?.trim() ?? null,
		name: value.name.trim(),
		recoveries: value.recoveries,
		stamina: value.stamina,
		surges: value.surges ?? 0,
		victories: value.victories ?? 0,
	};
};

const sheetsEqual = (
	left: Readonly<DsCharacterSheet>,
	right: Readonly<DsCharacterSheet>
): boolean => {
	if (
		left.name !== right.name ||
		left.ancestry !== right.ancestry ||
		left.className !== right.className ||
		left.kit !== right.kit ||
		left.stamina !== right.stamina ||
		left.recoveries !== right.recoveries ||
		left.heroicResource !== right.heroicResource ||
		left.surges !== right.surges ||
		left.victories !== right.victories ||
		left.abilities.length !== right.abilities.length
	) {
		return false;
	}
	for (const characteristic of CHARACTERISTICS) {
		if (
			left.characteristics[characteristic] !==
			right.characteristics[characteristic]
		) {
			return false;
		}
	}
	return left.abilities.every((ability, index) => {
		const other = right.abilities[index];
		return (
			other !== undefined &&
			ability.name === other.name &&
			ability.cost === other.cost &&
			ability.text === other.text
		);
	});
};

const otherSide = (side: DsSide): DsSide =>
	side === "heroes" ? "enemies" : "heroes";

const netBonus = (net: number): number => {
	if (net === 1) {
		return 2;
	}
	return net === -1 ? -2 : 0;
};

const powerTier = (
	total: number,
	net: number,
	critical: boolean
): 1 | 2 | 3 => {
	if (critical) {
		return 3;
	}
	let tier = 3;
	if (total <= 11) {
		tier = 1;
	} else if (total <= 16) {
		tier = 2;
	}
	if (net === 2) {
		tier += 1;
	} else if (net === -2) {
		tier -= 1;
	}
	return Math.max(1, Math.min(3, tier)) as 1 | 2 | 3;
};

type ConditionCommand = Extract<
	DsCommand,
	{ readonly type: "ds.apply-condition" | "ds.remove-condition" }
>;
type PlayCommand = Extract<
	DsCommand,
	{
		readonly type:
			| "ds.gain-resource"
			| "ds.spend-resource"
			| "ds.spend-recovery"
			| "ds.gain-surges"
			| "ds.spend-surges";
	}
>;

const isPlayCommand = (command: DsCommand): command is PlayCommand =>
	command.type === "ds.gain-resource" ||
	command.type === "ds.spend-resource" ||
	command.type === "ds.spend-recovery" ||
	command.type === "ds.gain-surges" ||
	command.type === "ds.spend-surges";

const validAmount = (amount: number): boolean =>
	Number.isInteger(amount) && amount >= 1 && amount <= 99;

const conditionChange = (
	state: Readonly<DsState>,
	command: ConditionCommand
): DsEvent[] | Rejection => {
	if (!CONDITIONS.has(command.condition)) {
		return rejection(`Unknown condition '${String(command.condition)}'.`);
	}
	if (!state.encounter.active) {
		return rejection("Start an encounter first.");
	}
	const combatant = state.encounter.combatants.find(
		(candidate) => candidate.id === command.combatantId
	);
	if (combatant === undefined) {
		return rejection(
			`No combatant '${command.combatantId}' is in the encounter.`
		);
	}
	const hasCondition = combatant.conditions.includes(command.condition);
	if (command.type === "ds.apply-condition") {
		return hasCondition
			? rejection(`${combatant.name} is already ${command.condition}.`)
			: [
					{
						combatantId: command.combatantId,
						condition: command.condition,
						type: "ds.condition-applied",
					},
				];
	}
	return hasCondition
		? [
				{
					combatantId: command.combatantId,
					condition: command.condition,
					type: "ds.condition-removed",
				},
			]
		: rejection(`${combatant.name} is not ${command.condition}.`);
};

const playChange = (
	state: Readonly<DsState>,
	command: PlayCommand
): DsEvent[] | Rejection => {
	const play = playOf(state, command.characterName);
	if (play === undefined) {
		return rejection(
			`No character named '${command.characterName}' has entered play.`
		);
	}
	if (command.type === "ds.spend-recovery") {
		return play.recoveries === 0
			? rejection("No recoveries left.")
			: [
					{
						characterName: command.characterName,
						remaining: play.recoveries - 1,
						type: "ds.recovery-spent",
					},
				];
	}
	const amount =
		command.type === "ds.gain-surges" || command.type === "ds.spend-surges"
			? command.count
			: command.amount;
	if (!validAmount(amount)) {
		return rejection("Amounts are whole numbers from 1 to 99.");
	}
	if (command.type === "ds.gain-resource") {
		return [
			{
				characterName: command.characterName,
				delta: amount,
				total: play.heroicResource + amount,
				type: "ds.resource-changed",
			},
		];
	}
	if (command.type === "ds.spend-resource") {
		if (amount > play.heroicResource) {
			const resourceName =
				state.characters.find(
					(character) => character.name === command.characterName
				)?.heroicResource ?? "heroic resource";
			return rejection(`Not enough ${resourceName.toLowerCase()}.`);
		}
		return [
			{
				characterName: command.characterName,
				delta: -amount,
				total: play.heroicResource - amount,
				type: "ds.resource-changed",
			},
		];
	}
	if (command.type === "ds.gain-surges") {
		return [
			{
				characterName: command.characterName,
				delta: amount,
				total: play.surges + amount,
				type: "ds.surges-changed",
			},
		];
	}
	return amount > play.surges
		? rejection("Not enough surges.")
		: [
				{
					characterName: command.characterName,
					delta: -amount,
					total: play.surges - amount,
					type: "ds.surges-changed",
				},
			];
};

const powerRoll = (
	state: Readonly<DsState>,
	command: Extract<DsCommand, { readonly type: "ds.power-roll" }>,
	random: () => number
): DsEvent[] | Rejection => {
	if (!CHARACTERISTICS.has(command.characteristic)) {
		return rejection(
			`Unknown characteristic '${String(command.characteristic)}'.`
		);
	}
	if (
		!Number.isInteger(command.edges) ||
		!Number.isInteger(command.banes) ||
		command.edges < 0 ||
		command.edges > 2 ||
		command.banes < 0 ||
		command.banes > 2
	) {
		return rejection("Edges and banes are 0, 1, or 2.");
	}
	const character = state.characters.find(
		(candidate) => candidate.name === command.characterName
	);
	if (command.characterName !== undefined && character === undefined) {
		return rejection(
			`No character named '${command.characterName}' has entered play.`
		);
	}
	const first = Math.floor(random() * 10) + 1;
	const second = Math.floor(random() * 10) + 1;
	const raw = first + second;
	const critical = raw >= 19;
	const net = command.edges - command.banes;
	const modifier = character?.characteristics[command.characteristic] ?? 0;
	const total = raw + modifier + netBonus(net);
	const tier = powerTier(total, net, critical);
	return [
		{
			banes: command.banes,
			characterName: command.characterName ?? null,
			characteristic: command.characteristic,
			critical,
			dice: [first, second],
			edges: command.edges,
			modifier,
			tier,
			total,
			type: "ds.power-rolled",
		},
	];
};

export const createDecide =
	(random: () => number = Math.random) =>
	// oxlint-disable-next-line eslint/complexity -- branches mirror the pinned command grammar and exact Rejections.
	(
		state: Readonly<DsState>,
		command: DsCommand,
		table: TableView
	): DsEvent[] | Rejection => {
		if (!table.seats.some((seat) => seat.actor === table.actor)) {
			return rejection("You do not hold a seat at this table.");
		}
		if (command.type === "ds.power-roll") {
			return powerRoll(state, command, random);
		}
		if (isPlayCommand(command)) {
			const actorSeat = table.seats.find((seat) => seat.actor === table.actor);
			if (!isGm(table) && actorSeat?.characterId !== command.characterName) {
				return rejection("Only the GM or the bound player can do that.");
			}
			return playChange(state, command);
		}
		if (!isGm(table)) {
			return rejection("Only the GM can do that.");
		}
		switch (command.type) {
			case "ds.load-character": {
				const result = validate(new TextEncoder().encode(command.text));
				if (!result.ok) {
					return rejection(
						result.errors[0]?.message ?? "Character file is invalid."
					);
				}
				const sheet = deriveSheet(command.text);
				const existing = state.characters.find(
					(character) => character.name === sheet.name
				);
				if (existing !== undefined && sheetsEqual(existing, sheet)) {
					return [];
				}
				return [{ sheet, type: "ds.character-entered" }];
			}
			case "ds.start-encounter": {
				return state.encounter.active
					? rejection("An encounter is already underway.")
					: [{ type: "ds.encounter-started" }];
			}
			case "ds.end-encounter": {
				return state.encounter.active
					? [
							{
								rounds: state.encounter.round,
								type: "ds.encounter-ended",
							},
						]
					: rejection("No encounter is underway.");
			}
			case "ds.add-combatant": {
				if (!SIDES.has(command.side)) {
					return rejection(`Unknown side '${String(command.side)}'.`);
				}
				if (!state.encounter.active) {
					return rejection("Start an encounter first.");
				}
				const name = command.name.trim();
				if (name.length === 0) {
					return rejection("Combatant name must not be empty.");
				}
				if (name.length > 60) {
					return rejection("Combatant name must be at most 60 characters.");
				}
				if (
					state.encounter.combatants.some(
						(combatant) => combatant.name === name
					)
				) {
					return rejection(`'${name}' is already in the encounter.`);
				}
				return [
					{
						id: `c${state.encounter.combatants.length + 1}`,
						name,
						side: command.side,
						type: "ds.combatant-added",
					},
				];
			}
			case "ds.apply-condition":
			case "ds.remove-condition": {
				return conditionChange(state, command);
			}
			case "ds.gain-victory": {
				const play = playOf(state, command.characterName);
				return play === undefined
					? rejection(
							`No character named '${command.characterName}' has entered play.`
						)
					: [
							{
								characterName: command.characterName,
								total: play.victories + 1,
								type: "ds.victory-gained",
							},
						];
			}
			case "ds.take-turn": {
				if (!state.encounter.active) {
					return rejection("Start an encounter first.");
				}
				const combatant = state.encounter.combatants.find(
					(candidate) => candidate.id === command.combatantId
				);
				if (combatant === undefined) {
					return rejection(
						`No combatant '${command.combatantId}' is in the encounter.`
					);
				}
				if (combatant.actedRound === state.encounter.round) {
					return rejection(`${combatant.name} has already acted this round.`);
				}
				const nextSide = otherSide(combatant.side);
				const otherSideCanAct = state.encounter.combatants.some(
					(candidate) =>
						candidate.side === nextSide &&
						candidate.actedRound !== state.encounter.round
				);
				if (state.encounter.lastSide === combatant.side && otherSideCanAct) {
					return rejection(`The ${nextSide} act next.`);
				}
				const events: DsEvent[] = [
					{
						combatantId: combatant.id,
						round: state.encounter.round,
						type: "ds.turn-taken",
					},
				];
				const allActed = state.encounter.combatants.every(
					(candidate) =>
						candidate.id === combatant.id ||
						candidate.actedRound === state.encounter.round
				);
				if (allActed) {
					events.push({
						round: state.encounter.round + 1,
						type: "ds.round-started",
					});
				}
				return events;
			}
			// No default
		}
	};

export const decide = createDecide();

export const authority: GameAuthority<DsState, DsCommand, DsEvent> = {
	apply,
	decide,
	init,
};
