import type { Accessor } from "solid-js";
import type { CombatView, FeedLine } from "../game/index.ts";

/** Someone with a seat open right now. */
export interface Present {
  readonly actor: string;
  readonly label: string;
  readonly gm: boolean;
}

// The band's view and the feed's lines are built by the rules (game/), which never import the table.
export type { Combatant, CombatView, FeedLine } from "../game/index.ts";

/** One token on the map. */
export interface MapToken {
  /** The combatant id it stands for (`vex`, `goblins-a`). */
  readonly id: string;
  /** One or two characters drawn in the cell, e.g. "V" or "g2"; commands take it as a name. */
  readonly mark: string;
  /** The hero's or creature's name, for `/view <who>`. */
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly side: "heroes" | "director";
  readonly mine: boolean;
  readonly acting: boolean;
  readonly dead: boolean;
}

/** The text map (ASSESSMENT Q7): terrain, tokens, and the squares the acting or chosen token can reach. */
export interface MapView {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** One string per row, one terrain character per square ("." floor, "#" wall, "~" difficult…). */
  readonly terrain: ReadonlyArray<string>;
  /** A mekmode map's letters, one per square, for the picture map; absent on a plain map. */
  readonly dressing?: ReadonlyArray<string>;
  readonly tokens: ReadonlyArray<MapToken>;
  /** Squares to highlight, e.g. where the acting creature can move this turn. */
  readonly reach: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** What the highlight means, for the hint row ("Vex can reach: speed 5"). */
  readonly reachLabel?: string;
}

/**
 * Everything the table needs from the host, for one seat. The App never sees the room,
 * the log or Effect: the host builds a TableView per seat and the App only reads and submits.
 */
export interface TableView {
  /** This seat's actor id (`gm`, `key:SHA256:…` or `guest:…`). */
  readonly me: string;
  /** The room's name, shown in the header. */
  readonly room: string;
  readonly feed: Accessor<ReadonlyArray<FeedLine>>;
  readonly present: Accessor<ReadonlyArray<Present>>;
  /** This seat's display name, or undefined until it has one (the table then asks for it). */
  readonly myName: Accessor<string | undefined>;
  /** Runs one input line. Resolves to a message for this seat only (a refusal or help), or undefined. */
  readonly submit: (line: string) => Promise<string | undefined>;
  /** Completions for the whole input line; each is a full replacement line. */
  readonly complete: (line: string) => ReadonlyArray<string>;
  /** The state pane's text (`/state`, the GM's seat only): the full state as JSON plus the last few envelopes. */
  readonly debug: () => string;
  /** Leaves the table: closes this seat. */
  readonly leave: () => void;
  /** How players join (`ssh -p 2222 den@host`), shown on the GM's seat while nobody else is here. */
  readonly joinHint?: string;
  /**
   * Said instead of `players join with: <joinHint>`, when set: how the way in is doing, e.g.
   * `relay: connecting…` while the table goes through a relay.
   */
  readonly joinNote?: Accessor<string>;
  /**
   * Trouble with the way in, in the header whatever else is on screen, e.g. `relay: down,
   * redialing` (for the GM). Undefined while all is well.
   */
  readonly alert?: Accessor<string | undefined>;
  /**
   * The band, Draw Steel's or set.world's as the campaign plays; undefined while there is no party
   * or fight. Every seat has it; a fake may not.
   */
  readonly combat?: Accessor<CombatView | undefined>;
  /** The text map; undefined while no map is loaded. Every seat has it; a fake may not. */
  readonly map?: Accessor<MapView | undefined>;
}
