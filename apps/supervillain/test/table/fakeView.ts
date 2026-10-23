import { createSignal } from "solid-js";
import type {
  CombatView,
  FeedLine,
  MapView,
  PrepView,
  Present,
  TableView,
  TokenAction,
} from "../../src/table/view.ts";

export interface FakeViewOptions {
  readonly me?: string;
  readonly room?: string;
  readonly feed?: ReadonlyArray<FeedLine>;
  readonly present?: ReadonlyArray<Present>;
  readonly myName?: string;
  /** What submit resolves to for a line; undefined by default. */
  readonly reply?: (line: string) => string | undefined | Promise<string | undefined>;
  readonly complete?: (line: string) => ReadonlyArray<string>;
  readonly debug?: string;
  readonly joinHint?: string;
  /** How the way in is doing, in the header; when given, the view has an `alert` accessor. */
  readonly alert?: string | null;
  /** The Draw Steel band; when given, the view has a `combat` accessor (which may return undefined). */
  readonly combat?: CombatView | null;
  /** The text map; when given, the view has a `map` accessor (null: no map loaded yet). */
  readonly map?: MapView | null;
  /** What the seat may do with a token, for the mouse; when given, the view has `actions`. */
  readonly actions?: (id: string) => ReadonlyArray<TokenAction> | undefined;
  /**
   * The GM's prep panel; when given, the view has `prep` (null: nothing read yet). Its reload
   * resolves to `prepProblem`.
   */
  readonly prep?: PrepView | null;
  readonly prepProblem?: string;
}

/** A TableView backed by plain signals, recording what the App asks of it. */
export function fakeView(options: FakeViewOptions = {}) {
  const [feed, setFeed] = createSignal<ReadonlyArray<FeedLine>>(options.feed ?? []);
  const [present, setPresent] = createSignal<ReadonlyArray<Present>>(options.present ?? []);
  const [myName, setMyName] = createSignal<string | undefined>(options.myName);
  const [combat, setCombat] = createSignal<CombatView | undefined>(options.combat ?? undefined);
  const [map, setMap] = createSignal<MapView | undefined>(options.map ?? undefined);
  const [alert, setAlert] = createSignal<string | undefined>(options.alert ?? undefined);
  const [prep, setPrep] = createSignal<PrepView | undefined>(options.prep ?? undefined);
  let reloads = 0;
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
    ...(options.combat === undefined ? {} : { combat }),
    ...(options.map === undefined ? {} : { map }),
    ...(options.alert === undefined ? {} : { alert }),
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    ...(options.prep === undefined
      ? {}
      : {
          prep: {
            view: prep,
            reload: () => {
              reloads++;
              return Promise.resolve(options.prepProblem);
            },
          },
        }),
  };
  return {
    view,
    submitted,
    completed,
    left: () => left,
    setFeed,
    setPresent,
    setMyName,
    setCombat,
    setMap,
    setAlert,
    setPrep,
    reloads: () => reloads,
  };
}

export const line = (seq: number, who: string, text: string, kind = "chat"): FeedLine => ({
  seq,
  who,
  kind,
  text,
  gm: false,
});

export const gm: Present = { actor: "gm", label: "Oscar", gm: true };
export const alice: Present = { actor: "key:SHA256:alice", label: "Alice", gm: false };
export const bob: Present = { actor: "key:SHA256:bob", label: "Bob", gm: false };
