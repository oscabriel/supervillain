// Spike B's shared table: one in-memory encounter every screen draws, and the
// chat-first command grammar that changes it. Mock rules, not Draw Steel.
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";

export type Side = "heroes" | "enemies";
export type Until = "eot" | "save" | "end";

export interface Condition {
	readonly name: string;
	readonly until: Until;
}

export interface Combatant {
	readonly id: string;
	readonly name: string;
	/** Two characters: one map cell. */
	readonly tag: string;
	readonly side: Side;
	stamina: { current: number; max: number };
	conditions: Condition[];
	pos: { x: number; y: number };
	acted: boolean;
}

export interface Game {
	combatants: Combatant[];
	round: number;
	acting: string | null;
}

export interface Player {
	readonly key: string;
	name: string | null;
	heroId: string | null;
	gm: boolean;
	online: number;
}

export type FeedKind = "chat" | "action" | "roll" | "system";

export interface FeedEntry {
	readonly kind: FeedKind;
	/** A player key; screens resolve the current name when they draw. */
	readonly who: string | null;
	readonly text: string;
}

export const CONDITIONS = [
	"bleeding",
	"dazed",
	"frightened",
	"grabbed",
	"prone",
	"restrained",
	"slowed",
	"taunted",
	"weakened",
] as const;

export const COMMANDS: readonly {
	name: string;
	syntax: string;
	about: string;
}[] = [
	{ about: "2d10 shows the tier", name: "roll", syntax: "/roll 2d10+2" },
	{ about: "deal damage", name: "dmg", syntax: "/dmg <who> <n>" },
	{ about: "heal", name: "heal", syntax: "/heal <who> <n>" },
	{
		about: "toggle; eot/save ends it",
		name: "cond",
		syntax: "/cond <who> <what> [eot|save]",
	},
	{ about: "start a turn, or end it", name: "turn", syntax: "/turn [who]" },
	{ about: "move a token", name: "move", syntax: "/move <who> <cell>" },
	{ about: "take back the last change", name: "undo", syntax: "/undo" },
	{ about: "what you're called", name: "name", syntax: "/name <name>" },
	{ about: "play another hero", name: "play", syntax: "/play <hero>" },
	{ about: "who is here", name: "who", syntax: "/who" },
	{ about: "this list", name: "help", syntax: "/help" },
];

const ALIASES: Readonly<Record<string, string>> = {
	"?": "help",
	condition: "cond",
	damage: "dmg",
	end: "turn",
	mv: "move",
	r: "roll",
};

export const MAP = [
	"################",
	"#......#.......#",
	"#......+.......#",
	"#..~~..#.......#",
	"#..~~..###+#####",
	"#..............#",
	"#..............#",
	"####...........#",
	"#..............#",
	"################",
];
export const MAP_WIDTH = 16;
export const MAP_HEIGHT = MAP.length;

export const cellName = (x: number, y: number): string =>
	`${String.fromCodePoint(97 + x)}${y + 1}`;

const parseCell = (text: string): { x: number; y: number } | null => {
	const match = /^([a-z])(\d{1,2})$/u.exec(text.toLowerCase());
	if (match === null) {
		return null;
	}
	return {
		x: (match[1] as string).codePointAt(0)! - 97,
		y: Number(match[2]) - 1,
	};
};

/** Draw Steel counts a diagonal as one square. */
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
	Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const combatant = (
	id: string,
	name: string,
	tag: string,
	side: Side,
	max: number,
	x: number,
	y: number
): Combatant => ({
	acted: false,
	conditions: [],
	id,
	name,
	pos: { x, y },
	side,
	stamina: { current: max, max },
	tag,
});

