import { Result, Schema } from "effect";

import {
	apart,
	BRANN,
	COLUMNS,
	FIGHTERS,
	fighterOf,
	HERO,
	nameOfSquare,
	RECOVERY_VALUE,
	squareOfName,
} from "./Encounter.ts";
import type { Square } from "./Encounter.ts";
import {
	bodyOf,
	decide,
	Entry,
	entriesOf,
	fold,
	GM,
	Happened,
	isDead,
	movesLeft,
	OPENING_LOG,
	reachable,
	reachFrom,
	whoOf,
} from "./Rules.ts";
import type { Folded, TableState } from "./Rules.ts";

export const SEED = 20_261_122;

export const Reply = Schema.Struct({
	title: Schema.String,
	lines: Schema.Array(Schema.String),
});

export type Reply = typeof Reply.Type;

export const Demo = Schema.Struct({
	line: Schema.String,
	seed: Schema.Int,
	log: Schema.Array(Entry),
	refusal: Schema.String,
	reply: Schema.NullOr(Reply),
	showLog: Schema.Boolean,
	sent: Schema.Array(Schema.String),
	recall: Schema.Int,
});

export type Demo = typeof Demo.Type;

export const DEMO: Demo = {
	line: "",
	seed: SEED,
	log: OPENING_LOG,
	refusal: "",
	reply: null,
	showLog: false,
	sent: [],
	recall: 0,
};

export const HELP: Reply = {
	title: "help",
	lines: [
		"Plain text is chat. A line that starts with / is a command.",
		"/move brann <square> [main]   move by the cheapest path",
		"/pr brann <ability> on <who>  power roll: Driving Blow, Accusing Glare",
		"/recover brann                catch your breath: spend a Recovery",
		"/dist <who|square> <who|square>  count the squares between",
		"/roll 2d10+3                  roll for the table",
		"/undo                         take back your latest move",
		"/sheet <who>                  a sheet, shown to you alone",
		"/done                         end Brann's turn; the GM runs the bandits",
		"/view pictures|text           draw the map as pictures or as text",
		"/reset                        start the fight over",
		"Click a tinted square to move, or a bandit beside you to strike.",
		"Click anything else to type its name. Esc closes this.",
	],
};

const abilityLines = (id: string): Array<string> =>
	fighterOf(id).abilities.map(
		(ability) =>
			`${ability.name} · ${ability.distance}${ability.cost > 0 ? ` · ${ability.cost} wrath` : ""} · ${ability.base.join(" / ")}${ability.letter === "" ? "" : ` + ${ability.letter}`}${ability.type === "" ? "" : ` ${ability.type}`} damage`
	);

export const sheetOf = (demo: Demo, id: string): Reply => {
	const fighter = fighterOf(id);
	const { state } = fold(demo.log);
	const body = bodyOf(state, id);

	const lines = [
		`${fighter.name} (${fighter.mark}) · ${fighter.kind}`,
		`Stamina ${body?.stamina ?? fighter.stamina}/${fighter.stamina} · speed ${fighter.speed} · stability ${fighter.stability}`,
	];

	if (id === HERO) {
		lines.push(
			`wrath ${state.wrath} · Recoveries ${state.recoveries} (${RECOVERY_VALUE} each)`
		);
	}

	return {
		title: `sheet · ${fighter.name}`,
		lines: [...lines, ...abilityLines(id)],
	};
};

const answered = (demo: Demo, reply: Reply, sent: string): Demo => ({
	...demo,
	line: "",
	refusal: "",
	reply,
	sent: [...demo.sent, sent],
	recall: 0,
});

const replyTo = (demo: Demo, text: string): Demo | undefined => {
	const [rawHead = "", who = ""] = text.split(/\s+/u);
	const head = rawHead.toLowerCase();

	if (head === "/help") {
		return answered(demo, HELP, text);
	}

	if (head !== "/sheet") {
		return undefined;
	}

	if (who === "") {
		return answered(demo, sheetOf(demo, HERO), text);
	}

	return Result.match(whoOf(who), {
		onFailure: (refusal) => ({
			...demo,
			line: "",
			refusal: `Refused: ${refusal}`,
			sent: [...demo.sent, text],
			recall: 0,
		}),
		onSuccess: (found) => answered(demo, sheetOf(demo, found.id), text),
	});
};

export const sent = (demo: Demo, line: string): Demo => {
	const text = line.trim();

	if (text === "") {
		return { ...demo, line: "" };
	}

	const replied = replyTo(demo, text);

	if (replied !== undefined) {
		return replied;
	}

	return Result.match(decide(demo.log, text, demo.seed), {
		onFailure: (refusal) => ({
			...demo,
			line: "",
			refusal: `Refused: ${refusal}`,
			sent: [...demo.sent, text],
			recall: 0,
		}),
		onSuccess: ({ events, seed }) => ({
			...demo,
			line: "",
			seed,
			log: entriesOf(demo.log, events),
			refusal: "",
			sent: [...demo.sent, text],
			recall: 0,
		}),
	});
};

export const gmSaid = (demo: Demo, text: string): Demo => ({
	...demo,
	log: entriesOf(demo.log, [
		{ actor: GM, event: Happened.ChatPosted({ text }) },
	]),
});

export const submitted = (demo: Demo): Demo => sent(demo, demo.line);

export const typed = (demo: Demo, line: string): Demo => ({
	...demo,
	line,
});

const appended = (line: string, word: string): string =>
	line === "" || line.endsWith(" ") ? `${line}${word}` : `${line} ${word}`;

