// The table's half of the relay's lobby: a relay asks, on the link, whether this table knows a
// player's key, and the table answers from its log and who is seated now. See relay/protocol.ts
// for the question and server.ts for the lobby itself.
import type { RawSession } from "@supervillain/ssh";
import { Effect, type Scope } from "effect";
import {
  type KnowsAnswer,
  knowsAnswerLine,
  knownActor,
  parseKnowsQuery,
  readLine,
} from "../relay/protocol.ts";
import { Presence } from "./Presence.ts";
import { TableRoom } from "./TableRoom.ts";

/**
 * How long the relay has to ask, once it has opened the session. The relay's own 2 s deadline
 * starts before it opens the session, so it gives up first.
 */
const QUESTION_MS = 2000;

/**
 * What this table says to the relay's line: yes, with how many are seated, if the key it asks
 * about is one of `actors` (everyone in the log, and everyone seated now); no to anything else,
 * and always no with the lobby off.
 */
export const answerKnows = (
  line: string | undefined,
  actors: Iterable<string>,
  seated: number,
  lobby: boolean,
): { readonly answer: KnowsAnswer; readonly actor?: string } => {
  const query = line === undefined || !lobby ? undefined : parseKnowsQuery(line);
  const actor = query === undefined ? undefined : knownActor(query, actors);
  return actor === undefined
    ? { answer: { known: false } }
    : { answer: { known: true, seated }, actor };
};

/**
 * Answers one lobby question from a trusted relay: the handler for its `KNOWS_SUBSYSTEM` session.
 * With `lobby` false (the GM's `--no-lobby`) the answer is always no, and nothing is read.
 */
export const knowsSession =
  (lobby: boolean) =>
  (session: RawSession): Effect.Effect<void, never, Scope.Scope | TableRoom | Presence> =>
    Effect.gen(function* () {
      // Undefined if the line runs long, comes late, or the session ends first.
      const line = lobby
        ? yield* Effect.promise(() => readLine(session.stream, QUESTION_MS).catch(() => undefined))
        : undefined;
      // What's left unread would hold the channel open.
      session.stream.resume();
      const here = yield* (yield* Presence).here.get;
      const logged = yield* (yield* TableRoom).actors;
      const { answer, actor } = answerKnows(line, [...logged, ...here], here.length, lobby);
      if (actor !== undefined)
        yield* Effect.logInfo(`lobby: the relay listed this table for ${actor}`);
      session.stream.write(knowsAnswerLine(answer));
      session.exit(0);
    });