const startingGame = (): Game => ({
	acting: null,
	combatants: [
		combatant("vex", "Vex", "Ve", "heroes", 21, 2, 5),
		combatant("coda", "Coda", "Co", "heroes", 24, 3, 6),
		combatant("ash", "Ash", "As", "heroes", 18, 1, 6),
		combatant("g1", "Goblin 1", "g1", "enemies", 15, 10, 2),
		combatant("g2", "Goblin 2", "g2", "enemies", 15, 12, 1),
		combatant("g3", "Goblin 3", "g3", "enemies", 15, 11, 3),
		combatant("ga", "Goblin Archer", "ga", "enemies", 12, 13, 2),
	],
	round: 1,
});

export const windedAt = (max: number) => Math.floor(max / 2);

export const staminaStatus = (c: Combatant): string => {
	const { current, max } = c.stamina;
	if (c.side === "heroes") {
		if (current <= -windedAt(max)) {
			return "dead";
		}
		if (current <= 0) {
			return "dying";
		}
	} else if (current <= 0) {
		return "dead";
	}
	return current <= windedAt(max) ? "winded" : "";
};

const describe = (c: Combatant): string => {
	const status = staminaStatus(c);
	return `${c.stamina.current}/${c.stamina.max}${status === "" ? "" : ` · ${status}`}`;
};

export interface RunResult {
	/** Lines only the typist sees. */
	readonly notice?: readonly string[];
}

const say = (...lines: string[]): RunResult => ({ notice: lines });

export class World {
	readonly players = new Map<string, Player>();
	game: Game = startingGame();
	readonly feed: FeedEntry[] = [];
	readonly #undo: { key: string; label: string; before: Game }[] = [];
	readonly #listeners = new Set<() => void>();
	readonly #names: Record<string, string>;

	constructor(
		readonly namesFile: string,
		readonly logFile: string
	) {
		this.#names = existsSync(namesFile)
			? (JSON.parse(readFileSync(namesFile, "utf8")) as Record<string, string>)
			: {};
		this.#post("system", null, "The Burning Keep. Three heroes, four goblins.");
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}

