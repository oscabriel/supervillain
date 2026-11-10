/**
 * What a seat at a set.world table sees: the band, the map and /sheet, in the shapes Draw Steel's
 * use (drawSteel/view.ts and mapView.ts), so the table draws either the same way.
 */
import type { TokenAction } from "../actions.ts";
import type { MapToken, MapView } from "../drawSteel/mapView.ts";
import { reachable } from "../drawSteel/movement.ts";
import type { Combatant, CombatView } from "../drawSteel/view.ts";
import type { Refused } from "../module.ts";
import { partyFirst, type PrepCatalog, prepMaps, prepSteps, type PrepView } from "../prep.ts";
import {
  controls,
  type Fighter,
  fighterOf,
  findFighter,
  isDown,
  mapSide,
  marksOf,
  maxHealth,
  maxStamina,
  nextOf,
  occupants,
  resolveFighter,
  type SetState,
  shownStamina,
  speedOf,
} from "./state.ts";
import { reachOf } from "./weapons.ts";

const percent = (n: number) => `${Math.round(n * 100)}%`;

/** "1.85 s" on the fight's logical clock. */
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/**
 * The band for one seat: every fighter in a fight, soonest turn first, or the party outside one.
 * Undefined while nobody has been rolled. A fighter played by someone else carries their name
 * ("Ada (Alice)"); the seat's own is `mine`.
 */
export function setBand(
  slice: SetState,
  actor: string,
  labelOf?: (actor: string) => string,
): CombatView | undefined {
  const { fight } = slice;
  if (fight === undefined && !slice.fighters.some((f) => f.side === "party")) return undefined;
  const marks = slice.map === undefined ? undefined : marksOf(slice.fighters);
  const shown =
    fight === undefined
      ? slice.fighters.filter((f) => f.side === "party")
      : slice.fighters.toSorted(
          (a, b) =>
            Number(isDown(a)) - Number(isDown(b)) ||
            (nextOf(fight, a.id) ?? Infinity) - (nextOf(fight, b.id) ?? Infinity),
        );
  const combatant = (f: Fighter): Combatant => {
    const max = maxHealth(f.character);
    const player = f.player !== undefined && f.player !== actor ? labelOf?.(f.player) : undefined;
    const mark = f.at === undefined ? undefined : marks?.get(f.id);
    return {
      id: f.id,
      name: player === undefined ? f.name : `${f.name} (${player})`,
      side: mapSide(f),
      stamina: Math.max(0, f.health),
      max,
      temp: 0,
      ...(isDown(f)
        ? { health: "dead" as const }
        : f.health <= max / 2
          ? { health: "winded" as const }
          : {}),
      conditions: [],
      resource: `stamina ${shownStamina(f)}/${maxStamina(f.character)} · ${f.character.className}, ${f.character.mainhand}`,
      acted: false,
      acting: fight?.turn?.id === f.id,
      mine: f.player === actor,
      ...(f.side === "party" && f.player === undefined && !isDown(f) && { free: true }),
      ...(mark !== undefined && { mark }),
    };
  };
  // Whose turn it is, by the fighter's own name, so no seat misreads it.
  const turn = fight?.turn === undefined ? undefined : findFighter(slice, fight.turn.id);
  return {
    round: fight?.turns ?? 0,
    active: fight !== undefined,
    malice: 0,
    heroTokens: 0,
    title:
      fight === undefined
        ? " party "
        : ` set.world · ${seconds(fight.clock)} · turn ${fight.turns}${turn === undefined ? "" : `: ${turn.name}`} `,
    combatants: shown.map(combatant),
  };
}

/** Whose reach the seat sees: the fighter whose turn it is, else the seat's own, if on the map and standing. */
function reachFor(slice: SetState, actor: string): Fighter | undefined {
  const standing = (f: Fighter | undefined) =>
    f !== undefined && f.at !== undefined && !isDown(f) ? f : undefined;
  const acting =
    slice.fight?.turn === undefined ? undefined : findFighter(slice, slice.fight.turn.id);
  return standing(acting) ?? standing(fighterOf(slice, actor));
}

/**
 * The text map for one seat, undefined while none is loaded: the terrain, every placed fighter,
 * and where the fighter whose turn it is can still move, or the seat's own outside its turn.
 */
