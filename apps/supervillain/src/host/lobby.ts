import { isMember } from "@supervillain/domain";
import type { RawSession } from "@supervillain/ssh";
import { Effect, Option } from "effect";
import type { Scope } from "effect";

import {
	knowsAnswerLine,
	knownActor,
	parseKnowsQuery,
	readLine,
} from "../relay/protocol.ts";
import type { KnowsAnswer } from "../relay/protocol.ts";
import { Presence } from "./Presence.ts";
import { TableRoom } from "./TableRoom.ts";

const QUESTION_MS = 2000;

export const answerKnows = (
	line: string | undefined,
	actors: Iterable<string>,
	seated: number,
	lobby: boolean
): { readonly answer: KnowsAnswer; readonly actor?: string } => {
	const query =
		line === undefined || !lobby ? undefined : parseKnowsQuery(line);

	const actor = query === undefined ? undefined : knownActor(query, actors);

	return actor === undefined
		? { answer: { known: false } }
		: { answer: { known: true, seated }, actor };
};

export const knowsSession =
	(lobby: boolean) =>
	(
		session: RawSession
	): Effect.Effect<void, never, Scope.Scope | TableRoom | Presence> =>
		Effect.gen(function* () {
			const line = lobby
				? Option.getOrUndefined(
						yield* Effect.option(readLine(session.stream, QUESTION_MS))
					)
				: undefined;

			session.stream.resume();
			const here = yield* (yield* Presence).here.get;
			const state = yield* (yield* TableRoom).state;

			const members = [
				...new Set([
					...state.actors,
					...Object.keys(state.core.members),
					...here,
				]),
			].filter((actor) => isMember(state, actor));

			const { answer, actor } = answerKnows(line, members, here.length, lobby);

			if (actor !== undefined) {
				yield* Effect.logInfo(
					`lobby: the relay listed this table for ${actor}`
				);
			}

			session.stream.write(knowsAnswerLine(answer));
			session.exit(0);
		});
