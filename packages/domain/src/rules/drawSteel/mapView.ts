import { ifDefined } from "../../present.ts";
import { moverWalk, reachable } from "../board/movement.ts";
import type { MapToken, MapView } from "../board/view.ts";
import { moverOf, occupants, speedOf } from "./board.ts";
import {
	everyone,
	footprintOfWho,
	heroOf,
	isDead,
	marks,
	resolve,
	sideOf,
} from "./state.ts";
import type { DrawSteelState, Who } from "./state.ts";

export type { MapToken, MapView } from "../board/view.ts";

const reachFor = (slice: DrawSteelState, actor: string): Who | undefined => {
	const board = slice.map;

	if (board === undefined) {
		return undefined;
	}

	const placedAndAlive = (who: Who | undefined) =>
		who !== undefined && board.tokens[who.id] !== undefined && !isDead(who)
			? who
			: undefined;

	const acting = slice.combat.active ? slice.combat.acting : undefined;
	const actingWho = acting === undefined ? undefined : resolve(slice, acting);

	const fromActing =
		actingWho === undefined || "refusal" in actingWho
			? undefined
			: placedAndAlive(actingWho);

	if (fromActing !== undefined) {
		return fromActing;
	}

	const own = heroOf(slice, actor);

	if (own === undefined) {
		return undefined;
	}

	const ownWho = resolve(slice, own.id);

	return "refusal" in ownWho ? undefined : placedAndAlive(ownWho);
};

const figureOf = (who: Who): { readonly figure?: string } =>
	who.kind === "creature" ? { figure: who.creature.block } : {};

const footprintField = (slice: DrawSteelState, who: Who) => {
	const footprint = footprintOfWho(slice, who);

	return footprint === 1 ? {} : { footprint };
};

export const mapView = (
	slice: DrawSteelState,
	actor: string
): MapView | undefined => {
	const board = slice.map;

	if (board === undefined) {
		return undefined;
	}

	const marked = marks(slice);

	const tokens = everyone(slice).flatMap((who): Array<MapToken> => {
		const at = board.tokens[who.id];

		if (at === undefined) {
			return [];
		}

		return [
			{
				id: who.id,
				mark: marked.get(who.id) ?? "??",
				name: who.name,
				x: at.x,
				y: at.y,
				side: sideOf(who),
				...figureOf(who),
				...footprintField(slice, who),
				mine: who.kind === "hero" && who.hero.player === actor,
				acting: slice.combat.acting === who.id,
				dead: isDead(who),
			},
		];
	});

	const subject = reachFor(slice, actor);
	const from = subject === undefined ? undefined : board.tokens[subject.id];
	const speed = subject === undefined ? 0 : speedOf(slice, subject).speed;

	const moved =
		subject !== undefined && slice.combat.moved?.id === subject.id
			? slice.combat.moved
			: undefined;

	const allowance = moved?.main === true ? 2 * speed : speed;

	const left =
		moved === undefined ? speed : Math.max(0, allowance - moved.spent);

	const reach =
		subject === undefined || from === undefined
			? []
			: reachable(
					board.terrain,
					from,
					left,
					moverWalk(
						board.terrain,
						moverOf(slice, subject),
						occupants(slice, board, subject.id)
					),
					occupants(slice, board, subject.id),
					moverOf(slice, subject)
				);

	const spent = moved?.main === true ? ", main action spent" : "";

	const label =
		moved === undefined
			? `speed ${speed}`
			: `${left} of speed ${speed} left${spent}`;

	return {
		name: board.name,
		width: board.terrain[0]?.length ?? 0,
		height: board.terrain.length,
		terrain: board.terrain,
		...ifDefined(board.dressing, (value) => ({ dressing: value })),
		tokens: [...tokens.filter((t) => t.dead), ...tokens.filter((t) => !t.dead)],
		reach,
		...ifDefined(subject, (value) => ({
			reachLabel: `${value.name} can reach: ${label}`,
		})),
	};
};
