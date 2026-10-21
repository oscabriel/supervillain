import type { Accessor } from "solid-js";

/** One rendered feed line. The table styles by `kind`, never by parsing `text`. */
export interface FeedLine {
  readonly seq: number;
  /** The actor's current label (display name, else a short key label), resolved when the feed is projected. */
  readonly who: string;
  readonly kind: string;
  readonly text: string;
  /** Whether the GM wrote it: the GM's label is drawn in the GM's colour, so a name can't pass for the GM. */
  readonly gm?: boolean;
}

/** Someone with a seat open right now. */
export interface Present {
  readonly actor: string;
  readonly label: string;
  readonly gm: boolean;
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
}
