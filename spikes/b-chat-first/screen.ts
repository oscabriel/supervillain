// Spike B's one layout: a top band with initiative and Stamina, the map and the
// feed side by side, a hint row, and an input line that always owns the keyboard.
import {
	BoxRenderable,
	InputRenderableEvents,
	InputRenderable,
	RGBA,
	ScrollBoxRenderable,
	StyledText,
	TextAttributes,
	TextRenderable,
} from "./deps.js";
import type { CliRenderer, KeyEvent, MouseEvent, TextChunk } from "./deps.js";
import {
	cellName,
	COMMANDS,
	CONDITIONS,
	MAP,
	MAP_HEIGHT,
	MAP_WIDTH,
	staminaStatus,
} from "./world.js";
import type { Combatant, FeedEntry, World } from "./world.js";

const COLORS = {
	dead: "#6b6b6b",
	enemy: "#ff6b6b",
	floor: "#4a4a4a",
	gm: "#f2c14e",
	hero: "#5fd787",
	hint: "#8a8a8a",
	muted: "#8a8a8a",
	text: "#e4e4e4",
	wall: "#8f8f8f",
	water: "#5f87d7",
	winded: "#f2c14e",
	door: "#b08a5a",
};
const PLAYER_COLORS = ["#5fd7ff", "#d787ff", "#ffaf5f", "#87d7af", "#ff87af"];

const chunk = (text: string, fg: string, attributes = 0): TextChunk => ({
	__isChunk: true,
	attributes,
	fg: RGBA.fromHex(fg),
	text,
});

const colorFor = (world: World, key: string | null): string => {
	if (key === null) {
		return COLORS.muted;
	}
	if (world.players.get(key)?.gm) {
		return COLORS.gm;
	}
	let hash = 0;
	for (const character of key) {
		hash = (hash * 31 + character.codePointAt(0)!) % 997;
	}
	return PLAYER_COLORS[hash % PLAYER_COLORS.length] as string;
};

const meter = (c: Combatant, width: number): TextChunk[] => {
	const { current, max } = c.stamina;
	const filled = Math.max(
		0,
		Math.min(width, Math.round((current / max) * width))
	);
	const status = staminaStatus(c);
	const color =
		status === ""
			? COLORS.hero
			: status === "winded"
				? COLORS.winded
				: COLORS.enemy;
	return [
		chunk("█".repeat(filled), color),
		chunk("░".repeat(width - filled), COLORS.floor),
	];
};

export interface ScreenOptions {
	readonly renderer: CliRenderer;
	readonly world: World;
	readonly key: string;
	readonly quit: () => void;
}

type Mode =
	| { kind: "normal" }
	| { kind: "leader" }
	| { kind: "move"; tokenId: string; x: number; y: number };

