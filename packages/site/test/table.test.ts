import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { BRANN, BRUISER, HERO, nameOfSquare } from "../src/Encounter.ts";
import {
	bodyOf,
	fold,
	Happened,
	lineOf,
	reachable,
	TYPES,
	YOU,
} from "../src/Rules.ts";
import {
	clickedSquare,
	clickedToken,
	DEMO,
	Demo,
	escaped,
	recalled,
	restarted,
	sent,
	suggestionsOf,
	toggledLog,
	typed,
	submitted,
} from "../src/Table.ts";

const play = (...lines: ReadonlyArray<string>): Demo => {
	let demo = DEMO;

	for (const line of lines) {
		demo = sent(demo, line);
	}

	return demo;
};

const stateOf = (demo: Demo) => fold(demo.log).state;

const textOf = (demo: Demo): Array<string> =>
	fold(demo.log).feed.map((line) => line.text);

const at = (demo: Demo, id: string): string => {
	const body = bodyOf(stateOf(demo), id);

	return body === undefined ? "" : nameOfSquare(body.at);
};

describe("the demo table at the start", () => {
	test("is round 1, Brann's turn, with the map loaded and three tokens placed", () => {
		const state = stateOf(DEMO);

		expect(state.round).toBe(1);
		expect(state.turn).toBe(HERO);
		expect(state.wrath).toBe(2);
		expect(state.bodies.map((body) => body.id)).toStrictEqual([
			"brann",
			"bandit-bruiser",
			"bandit-slinger",
		]);
		expect(at(DEMO, HERO)).toBe("b4");
		expect(textOf(DEMO)).toContain("Combat begins, round 1.");
		expect(textOf(DEMO)).toContain("Brann's turn. wrath +2 → 2.");
	});

	test("tints only the squares Brann can reach with his speed", () => {
		const open = reachable(stateOf(DEMO)).map(nameOfSquare);

		expect(open).toContain("g4");
		expect(open).not.toContain("h4");
		expect(open).not.toContain("b4");
	});
});

describe("a move", () => {
	test("goes by the cheapest path and spends Brann's movement", () => {
		const demo = play("/move brann g4");
		const state = stateOf(demo);

		expect(at(demo, HERO)).toBe("g4");
		expect(state.spent).toBe(5);
		expect(reachable(state)).toStrictEqual([]);
		expect(textOf(demo)).toContain(
			"Brann moves to g4 (5 squares of movement)."
		);
		expect(demo.line).toBe("");
		expect(demo.refusal).toBe("");
	});

	test("that is too far is refused, says why, and leaves the log alone", () => {
		const demo = play("/move brann k4");

		expect(demo.log).toStrictEqual(DEMO.log);
		expect(demo.refusal).toStartWith(
			"Refused: Brann can't move that far: k4 takes"
		);
		expect(demo.refusal).toEndWith("and Brann's speed is 5.");
	});

	test("of a bandit is the GM's to make", () => {
		expect(play("/move b h5").refusal).toBe(
			"Refused: You play Brann; Bandit Bruiser is the GM's to run."
		);
	});

	test("with main spends the main action for a second speed's worth", () => {
		const demo = play("/move brann g4", "/move brann b4 main");

		expect(at(demo, HERO)).toBe("b4");
		expect(stateOf(demo).acted).toBeTruthy();
		expect(
			play("/move brann g4", "/move brann b4 main", "/pr brann driving on b")
				.refusal
		).toBe("Refused: Brann has used its main action this turn.");
	});

	test("onto a wall or a creature is refused", () => {
		expect(play("/move brann b2").refusal).toBe("Refused: b2 is a wall.");
		expect(play("/move brann h4").refusal).toContain(
			"nobody ends a move on another creature"
		);
		expect(play("/move brann z9").refusal).toBe(
			"Refused: z9 isn't a square on this map (a1 to n7)."
		);
	});
});

