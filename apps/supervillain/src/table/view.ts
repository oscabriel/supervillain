import type { Accessor } from "solid-js";

/** One rendered feed line. The table styles by `kind`, never by parsing `text`. */
export interface FeedLine {
  readonly seq: number;
  /** The actor's label at the time of the event: display name, else a short key label. */
  readonly who: string;
  readonly kind: string;
  readonly text: string;
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
  /** The debug pane's text (`/state`): the full state as JSON plus the last few envelopes. */
  readonly debug: () => string;
  /** Leaves the table: closes this seat. */
  readonly leave: () => void;
}