// oxlint-disable-next-line eslint/max-statements -- a mock screen in one place.
export const mountScreen = (options: ScreenOptions): (() => void) => {
	const { key, renderer, world } = options;
	const connectedAt = performance.now();
	const player = world.join(key);
	let mode: Mode = { kind: "normal" };
	let hint: TextChunk[] | null = null;
	const notices: { at: number; text: string }[] = [];
	const history: string[] = [];
	let historyAt = 0;
	let selectedToken: string | null = null;

	const root = new BoxRenderable(renderer, {
		flexDirection: "column",
		height: "100%",
		width: "100%",
	});
	const header = new TextRenderable(renderer, {
		content: "",
		height: 1,
		wrapMode: "none",
	});
	const band = new BoxRenderable(renderer, {
		border: true,
		borderColor: COLORS.floor,
		flexDirection: "row",
		height: 6,
		title: "initiative",
		width: "100%",
	});
	const heroesText = new TextRenderable(renderer, {
		content: "",
		flexGrow: 1,
		wrapMode: "none",
	});
	const enemiesText = new TextRenderable(renderer, {
		content: "",
		flexGrow: 1,
		wrapMode: "none",
	});
	band.add(heroesText);
	band.add(enemiesText);
	const main = new BoxRenderable(renderer, {
		flexDirection: "row",
		flexGrow: 1,
		width: "100%",
	});
	const mapBox = new BoxRenderable(renderer, {
		border: true,
		borderColor: COLORS.floor,
		title: "map",
		width: 2 + MAP_WIDTH * 2 + 2,
	});
	const mapText = new TextRenderable(renderer, {
		content: "",
		wrapMode: "none",
	});
	mapBox.add(mapText);
	const legend = new TextRenderable(renderer, {
		content: new StyledText([
			chunk("\n Ve", COLORS.hero, TextAttributes.BOLD),
			chunk(" hero  ", COLORS.muted),
			chunk("g1", COLORS.enemy, TextAttributes.BOLD),
			chunk(" enemy\n ", COLORS.muted),
			chunk("▒▒", COLORS.door),
			chunk(" door  ", COLORS.muted),
			chunk("≈≈", COLORS.water),
			chunk(" water\n click a square to move there", COLORS.muted),
		]),
		wrapMode: "none",
	});
	mapBox.add(legend);
	const feedBox = new BoxRenderable(renderer, {
		border: true,
		borderColor: COLORS.floor,
		flexGrow: 1,
		title: "table",
	});
	const feed = new ScrollBoxRenderable(renderer, {
		flexGrow: 1,
		rootOptions: { flexGrow: 1 },
		stickyScroll: true,
		stickyStart: "bottom",
	});
	const feedText = new TextRenderable(renderer, { content: "", width: "100%" });
	feed.add(feedText);
	feedBox.add(feed);
	main.add(mapBox);
	main.add(feedBox);
	const hintText = new TextRenderable(renderer, {
		content: "",
		height: 1,
		wrapMode: "none",
	});
	const inputBox = new BoxRenderable(renderer, {
		border: true,
		borderColor: COLORS.muted,
		flexDirection: "row",
		height: 3,
		width: "100%",
	});
	const prompt = new TextRenderable(renderer, {
		content: "",
		wrapMode: "none",
	});
	const input = new InputRenderable(renderer, {
		cursorColor: COLORS.gm,
		flexGrow: 1,
		maxLength: 500,
		placeholder: "",
		placeholderColor: COLORS.muted,
		textColor: COLORS.text,
	});
	inputBox.add(prompt);
	inputBox.add(input);
	root.add(header);
	root.add(band);
	root.add(main);
	root.add(hintText);
	root.add(inputBox);
	renderer.root.add(root);
	input.focus();

	const heroOf = () => world.hero(player);

	const notify = (lines: readonly string[]) => {
		for (const text of lines) {
			notices.push({ at: world.feed.length, text });
		}
	};

	const run = (line: string, via: "typed" | "leader" | "click" = "typed") => {
		const wasNaming = player.name === null;
		const result = world.run(key, line, via);
		if (result.notice !== undefined) {
			notify(result.notice);
		}
		if (wasNaming && player.name !== null) {
			console.log(
				`seated: ${player.name} in ${((performance.now() - connectedAt) / 1000).toFixed(1)} s after connecting`
			);
		}
		draw();
	};

	const drawHeader = () => {
		const { game } = world;
		const acting = game.combatants.find((c) => c.id === game.acting);
		const here = [...world.players.values()].filter(
			(p) => p.online > 0 && p.name !== null
		);
		const chunks: TextChunk[] = [
			chunk(" The Burning Keep", COLORS.text, TextAttributes.BOLD),
			chunk(` · round ${game.round} · `, COLORS.muted),
			acting === undefined
				? chunk("pick who acts: /turn <who>", COLORS.muted)
				: chunk(
						`${acting.name} is acting`,
						acting.side === "heroes" ? COLORS.hero : COLORS.enemy
					),
			chunk("   ", COLORS.muted),
		];
		for (const [index, p] of here.entries()) {
			if (index > 0) {
				chunks.push(chunk(" · ", COLORS.muted));
			}
			chunks.push(
				chunk(`${p.name}${p.gm ? " (GM)" : ""}`, colorFor(world, p.key))
			);
		}
		header.content = new StyledText(chunks);
	};

	const bandLines = (side: "heroes" | "enemies"): StyledText => {
		const chunks: TextChunk[] = [];
		const { game } = world;
		for (const c of game.combatants.filter((x) => x.side === side)) {
			const status = staminaStatus(c);
			const marker = game.acting === c.id ? "▶ " : c.acted ? "✓ " : "  ";
			const holder = [...world.players.values()].find((p) => p.heroId === c.id);
			const dead = status === "dead";
			chunks.push(chunk(marker, COLORS.gm, TextAttributes.BOLD));
			chunks.push(
				chunk(
					c.name.padEnd(14),
					dead ? COLORS.dead : side === "heroes" ? COLORS.hero : COLORS.enemy,
					dead ? TextAttributes.STRIKETHROUGH : TextAttributes.BOLD
				)
			);
			chunks.push(...meter(c, 10));
			chunks.push(
				chunk(
					` ${String(c.stamina.current).padStart(3)}/${c.stamina.max}`,
					COLORS.text
				)
			);
			const tags = [
				...(status === "" ? [] : [status]),
				...c.conditions.map((x) =>
					x.until === "eot"
						? `${x.name}·eot`
						: x.until === "save"
							? `${x.name}·save`
							: x.name
				),
			];
			if (tags.length > 0) {
				chunks.push(chunk(` ${tags.join(" ")}`, COLORS.winded));
			}
			if (holder?.name) {
				chunks.push(chunk(` ${holder.name}`, colorFor(world, holder.key)));
			}
			chunks.push(chunk("\n", COLORS.text));
		}
		return new StyledText(chunks);
	};

	const drawMap = () => {
		const chunks: TextChunk[] = [chunk("  ", COLORS.muted)];
		for (let x = 0; x < MAP_WIDTH; x += 1) {
			chunks.push(chunk(`${String.fromCodePoint(97 + x)} `, COLORS.muted));
		}
		chunks.push(chunk("\n", COLORS.muted));
		const moving = mode.kind === "move" ? mode : null;
		for (let y = 0; y < MAP_HEIGHT; y += 1) {
			chunks.push(chunk(String(y + 1).padStart(2), COLORS.muted));
			for (let x = 0; x < MAP_WIDTH; x += 1) {
				const token = world.game.combatants.find(
					(c) => c.pos.x === x && c.pos.y === y
				);
				const ghost = moving !== null && moving.x === x && moving.y === y;
				if (ghost) {
					const who = world.game.combatants.find(
						(c) => c.id === moving.tokenId
					);
					chunks.push(
						chunk(
							who?.tag ?? "??",
							COLORS.gm,
							TextAttributes.INVERSE | TextAttributes.BOLD
						)
					);
					continue;
				}
				if (token !== undefined) {
					const dead = staminaStatus(token) === "dead";
					const attributes =
						(world.game.acting === token.id || selectedToken === token.id
							? TextAttributes.INVERSE
							: 0) | (dead ? TextAttributes.DIM : TextAttributes.BOLD);
					chunks.push(
						chunk(
							token.tag,
							dead
								? COLORS.dead
								: token.side === "heroes"
									? COLORS.hero
									: COLORS.enemy,
							attributes
						)
					);
					continue;
				}
				const terrain = MAP[y]?.[x];
				chunks.push(
					terrain === "#"
						? chunk("██", COLORS.wall)
						: terrain === "+"
							? chunk("▒▒", COLORS.door)
							: terrain === "~"
								? chunk("≈≈", COLORS.water)
								: chunk("· ", COLORS.floor)
				);
			}
			chunks.push(chunk("\n", COLORS.muted));
		}
		mapText.content = new StyledText(chunks);
	};

	const feedLine = (entry: FeedEntry): TextChunk[] => {
		const name = world.label(entry.who);
		const color = colorFor(world, entry.who);
		switch (entry.kind) {
			case "chat": {
				return [
					chunk(`${name}: `, color, TextAttributes.BOLD),
					chunk(entry.text, COLORS.text),
				];
			}
			case "roll": {
				return [
					chunk(`${name} `, color, TextAttributes.BOLD),
					chunk(entry.text, COLORS.gm),
				];
			}
			case "action": {
				return [
					chunk(entry.text.startsWith("undid") ? "↶ " : "▸ ", COLORS.gm),
					chunk(entry.text, COLORS.text),
					chunk(` · ${name}`, color),
				];
			}
			default: {
				return entry.who === null
					? [chunk(`— ${entry.text}`, COLORS.muted)]
					: [chunk(`— ${name} `, color), chunk(entry.text, COLORS.muted)];
			}
		}
	};

	const drawFeed = () => {
		const chunks: TextChunk[] = [];
		const lines: TextChunk[][] = [];
		let noticeIndex = 0;
		for (let index = 0; index <= world.feed.length; index += 1) {
			while (
				noticeIndex < notices.length &&
				(notices[noticeIndex]?.at ?? 0) <= index
			) {
				lines.push([
					chunk(
						`  ${notices[noticeIndex]?.text}`,
						COLORS.hint,
						TextAttributes.ITALIC
					),
				]);
				noticeIndex += 1;
			}
			const entry = world.feed[index];
			if (entry !== undefined) {
				lines.push(feedLine(entry));
			}
		}
		for (const [index, line] of lines.slice(-400).entries()) {
			if (index > 0) {
				chunks.push(chunk("\n", COLORS.text));
			}
			chunks.push(...line);
		}
		feedText.content = new StyledText(chunks);
	};

	const drawInput = () => {
		const naming = player.name === null;
		prompt.content = new StyledText([
			chunk(
				naming ? "name › " : `${player.name} › `,
				colorFor(world, key),
				TextAttributes.BOLD
			),
		]);
		prompt.width = naming ? 7 : (player.name?.length ?? 0) + 3;
		input.placeholder = naming
			? "What should the table call you?"
			: "Type to chat · /help for commands";
	};

	const drawHint = () => {
		let chunks: TextChunk[];
		if (player.name === null) {
			chunks = [
				chunk(
					" Welcome. Type the name the table should call you, then Enter.",
					COLORS.gm
				),
			];
		} else if (mode.kind === "leader") {
			chunks = [
				chunk(
					" ACTIONS ",
					COLORS.gm,
					TextAttributes.INVERSE | TextAttributes.BOLD
				),
				chunk(
					"  m move  t start/end my turn  u undo  r roll 2d10  ? help  Esc back",
					COLORS.text
				),
			];
		} else if (mode.kind === "move") {
			const token = world.game.combatants.find((c) => c.id === mode.tokenId);
			const squares =
				token === undefined
					? 0
					: Math.max(
							Math.abs(token.pos.x - mode.x),
							Math.abs(token.pos.y - mode.y)
						);
			chunks = [
				chunk(
					" MOVE ",
					COLORS.gm,
					TextAttributes.INVERSE | TextAttributes.BOLD
				),
				chunk(
					`  ${token?.name} → ${cellName(mode.x, mode.y)} · ${squares} squares   arrows/hjkl · Enter move${player.gm ? " · Tab next token" : ""} · Esc cancel`,
					COLORS.text
				),
			];
		} else if (hint !== null) {
			chunks = hint;
		} else {
			chunks = [
				chunk(
					" Enter send · Tab complete · ↑↓ history · PgUp/PgDn scroll · Esc actions · /help",
					COLORS.hint
				),
			];
		}
		hintText.content = new StyledText(chunks);
	};

	const draw = () => {
		drawHeader();
		heroesText.content = bandLines("heroes");
		enemiesText.content = bandLines("enemies");
		drawMap();
		drawFeed();
		drawInput();
		drawHint();
	};

	const commonPrefix = (words: string[]): string => {
		let prefix = words[0] ?? "";
		for (const word of words) {
			while (!word.toLowerCase().startsWith(prefix.toLowerCase())) {
				prefix = prefix.slice(0, -1);
			}
		}
		return prefix;
	};

	/** Completes the word being typed: a command, a name, or a condition. */
	const complete = () => {
		const value = input.value;
		if (!value.startsWith("/")) {
			return;
		}
		const space = value.indexOf(" ");
		let head: string;
		let typed: string;
		let options: string[];
		if (space === -1) {
			head = "/";
			typed = value.slice(1);
			options = COMMANDS.map((c) => c.name);
		} else {
			const verb = value.slice(1, space).toLowerCase();
			const rest = value.slice(space + 1);
			const names = world.game.combatants.map((c) => c.name);
			const named = names.find((n) =>
				rest.toLowerCase().startsWith(`${n.toLowerCase()} `)
			);
			if ((verb === "cond" || verb === "condition") && named !== undefined) {
				head = `${value.slice(0, space + 1)}${named} `;
				typed = rest.slice(named.length + 1);
				options = [...CONDITIONS];
			} else if (
				named === undefined &&
				[
					"dmg",
					"damage",
					"heal",
					"cond",
					"condition",
					"turn",
					"move",
					"mv",
					"play",
				].includes(verb)
			) {
				head = value.slice(0, space + 1);
				typed = rest;
				options =
					verb === "play"
						? world.game.combatants
								.filter((c) => c.side === "heroes")
								.map((c) => c.name)
						: names;
			} else {
				return;
			}
		}
		const matches = options.filter((o) =>
			o.toLowerCase().startsWith(typed.toLowerCase())
		);
		if (matches.length === 0) {
			hint = [chunk(` nothing matches '${typed}'`, COLORS.hint)];
			return;
		}
		if (matches.length === 1) {
			input.value = `${head}${matches[0]} `;
			hint = null;
			return;
		}
		const prefix = commonPrefix(matches);
		if (prefix.length > typed.length) {
			input.value = `${head}${prefix}`;
		}
		hint = [chunk(` ${matches.join(" · ")}`, COLORS.text)];
	};

	const consume = (event: KeyEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const myTurnToggle = (): string | null => {
		const hero = heroOf();
		const acting = world.game.acting;
		if (acting !== null && (player.gm || acting === hero?.id)) {
			return "/turn";
		}
		if (acting === null && hero !== undefined) {
			return `/turn ${hero.tag}`;
		}
		return null;
	};

	const startMove = () => {
		const hero = heroOf();
		const token =
			hero ??
			(player.gm
				? (world.game.combatants.find((c) => c.id === world.game.acting) ??
					world.game.combatants.find((c) => c.side === "enemies"))
				: undefined);
		if (token === undefined) {
			notify(["You have no token to move. /play <hero> picks one."]);
			mode = { kind: "normal" };
			return;
		}
		mode = { kind: "move", tokenId: token.id, x: token.pos.x, y: token.pos.y };
	};

	// oxlint-disable-next-line eslint/complexity -- the whole key grammar, on purpose in one place.
	const onKey = (event: KeyEvent) => {
		if (event.ctrl && event.name === "c") {
			consume(event);
			options.quit();
			return;
		}
		if (player.name === null) {
			return;
		}
		// Esc typed quickly before a key reaches us as Alt+key (a terminal sends
		// Alt as an Esc prefix), so Alt+key is the leader and that key at once.
		if (
			mode.kind === "normal" &&
			(event.meta || event.option) &&
			event.name.length === 1
		) {
			mode = { kind: "leader" };
		}
		if (mode.kind === "leader") {
			consume(event);
			mode = { kind: "normal" };
			if (event.name === "m") {
				startMove();
			} else if (event.name === "t") {
				const line = myTurnToggle();
				if (line === null) {
					notify(["It's not your turn to start or end."]);
				} else {
					run(line, "leader");
				}
			} else if (event.name === "u") {
				run("/undo", "leader");
			} else if (event.name === "r") {
				run("/roll 2d10", "leader");
			} else if (event.name === "?" || event.sequence === "?") {
				run("/help", "leader");
			}
			draw();
			return;
		}
		if (mode.kind === "move") {
			consume(event);
			const step: Record<string, [number, number]> = {
				down: [0, 1],
				h: [-1, 0],
				j: [0, 1],
				k: [0, -1],
				l: [1, 0],
				left: [-1, 0],
				right: [1, 0],
				up: [0, -1],
			};
			const delta = step[event.name];
			if (delta !== undefined) {
				mode.x = Math.max(0, Math.min(MAP_WIDTH - 1, mode.x + delta[0]));
				mode.y = Math.max(0, Math.min(MAP_HEIGHT - 1, mode.y + delta[1]));
			} else if (event.name === "tab" && player.gm) {
				const all = world.game.combatants;
				const next = all[
					(all.findIndex(
						(c) => c.id === (mode as { tokenId: string }).tokenId
					) +
						1) %
						all.length
				] as Combatant;
				mode = { kind: "move", tokenId: next.id, x: next.pos.x, y: next.pos.y };
			} else if (event.name === "return" || event.name === "enter") {
				const token = world.game.combatants.find(
					(c) => c.id === (mode as { tokenId: string }).tokenId
				);
				const { x, y } = mode;
				mode = { kind: "normal" };
				if (token !== undefined) {
					run(`/move ${token.tag} ${cellName(x, y)}`, "leader");
				}
			} else if (event.name === "escape") {
				mode = { kind: "normal" };
			}
			draw();
			return;
		}
		if (event.name === "escape" || (event.ctrl && event.name === "space")) {
			consume(event);
			mode = { kind: "leader" };
			hint = null;
			draw();
			return;
		}
		if (event.name === "tab") {
			consume(event);
			complete();
			drawHint();
			return;
		}
		if (event.name === "pageup" || event.name === "pagedown") {
			consume(event);
			feed.scrollBy(event.name === "pageup" ? -0.8 : 0.8, "viewport");
			return;
		}
		if (event.name === "up" || event.name === "down") {
			consume(event);
			if (history.length === 0) {
				return;
			}
			historyAt = Math.max(
				0,
				Math.min(history.length, historyAt + (event.name === "up" ? -1 : 1))
			);
			input.value = history[historyAt] ?? "";
			return;
		}
		if (hint !== null) {
			hint = null;
			drawHint();
		}
	};
	renderer.keyInput.on("keypress", onKey);

	input.on(InputRenderableEvents.ENTER, (value: unknown) => {
		const line = String(value ?? "").trim();
		input.value = "";
		if (line.length === 0) {
			return;
		}
		if (player.name !== null) {
			history.push(line);
			historyAt = history.length;
		}
		run(line);
	});

	mapText.onMouseDown = (event: MouseEvent) => {
		input.focus();
		if (player.name === null) {
			return;
		}
		const x = Math.floor((event.x - mapText.screenX - 2) / 2);
		const y = event.y - mapText.screenY - 1;
		if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) {
			return;
		}
		const token = world.game.combatants.find(
			(c) => c.pos.x === x && c.pos.y === y
		);
		if (token !== undefined) {
			selectedToken = player.gm ? token.id : null;
			hint = [
				chunk(
					` ${token.name} at ${cellName(x, y)} · ${token.stamina.current}/${token.stamina.max}`,
					COLORS.text
				),
				chunk(player.gm ? " · click a square to move it" : "", COLORS.hint),
			];
			draw();
			return;
		}
		const mover = player.gm
			? world.game.combatants.find((c) => c.id === selectedToken)
			: heroOf();
		if (mover === undefined) {
			hint = [
				chunk(
					player.gm
						? " Click a token first, then a square."
						: " /play <hero> to get a token.",
					COLORS.hint
				),
			];
			draw();
			return;
		}
		selectedToken = null;
		run(`/move ${mover.tag} ${cellName(x, y)}`, "click");
	};
	root.onMouseDown = () => input.focus();

	const offChange = world.onChange(draw);
	draw();

	return () => {
		offChange();
		renderer.keyInput.off("keypress", onKey);
		world.leave(key);
		if (!renderer.isDestroyed) {
			renderer.root.remove(root);
		}
	};
};