const isOpen = (demo: Demo, square: string): boolean => {
	const at = squareOfName(square);
	const { state } = fold(demo.log);

	return reachable(state).some(
		(spot) => at !== undefined && nameOfSquare(spot) === nameOfSquare(at)
	);
};

export const isStrikable = (state: TableState, id: string): boolean => {
	const fighter = fighterOf(id);
	const hero = bodyOf(state, HERO)?.at ?? BRANN.start;
	const there = bodyOf(state, id)?.at ?? fighter.start;

	return (
		fighter.side === "director" &&
		!isDead(state, id) &&
		state.turn === HERO &&
		!state.acted &&
		state.winner === "" &&
		apart(hero, there) <= 1
	);
};

export const clickedSquare = (demo: Demo, square: string): Demo =>
	demo.line === "" && isOpen(demo, square)
		? { ...demo, line: `/move brann ${square}`, refusal: "" }
		: { ...demo, line: appended(demo.line, square), refusal: "" };

export const clickedToken = (demo: Demo, id: string): Demo => {
	const { mark } = fighterOf(id);

	return demo.line === "" && isStrikable(fold(demo.log).state, id)
		? { ...demo, line: `/pr brann driving on ${mark}`, refusal: "" }
		: { ...demo, line: appended(demo.line, mark), refusal: "" };
};

export const actedSquare = (demo: Demo, square: string): Demo =>
	demo.line === "" && isOpen(demo, square)
		? sent(demo, `/move brann ${square}`)
		: clickedSquare(demo, square);

export const actedToken = (demo: Demo, id: string): Demo =>
	demo.line === "" && isStrikable(fold(demo.log).state, id)
		? sent(demo, `/pr brann driving on ${fighterOf(id).mark}`)
		: clickedToken(demo, id);

export const recalled = (demo: Demo, step: number): Demo => {
	const recall = Math.min(demo.sent.length, Math.max(0, demo.recall + step));

	return {
		...demo,
		recall,
		line: recall === 0 ? "" : (demo.sent[demo.sent.length - recall] ?? ""),
	};
};

export const escaped = (demo: Demo): Demo =>
	demo.reply === null
		? { ...demo, line: "", refusal: "" }
		: { ...demo, reply: null };

export const closedReply = (demo: Demo): Demo => ({ ...demo, reply: null });

export const toggledLog = (demo: Demo): Demo => ({
	...demo,
	showLog: !demo.showLog,
});

export const restarted = (demo: Demo): Demo => ({
	...DEMO,
	showLog: demo.showLog,
});

export const projectionOf = (demo: Demo): Folded => fold(demo.log);

const nearestFoe = (folded: Folded): string => {
	const { state } = folded;
	const hero = bodyOf(state, HERO)?.at ?? BRANN.start;

	const foes = FIGHTERS.filter(
		(fighter) => fighter.side === "director" && !isDead(state, fighter.id)
	).toSorted(
		(a, b) =>
			apart(hero, bodyOf(state, a.id)?.at ?? a.start) -
			apart(hero, bodyOf(state, b.id)?.at ?? b.start)
	);

	return foes[0]?.id ?? "";
};

const approach = (folded: Folded, foe: string): string => {
	const { state } = folded;
	const there = bodyOf(state, foe)?.at;
	const hero = bodyOf(state, HERO)?.at ?? BRANN.start;

	const goal = there ?? hero;
	const { cost } = reachFrom(state, HERO);

	const costOf = (square: Square) =>
		cost[square.y * COLUMNS + square.x] ?? Infinity;

	const open = reachable(state).toSorted(
		(a, b) =>
			apart(a, goal) - apart(b, goal) ||
			costOf(a) - costOf(b) ||
			Math.abs(a.y - goal.y) - Math.abs(b.y - goal.y)
	);

	const [best] = open;

	return best === undefined ? "" : `/move brann ${nameOfSquare(best)}`;
};

export const suggestionsOf = (demo: Demo): Array<string> => {
	const folded = fold(demo.log);
	const { state } = folded;

	if (state.winner !== "") {
		return ["gg, all", "/roll 2d10+3"];
	}

	const foe = nearestFoe(folded);
	const hero = bodyOf(state, HERO);
	const there = bodyOf(state, foe)?.at;

	const close =
		hero !== undefined && there !== undefined && apart(hero.at, there) <= 1;

	const slinger = FIGHTERS.find(
		(fighter) => fighter.id === "bandit-slinger" && !isDead(state, fighter.id)
	);

	const stamina = hero?.stamina ?? 0;
	const tired = stamina > 0 && stamina <= 12 && !state.breathed;

	const next: Array<string> = [];

	if (close && !state.acted) {
		next.push(`/pr brann driving on ${fighterOf(foe).mark}`);
	}

	if (!state.acted && state.wrath >= 3 && slinger !== undefined) {
		next.push("/pr brann glare on s");
	}

	if (!close && movesLeft(state) > 0) {
		next.push(approach(folded, foe));
	}

	if (tired) {
		next.push("/recover brann");
	}

	next.push("/done");

	return [
		...next.filter((line) => line !== "").slice(0, 3),
		"/sheet b",
		"/dist B s",
	];
};

export const hintOf = (demo: Demo): string => {
	const { state } = fold(demo.log);

	if (state.winner !== "") {
		return "the fight is over · start over to play it again";
	}

	if (
		demo.line.startsWith("/move brann") ||
		demo.line.startsWith("/pr brann")
	) {
		return "Enter sends it";
	}

	return state.turn === HERO
		? `your turn · ${movesLeft(state)} movement left${state.acted ? "" : " · main action ready"} · /done ends it`
		: "";
};