export function setMap(slice: SetState, actor: string): MapView | undefined {
  const map = slice.map;
  if (map === undefined) return undefined;
  const marks = marksOf(slice.fighters);
  const tokens = slice.fighters.flatMap((f): MapToken[] =>
    f.at === undefined
      ? []
      : [
          {
            id: f.id,
            mark: marks.get(f.id) ?? "??",
            name: f.name,
            x: f.at.x,
            y: f.at.y,
            side: mapSide(f),
            mine: f.player === actor,
            acting: slice.fight?.turn?.id === f.id,
            dead: isDown(f),
          },
        ],
  );
  const subject = reachFor(slice, actor);
  const speed = subject === undefined ? 0 : speedOf(subject.character);
  const turn = slice.fight?.turn;
  const left =
    turn !== undefined && turn.id === subject?.id ? Math.max(0, speed - turn.moved) : speed;
  const reach =
    subject?.at === undefined
      ? []
      : reachable(
          map.terrain,
          subject.at,
          left,
          { side: mapSide(subject), prone: false },
          occupants(slice, subject.id),
        );
  return {
    name: map.name,
    width: map.terrain[0]?.length ?? 0,
    height: map.terrain.length,
    terrain: map.terrain,
    ...(map.dressing === undefined ? {} : { dressing: map.dressing }),
    tokens: [...tokens.filter((t) => t.dead), ...tokens.filter((t) => !t.dead)],
    reach,
    ...(subject !== undefined && {
      reachLabel: `${subject.name} can reach: ${left === speed ? `speed ${speed}` : `${left} of speed ${speed} left`}`,
    }),
  };
}

/** The /sheet text for a fighter, named as commands name them, or why it can't be found. */
export function setSheet(slice: SetState, typed: string): string | Refused {
  const f = resolveFighter(slice, typed);
  if ("refusal" in f) return f;
  const c = f.character;
  const a = c.attributes;
  const reach = reachOf(c.mainhand);
  return [
    `${f.name}: ${c.className}, ${f.side === "party" ? "of the party" : "a foe"} (set.world seed ${c.seed}, power ${c.powerRating})`,
    c.flavor,
    `Health ${f.health}/${maxHealth(c)}${isDown(f) ? " · down" : ""} · stamina ${shownStamina(f)}/${maxStamina(c)} · speed ${speedOf(c)} · initiative ${a.initiative.toFixed(2)}, a turn every ${Math.round(1000 / a.initiative)} ms`,
    `Weapon: ${c.mainhand} (${reach.delivery}, reaches ${reach.squares}) · ${reach.magic ? `magic ${a.magicalDamage}` : `physical ${a.physicalDamage}`} damage`,
    `Dodge ${percent(a.dodgeRate)} · critical ${percent(a.criticalHitChance)} · clarity ${percent(a.clarity)} · armour ${percent(a.physicalDamageReduction)} physical, ${percent(a.magicalDamageReduction)} magic · resists ${percent(a.globalResistance)}`,
    `Stats: ${Object.entries(c.finalStats)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `Gear: ${c.gear.map((g) => g.name).join("; ")}`,
  ].join("\n");
}

/**
 * Labels a player by their name and the fighter they play ("Alice (Ada)"), for the feed and the
 * presence list. Wrap the core labeller with it when projecting.
 */
export const withFighters =
  (slice: SetState, labelOf: (actor: string) => string) =>
  (actor: string): string => {
    const own = fighterOf(slice, actor);
    return own === undefined ? labelOf(actor) : `${labelOf(actor)} (${own.name})`;
  };

/**
 * What `actor` may do with the fighter `id`, for the table's mouse, or undefined when they may not
 * act for it (a player for anyone but the fighter they play): Move while it stands on the map,
 * Place while a map is loaded that it isn't on yet, Attack, and Done while it is its turn, since
 * `/done` ends whoever's turn it is. The rules refuse what can't be done now, as they do a typed
 * line.
 */
export function setActions(
  slice: SetState,
  actor: string,
  id: string,
): ReadonlyArray<TokenAction> | undefined {
  const f = findFighter(slice, id);
  if (f === undefined || !controls(actor, f)) return undefined;
  return [
    ...(slice.map === undefined
      ? []
      : f.at === undefined
        ? [{ label: "Place", pick: "square" as const, line: `/place ${f.id}` }]
        : [{ label: "Move", pick: "square" as const, line: `/move ${f.id}` }]),
    { label: "Attack", pick: "target", line: `/attack ${f.id}` },
    ...(slice.fight?.turn?.id === f.id
      ? [{ label: "Done", pick: "none" as const, line: "/done" }]
      : []),
  ];
}

/** The prep panel at a set.world table: the maps, who waits for a square, fighters, the fight. */
export function setWorldPrep(slice: SetState, catalog: PrepCatalog): PrepView {
  const standing = slice.fighters.filter((f) => !isDown(f));
  const party = slice.fighters.filter((f) => f.side === "party").length;
  const foes = slice.fighters.length - party;
  return {
    steps: prepSteps(
      slice.map !== undefined,
      standing.map((f) => ({ side: mapSide(f), placed: f.at !== undefined })),
    ),
    maps: prepMaps(catalog, slice.map),
    place:
      slice.map === undefined
        ? []
        : partyFirst(
            standing
              .filter((f) => f.at === undefined)
              .map((f) => ({ id: f.id, name: f.name, figure: { id: f.id, side: mapSide(f) } })),
          ),
    sections: [
      {
        title: "fighters",
        items: [
          { kind: "fill", label: "Recruit", line: "/recruit " },
          { kind: "fill", label: "Foe", line: "/foe " },
        ],
        note: `${party} in the party, ${foes} ${foes === 1 ? "foe" : "foes"}`,
      },
    ],
    start: slice.fight === undefined ? { line: "/start" } : { note: "the fight is on" },
  };
}