describe("undo", () => {
	test("takes back a move, keeps the line struck through and adds one marked ↶", () => {
		const demo = play("/move brann g4", "/undo");
		const { feed } = fold(demo.log);

		expect(at(demo, HERO)).toBe("b4");
		expect(stateOf(demo).spent).toBe(0);
		expect(
			feed.find((line) => line.text.startsWith("Brann moves"))?.taken
		).toBeTruthy();
		expect(feed.at(-1)?.text).toBe(
			"↶ You (Brann) undid: Brann moves to g4 (5 squares of movement)."
		);
		expect(demo.log.at(-1)?.event).toStrictEqual(
			Happened.Retracted({
				seqs: [demo.log.length - 1],
				undone: ["Brann moves to g4 (5 squares of movement)."],
			})
		);
	});

	test("won't take back a power roll, so nobody rolls again by undoing", () => {
		expect(
			play("/move brann g4", "/pr brann driving on b", "/undo").refusal
		).toBe(
			"Refused: A change that rolled dice is the GM's alone to take back, so nobody rolls again by undoing."
		);
	});

	test("finds nothing of yours to take back at the start", () => {
		expect(play("/undo").refusal).toStartWith("Refused: Nothing of yours");
	});
});

describe("a power roll", () => {
	test("rolls 2d10 plus might, deals its tier's damage and uses the main action", () => {
		const demo = play("/move brann g4", "/pr brann driving on b");

		const rolled = demo.log.find((entry) =>
			Happened.guards.PowerRolled(entry.event)
		);

		const event = rolled?.event;

		expect(
			event !== undefined && Happened.guards.PowerRolled(event)
		).toBeTruthy();

		if (event === undefined || !Happened.guards.PowerRolled(event)) {
			return;
		}

		const [first = 0, second = 0] = event.dice;
		const dealt = [5, 7, 10][event.tier - 1] ?? 0;

		expect(event.total).toBe(first + second + 2);
		expect(bodyOf(stateOf(demo), BRUISER.id)?.stamina).toBe(
			BRUISER.stamina - dealt
		);
		expect(stateOf(demo).acted).toBeTruthy();
		expect(demo.seed).not.toBe(DEMO.seed);
	});

	test("is the same roll every time from the same seed, as replay needs", () => {
		const one = play("/move brann g4", "/pr brann driving on b", "/done");
		const other = play("/move brann g4", "/pr brann driving on b", "/done");

		expect(one.log).toStrictEqual(other.log);
		expect(fold(one.log)).toStrictEqual(fold(other.log));
	});

	test("with an ability that costs more wrath than Brann has is refused", () => {
		expect(play("/pr brann glare on s").refusal).toBe(
			"Refused: Accusing Glare costs 3 wrath, and Brann has 2."
		);
	});

	test("names an ambiguous target instead of guessing", () => {
		expect(play("/pr brann driving on bandit").refusal).toBe(
			"Refused: bandit could be Bandit Bruiser or Bandit Slinger."
		);
	});
});

describe("ending Brann's turn", () => {
	test("hands the table to the GM, who runs each bandit, then starts round 2", () => {
		const demo = play("/move brann g4", "/done");
		const state = stateOf(demo);

		const actors = new Set(
			demo.log.slice(DEMO.log.length).map((entry) => entry.actor)
		);

		expect(state.round).toBe(2);
		expect(state.turn).toBe(HERO);
		expect(state.wrath).toBe(4);
		expect(state.spent).toBe(0);
		expect(actors).toStrictEqual(new Set([YOU, "gm"]));
		expect(textOf(demo)).toContain("Bandit Bruiser's turn.");
		expect(textOf(demo)).toContain("Bandit Slinger's turn.");
		expect(textOf(demo)).toContain("Round 2.");
		expect(
			(bodyOf(state, HERO)?.stamina ?? BRANN.stamina) < BRANN.stamina
		).toBeTruthy();
	});

	test("played out by the suggestions, ends the fight one way or the other", () => {
		let demo = DEMO;

		for (let step = 0; step < 120 && stateOf(demo).winner === ""; step += 1) {
			demo = sent(demo, suggestionsOf(demo)[0] ?? "/done");
		}

		expect(["heroes", "director"]).toContain(stateOf(demo).winner);
		expect(textOf(demo).at(-1)).toStartWith("Combat ends.");
		expect(play().refusal).toBe("");
		expect(sent(demo, "/done").refusal).toBe(
			"Refused: The fight is over. Start over to play it again."
		);
	});
});

const Envelope = Schema.fromJsonString(
	Schema.Struct({
		actor: Schema.String,
		seq: Schema.Int,
		timestamp: Schema.String,
		type: Schema.String,
		payload: Schema.Struct({ id: Schema.String }),
	})
);

