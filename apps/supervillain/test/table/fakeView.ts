import { createSignal } from "solid-js";
import type { FeedLine, Present, TableView } from "../../src/table/view.ts";

export interface FakeViewOptions {
  readonly me?: string;
  readonly room?: string;
  readonly feed?: ReadonlyArray<FeedLine>;
  readonly present?: ReadonlyArray<Present>;
  readonly myName?: string;
  /** What submit resolves to for a line; undefined by default. */
  readonly reply?: (line: string) => string | undefined;
  readonly complete?: (line: string) => ReadonlyArray<string>;
  readonly debug?: string;
  readonly joinHint?: string;
}

/** A TableView backed by plain signals, recording what the App asks of it. */
export function fakeView(options: FakeViewOptions = {}) {
  const [feed, setFeed] = createSignal<ReadonlyArray<FeedLine>>(options.feed ?? []);
  const [present, setPresent] = createSignal<ReadonlyArray<Present>>(options.present ?? []);
  const [myName, setMyName] = createSignal<string | undefined>(options.myName);
  const submitted: string[] = [];
  const completed: string[] = [];
  let left = 0;
  const view: TableView = {
    me: options.me ?? "key:SHA256:alice",
    room: options.room ?? "den",
    feed,
    present,
    myName,
    submit: (line) => {
      submitted.push(line);
      return Promise.resolve(options.reply?.(line));
    },
    complete: (line) => {
      completed.push(line);
      return options.complete?.(line) ?? [];
    },
    debug: () => options.debug ?? "{}",
    leave: () => {
      left++;
    },
    ...(options.joinHint === undefined ? {} : { joinHint: options.joinHint }),
  };
  return {
    view,
    submitted,
    completed,
    left: () => left,
    setFeed,
    setPresent,
    setMyName,
  };
}

export const line = (seq: number, who: string, text: string, kind = "chat"): FeedLine => ({
  seq,
  who,
  kind,
  text,
});

export const gm: Present = { actor: "gm", label: "Oscar", gm: true };
export const alice: Present = { actor: "key:SHA256:alice", label: "Alice", gm: false };
export const bob: Present = { actor: "key:SHA256:bob", label: "Bob", gm: false };