	#post(kind: FeedKind, who: string | null, text: string): void {
		this.feed.push({ kind, text, who });
	}

	label(key: string | null): string {
		if (key === null) {
			return "";
		}
		return this.players.get(key)?.name ?? "someone";
	}

	/** A connection arrived; returns whether this key still needs a name. */
	join(key: string): Player {
		let player = this.players.get(key);
		if (player === undefined) {
			const gm = ![...this.players.values()].some((p) => p.gm);
			player = {
				gm,
				heroId: null,
				key,
				name: this.#names[key] ?? null,
				online: 0,
			};
			this.players.set(key, player);
			if (player.name !== null) {
				this.#seat(player);
			}
		}
		player.online += 1;
		if (player.name !== null && player.online === 1) {
			this.#post("system", key, "is back at the table");
		}
		this.#changed();
		return player;
	}

	leave(key: string): void {
		const player = this.players.get(key);
		if (player === undefined) {
			return;
		}
		player.online -= 1;
		if (player.online === 0 && player.name !== null) {
			this.#post("system", key, "left the table");
		}
		this.#changed();
	}

	#seat(player: Player): void {
		if (player.gm || player.heroId !== null) {
			return;
		}
		const taken = new Set([...this.players.values()].map((p) => p.heroId));
		const hero = this.game.combatants.find(
			(c) => c.side === "heroes" && !taken.has(c.id)
		);
		player.heroId = hero?.id ?? null;
	}

	hero(player: Player): Combatant | undefined {
		return this.game.combatants.find((c) => c.id === player.heroId);
	}

	/** One typed line from one player: chat, a command, or their first name. */
	run(
		key: string,
		line: string,
		via: "typed" | "leader" | "click" = "typed"
	): RunResult {
		const result = this.#run(key, line.trim());
		appendFileSync(
			this.logFile,
			`${JSON.stringify({ at: new Date().toISOString(), line, notice: result.notice ?? null, via, who: this.label(key) })}\n`
		);
		this.#changed();
		return result;
	}

	// oxlint-disable-next-line eslint/complexity -- a mock grammar in one place.
	#run(key: string, line: string): RunResult {
		const player = this.players.get(key);
		if (player === undefined || line.length === 0) {
			return {};
		}
		if (player.name === null) {
			return this.#setName(player, line);
		}
		if (!line.startsWith("/")) {
			this.#post("chat", key, line);
			return {};
		}
		const [verb = "", ...args] = line.slice(1).split(/\s+/u);
		const name = ALIASES[verb.toLowerCase()] ?? verb.toLowerCase();
		switch (name) {
			case "help": {
				return say(
					"Type to chat. Commands:",
					...COMMANDS.map((c) => `${c.syntax} — ${c.about}`),
					"Tab completes · ↑↓ history · PgUp/PgDn scroll · Esc: quick actions"
				);
			}
			case "who": {
				return say(
					...[...this.players.values()].map(
						(p) =>
							`${p.name ?? "(naming)"}${p.gm ? " · GM" : ""}${this.hero(p) ? ` · plays ${this.hero(p)?.name}` : ""}${p.online > 0 ? "" : " · away"}`
					)
				);
			}
			case "name": {
				return this.#setName(player, args.join(" "));
			}
			case "play": {
				return this.#play(player, args.join(" "));
			}
			case "roll": {
				return this.#roll(key, args.join(""));
			}
			case "dmg":
			case "heal": {
				return this.#stamina(player, name, args);
			}
			case "cond": {
				return this.#condition(player, args);
			}
			case "turn": {
				return this.#turn(player, args.join(" "));
			}
			case "move": {
				return this.#move(player, args);
			}
			case "undo": {
				return this.#undoLast(player);
			}
			default: {
				return say(`No command /${verb}. Try /help.`);
			}
		}
	}

	#setName(player: Player, raw: string): RunResult {
		const name = raw.replaceAll(/\s+/gu, " ").trim();
		if (name.length === 0 || name.length > 24) {
			return say("A name is 1 to 24 characters.");
		}
		const first = player.name === null;
		const old = player.name;
		player.name = name;
		this.#names[player.key] = name;
		writeFileSync(this.namesFile, JSON.stringify(this.#names, null, 2));
		if (!first) {
			this.#post("system", null, `${old} is now ${name}`);
			return {};
		}
		this.#seat(player);
		const hero = this.hero(player);
		this.#post(
			"system",
			player.key,
			player.gm
				? "sat down as the GM"
				: `sat down${hero ? ` and plays ${hero.name}` : ""}`
		);
		return say(
			player.gm
				? "You're the GM. Try /help, or Esc for one-key actions."
				: `You're playing ${hero?.name ?? "no one yet"}. Try /help, or Esc for one-key actions.`
		);
	}

	#play(player: Player, query: string): RunResult {
		const target = this.resolve(query);
		if ("error" in target) {
			return say(target.error);
		}
		if (target.side !== "heroes") {
			return say(`${target.name} is not a hero.`);
		}
		const holder = [...this.players.values()].find(
			(p) => p.heroId === target.id
		);
		if (holder !== undefined && holder !== player) {
			return say(`${holder.name} already plays ${target.name}.`);
		}
		player.heroId = target.id;
		this.#post("system", player.key, `now plays ${target.name}`);
		return {};
	}

	resolve(query: string): Combatant | { error: string } {
		const wanted = query.trim().toLowerCase();
		if (wanted.length === 0) {
			return { error: "Who? Name a hero or creature." };
		}
		const all = this.game.combatants;
		const exact = all.find(
			(c) => c.name.toLowerCase() === wanted || c.tag.toLowerCase() === wanted
		);
		if (exact !== undefined) {
			return exact;
		}
		const matches = all.filter((c) => c.name.toLowerCase().startsWith(wanted));
		if (matches.length === 1) {
			return matches[0] as Combatant;
		}
		if (matches.length > 1) {
			return {
				error: `'${query}' could be ${matches.map((c) => c.name).join(", ")}.`,
			};
		}
		return { error: `No one called '${query}'.` };
	}

	#checkpoint(key: string, label: string): void {
		this.#undo.push({ before: structuredClone(this.game), key, label });
		if (this.#undo.length > 20) {
			this.#undo.shift();
		}
	}

	#roll(key: string, notation: string): RunResult {
		const match = /^(\d{0,2})d(\d{1,3})([+-]\d{1,3})?$/iu.exec(notation);
		if (match === null) {
			return say("Usage: /roll 2d10+2");
		}
		const count = Number(match[1] === "" ? 1 : match[1]);
		const sides = Number(match[2]);
		const bonus = Number(match[3] ?? 0);
		if (count < 1 || count > 20 || sides < 2) {
			return say("Roll 1 to 20 dice with at least 2 sides.");
		}
		const dice = Array.from(
			{ length: count },
			() => 1 + Math.floor(Math.random() * sides)
		);
		const total = dice.reduce((sum, die) => sum + die, bonus);
		const tier =
			count === 2 && sides === 10
				? ` · tier ${total >= 17 ? 3 : total >= 12 ? 2 : 1}`
				: "";
		const shown = `${dice.join(" + ")}${bonus === 0 ? "" : ` ${bonus > 0 ? "+" : "−"} ${Math.abs(bonus)}`}`;
		this.#post("roll", key, `rolls ${notation}: ${shown} = ${total}${tier}`);
		return {};
	}

	#stamina(player: Player, verb: "dmg" | "heal", args: string[]): RunResult {
		const amount = Number(args.at(-1));
		if (
			args.length < 2 ||
			!Number.isInteger(amount) ||
			amount < 1 ||
			amount > 999
		) {
			return say(`Usage: /${verb} <who> <amount>`);
		}
		const target = this.resolve(args.slice(0, -1).join(" "));
		if ("error" in target) {
			return say(target.error);
		}
		const { stamina } = target;
		const floor = target.side === "heroes" ? -windedAt(stamina.max) : 0;
		if (verb === "dmg" && stamina.current <= floor) {
			return say(
				`${target.name} is already ${target.side === "heroes" ? "dead" : "down"}.`
			);
		}
		if (verb === "heal" && stamina.current >= stamina.max) {
			return say(`${target.name} is already at full Stamina.`);
		}
		const text =
			verb === "dmg"
				? `${target.name} takes ${amount} damage`
				: `${target.name} heals ${amount}`;
		this.#checkpoint(player.key, text);
		stamina.current =
			verb === "dmg"
				? Math.max(floor, stamina.current - amount)
				: Math.min(stamina.max, stamina.current + amount);
		this.#post("action", player.key, `${text} → ${describe(target)}`);
		return {};
	}

	#condition(player: Player, args: string[]): RunResult {
		let until: Until = "end";
		const last = args.at(-1)?.toLowerCase();
		if (last === "eot" || last === "save" || last === "end") {
			until = last;
			args = args.slice(0, -1);
		}
		const condition = args.at(-1)?.toLowerCase() ?? "";
		const known = CONDITIONS.filter((c) => c.startsWith(condition));
		if (args.length < 2 || condition.length === 0 || known.length !== 1) {
			return say(
				`Usage: /cond <who> <condition> [eot|save]. Conditions: ${CONDITIONS.join(", ")}.`
			);
		}
		const name = known[0] as string;
		const target = this.resolve(args.slice(0, -1).join(" "));
		if ("error" in target) {
			return say(target.error);
		}
		const had = target.conditions.some((c) => c.name === name);
		const text = had
			? `${target.name} is no longer ${name}`
			: `${target.name} is ${name}${until === "eot" ? " (end of turn)" : until === "save" ? " (save ends)" : ""}`;
		this.#checkpoint(player.key, text);
		target.conditions = had
			? target.conditions.filter((c) => c.name !== name)
			: [...target.conditions, { name, until }];
		this.#post("action", player.key, text);
		return {};
	}

	#mayControl(player: Player, target: Combatant): boolean {
		return player.gm || player.heroId === target.id;
	}

	#turn(player: Player, query: string): RunResult {
		const { game } = this;
		if (query.length === 0) {
			const acting = game.combatants.find((c) => c.id === game.acting);
			if (acting === undefined) {
				return say("No one is taking a turn. /turn <who> starts one.");
			}
			if (!this.#mayControl(player, acting)) {
				return say(`Only the GM or ${acting.name}'s player can end that turn.`);
			}
			this.#checkpoint(player.key, `${acting.name} ends their turn`);
			acting.acted = true;
			game.acting = null;
			const ended = acting.conditions.filter((c) => c.until === "eot");
			acting.conditions = acting.conditions.filter((c) => c.until !== "eot");
			this.#post(
				"action",
				player.key,
				`${acting.name} ends their turn${ended.length > 0 ? `; no longer ${ended.map((c) => c.name).join(", ")}` : ""}`
			);
			if (
				game.combatants.every((c) => c.acted || staminaStatus(c) === "dead")
			) {
				game.round += 1;
				for (const c of game.combatants) {
					c.acted = false;
				}
				this.#post("system", null, `Round ${game.round}`);
			}
			return {};
		}
		const target = this.resolve(query);
		if ("error" in target) {
			return say(target.error);
		}
		if (!this.#mayControl(player, target)) {
			return say(`Only the GM or ${target.name}'s player can start that turn.`);
		}
		if (target.acted) {
			return say(`${target.name} has already acted this round.`);
		}
		if (game.acting !== null) {
			const acting = game.combatants.find((c) => c.id === game.acting);
			return say(`${acting?.name} is still taking their turn. /turn ends it.`);
		}
		this.#checkpoint(player.key, `${target.name} starts their turn`);
		game.acting = target.id;
		this.#post("action", player.key, `${target.name} starts their turn`);
		return {};
	}

	#move(player: Player, args: string[]): RunResult {
		const cell = parseCell(args.at(-1) ?? "");
		if (args.length < 2 || cell === null) {
			return say("Usage: /move <who> <cell, e.g. d5>");
		}
		const target = this.resolve(args.slice(0, -1).join(" "));
		if ("error" in target) {
			return say(target.error);
		}
		return this.moveTo(player, target, cell);
	}

	moveTo(
		player: Player,
		target: Combatant,
		cell: { x: number; y: number }
	): RunResult {
		if (!this.#mayControl(player, target)) {
			return say(
				`Only the GM or ${target.name}'s player can move ${target.name}.`
			);
		}
		const terrain = MAP[cell.y]?.[cell.x];
		if (terrain === undefined || terrain === "#") {
			return say(`${cellName(cell.x, cell.y)} is a wall or off the map.`);
		}
		const blocker = this.game.combatants.find(
			(c) => c !== target && c.pos.x === cell.x && c.pos.y === cell.y
		);
		if (blocker !== undefined) {
			return say(`${blocker.name} is standing on ${cellName(cell.x, cell.y)}.`);
		}
		const squares = distance(target.pos, cell);
		const text = `${target.name} moves to ${cellName(cell.x, cell.y)} (${squares} ${squares === 1 ? "square" : "squares"})`;
		this.#checkpoint(player.key, text);
		target.pos = cell;
		this.#post("action", player.key, text);
		return {};
	}

	#undoLast(player: Player): RunResult {
		const last = this.#undo.at(-1);
		if (last === undefined) {
			return say("Nothing to undo.");
		}
		if (!player.gm && last.key !== player.key) {
			return say(
				`The last change was ${this.label(last.key)}'s. Only the GM can undo it.`
			);
		}
		this.#undo.pop();
		this.game = last.before;
		this.#post("action", player.key, `undid: ${last.label}`);
		return {};
	}
}