const Keys = Schema.fromJsonString(
	Schema.Record(Schema.String, Schema.Unknown)
);

describe("the log", () => {
	test("writes each event as one envelope line, typed as the real table types it", () => {
		const demo = play("/move brann g4");
		const line = demo.log.slice(-1).map(lineOf).join("");
		const parsed = Schema.decodeSync(Envelope)(line);

		expect(Object.keys(Schema.decodeSync(Keys)(line))).toStrictEqual([
			"actor",
			"seq",
			"timestamp",
			"type",
			"payload",
		]);
		expect(parsed.type).toBe(TYPES.Moved);
		expect(parsed.actor).toBe(YOU);
		expect(parsed.seq).toBe(demo.log.length);
		expect(parsed.payload.id).toBe("brann");
		expect(line).toContain('"cost":5');
	});

	test("gives one command's events one timestamp", () => {
		const demo = play("/move brann g4", "/pr brann driving on b");

		const latest = demo.log
			.slice(-2)
			.map((entry) => Schema.decodeSync(Envelope)(lineOf(entry)).timestamp);

		expect(new Set(latest).size).toBe(1);
	});

	test("folds to the same table after a trip through JSON, as Foldkit's model must", () => {
		const demo = play("/move brann g4", "hello table", "/roll 2d10+3", "/done");
		const codec = Schema.fromJsonString(Demo);

		const back = Schema.decodeSync(codec)(Schema.encodeSync(codec)(demo));

		expect(back).toStrictEqual(demo);
		expect(fold(back.log)).toStrictEqual(fold(demo.log));
	});
});

describe("the input line", () => {
	test("sends plain text as chat and /roll as dice for the table", () => {
		const demo = play("hello table", "/roll 2d10+3");
		const { feed } = fold(demo.log);
		const rolled = feed.at(-1);

		expect(feed.at(-2)).toMatchObject({
			kind: "chat",
			who: "You (Brann)",
			text: "hello table",
		});
		expect(rolled?.text).toMatch(/^rolls 2d10\+3: \[\d+, \d+\] \+3 = \d+$/u);
	});

	test("opens /help and /sheet as a reply just for you, without logging them", () => {
		const helped = play("/help");
		const sheet = play("/sheet b");

		expect(helped.reply?.title).toBe("help");
		expect(helped.log).toStrictEqual(DEMO.log);
		expect(sheet.reply?.lines[0]).toBe(
			"Bandit Bruiser (b) · Brute, level 1 platoon"
		);
		expect(escaped(helped).reply).toBeNull();
	});

	test("refuses a command it doesn't know, and Up brings the line back", () => {
		const demo = submitted(typed(DEMO, "/strike b"));

		expect(demo.refusal).toBe(
			"Refused: There's no /strike at this table; /help lists what this demo knows."
		);
		expect(demo.line).toBe("");
		expect(recalled(demo, 1).line).toBe("/strike b");
		expect(recalled(recalled(demo, 1), -1).line).toBe("");
	});

	test("explains that a free strike is the GM's", () => {
		expect(play("/fs b brann").refusal).toBe(
			"Refused: /fs is the GM's: a creature's free strike. Brann strikes with /pr."
		);
	});
});

describe("a click", () => {
	test("on a square Brann can reach types the move", () => {
		expect(clickedSquare(DEMO, "g4").line).toBe("/move brann g4");
	});

	test("on a square out of reach types its name", () => {
		expect(clickedSquare(typed(DEMO, "/dist B"), "n7").line).toBe("/dist B n7");
	});

	test("on a bandit beside Brann types the strike", () => {
		expect(clickedToken(play("/move brann g4"), BRUISER.id).line).toBe(
			"/pr brann driving on b"
		);
		expect(clickedToken(DEMO, BRUISER.id).line).toBe("b");
	});
});

describe("the buttons under the table", () => {
	test("show the log and start over with it still showing", () => {
		const demo = toggledLog(play("/move brann g4"));
		const fresh = restarted(demo);

		expect(demo.showLog).toBeTruthy();
		expect(fresh.log).toStrictEqual(DEMO.log);
		expect(fresh.showLog).toBeTruthy();
	});

	test("suggest a first move toward the nearest bandit", () => {
		expect(suggestionsOf(DEMO)[0]).toBe("/move brann g4");
	});
});
