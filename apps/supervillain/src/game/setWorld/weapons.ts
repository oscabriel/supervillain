/**
 * How every mainhand delivers its blow and how far it reaches, from set.world's table of every held
 * item ("Derived combat", rule stamp set-world-0-15-0, https://set.world/skills/anima-derived-combat).
 * Reach is in inches, a steel Sword at 36. The grid's ranges below are this table's own reading,
 * since Set's turn-based mode has no positions.
 */

export type Delivery = "melee" | "projectile" | "wave" | "aura";

/** Every mainhand set.world rolls, by name as `class.mainhand` gives it. */
export const WEAPONS: Readonly<
  Record<string, { readonly delivery: Delivery; readonly reach: number }>
> = {
  anchor: { delivery: "projectile", reach: 34.6 },
  arbalest: { delivery: "projectile", reach: 16.9 },
  assegai: { delivery: "melee", reach: 28.5 },
  axe: { delivery: "melee", reach: 10.7 },
  balisong: { delivery: "melee", reach: 13.3 },
  ballista: { delivery: "projectile", reach: 28.2 },
  bands: { delivery: "melee", reach: 4.6 },
  bardiche: { delivery: "melee", reach: 39.9 },
  baton: { delivery: "melee", reach: 11.9 },
  bill: { delivery: "melee", reach: 33.5 },
  blade: { delivery: "melee", reach: 28.6 },
  bokken: { delivery: "melee", reach: 36.2 },
  boomerang: { delivery: "projectile", reach: 21.2 },
  bow: { delivery: "projectile", reach: 11.1 },
  broadsword: { delivery: "melee", reach: 37.3 },
  buckler: { delivery: "melee", reach: 6.7 },
  cane: { delivery: "projectile", reach: 23.2 },
  cestus: { delivery: "melee", reach: 4.6 },
  chain: { delivery: "melee", reach: 66.5 },
  chair: { delivery: "projectile", reach: 22.7 },
  chakram: { delivery: "projectile", reach: 8.9 },
  cinquedea: { delivery: "melee", reach: 24.9 },
  claw: { delivery: "melee", reach: 5.8 },
  claymore: { delivery: "melee", reach: 52.8 },
  cleaver: { delivery: "melee", reach: 21.8 },
  club: { delivery: "melee", reach: 17.6 },
  "composite bow": { delivery: "projectile", reach: 11.3 },
  corseque: { delivery: "melee", reach: 35.9 },
  crossbow: { delivery: "projectile", reach: 9.3 },
  crowbar: { delivery: "melee", reach: 29.0 },
  cudgel: { delivery: "melee", reach: 17.6 },
  dagger: { delivery: "melee", reach: 20.5 },
  dao: { delivery: "melee", reach: 34.6 },
  dirk: { delivery: "melee", reach: 22.0 },
  door: { delivery: "melee", reach: 39.1 },
  drill: { delivery: "melee", reach: 17.0 },
  estoc: { delivery: "melee", reach: 49.4 },
  eye: { delivery: "wave", reach: 6.5 },
  falcata: { delivery: "melee", reach: 29.5 },
  falchion: { delivery: "melee", reach: 42.6 },
  fang: { delivery: "melee", reach: 5.8 },
  fauchard: { delivery: "melee", reach: 39.3 },
  flail: { delivery: "melee", reach: 20.2 },
  flamberge: { delivery: "melee", reach: 47.3 },
  flute: { delivery: "aura", reach: 12.7 },
  francisca: { delivery: "projectile", reach: 12.7 },
  gladius: { delivery: "melee", reach: 29.2 },
  glaive: { delivery: "melee", reach: 46.0 },
  goad: { delivery: "melee", reach: 19.5 },
  goedendag: { delivery: "melee", reach: 28.0 },
  grimoire: { delivery: "aura", reach: 11.0 },
  guisarme: { delivery: "melee", reach: 36.8 },
  halberd: { delivery: "melee", reach: 39.0 },
  hammer: { delivery: "melee", reach: 10.5 },
  "hand cannon": { delivery: "projectile", reach: 27.6 },
  harp: { delivery: "aura", reach: 19.0 },
  harpoon: { delivery: "projectile", reach: 23.5 },
  hatchet: { delivery: "melee", reach: 8.8 },
  heater: { delivery: "melee", reach: 10.9 },
  "ice pick": { delivery: "melee", reach: 14.3 },
  iklwa: { delivery: "melee", reach: 25.5 },
  javelin: { delivery: "projectile", reach: 21.3 },
  jian: { delivery: "melee", reach: 42.1 },
  jo: { delivery: "melee", reach: 22.3 },
  jutte: { delivery: "melee", reach: 19.0 },
  karambit: { delivery: "melee", reach: 18.0 },
  katana: { delivery: "melee", reach: 46.3 },
  katar: { delivery: "melee", reach: 13.9 },
  khopesh: { delivery: "melee", reach: 35.6 },
  "kite shield": { delivery: "melee", reach: 14.5 },
  knife: { delivery: "melee", reach: 14.8 },
  knuckle: { delivery: "melee", reach: 3.8 },
  kopis: { delivery: "melee", reach: 35.8 },
  kris: { delivery: "melee", reach: 24.8 },
  kukri: { delivery: "melee", reach: 21.5 },
  kunai: { delivery: "projectile", reach: 16.6 },
  lance: { delivery: "melee", reach: 43.1 },
  longbow: { delivery: "projectile", reach: 21.9 },
  longsword: { delivery: "melee", reach: 42.3 },
  macana: { delivery: "melee", reach: 16.8 },
  mace: { delivery: "melee", reach: 11.5 },
  mambele: { delivery: "projectile", reach: 34.4 },
  maul: { delivery: "melee", reach: 23.1 },
  messer: { delivery: "melee", reach: 35.1 },
  morningstar: { delivery: "melee", reach: 13.6 },
  nagamaki: { delivery: "melee", reach: 41.8 },
  naginata: { delivery: "melee", reach: 44.0 },
  nodachi: { delivery: "melee", reach: 54.4 },
  nunchaku: { delivery: "melee", reach: 12.9 },
  orb: { delivery: "aura", reach: 6.0 },
  partizan: { delivery: "melee", reach: 35.9 },
  pata: { delivery: "melee", reach: 35.5 },
  patu: { delivery: "melee", reach: 17.8 },
  pavise: { delivery: "melee", reach: 15.5 },
  pickaxe: { delivery: "melee", reach: 11.8 },
  pike: { delivery: "melee", reach: 47.7 },
  pilum: { delivery: "projectile", reach: 23.4 },
  pitchfork: { delivery: "melee", reach: 33.1 },
  poignard: { delivery: "melee", reach: 19.1 },
  pugio: { delivery: "melee", reach: 20.5 },
  quarterstaff: { delivery: "melee", reach: 22.3 },
  rake: { delivery: "melee", reach: 29.8 },
  ranseur: { delivery: "melee", reach: 41.7 },
  rapier: { delivery: "melee", reach: 47.0 },
  "recurve bow": { delivery: "projectile", reach: 18.1 },
  rifle: { delivery: "projectile", reach: 18.6 },
  rod: { delivery: "wave", reach: 15.4 },
  rondache: { delivery: "melee", reach: 9.7 },
  rondel: { delivery: "melee", reach: 21.3 },
  "rope dart": { delivery: "melee", reach: 89.7 },
  saber: { delivery: "melee", reach: 38.3 },
  sai: { delivery: "melee", reach: 19.2 },
  sarissa: { delivery: "melee", reach: 87.9 },
  scepter: { delivery: "wave", reach: 13.0 },
  scimitar: { delivery: "melee", reach: 38.4 },
  scroll: { delivery: "aura", reach: 20.7 },
  scythe: { delivery: "melee", reach: 41.1 },
  seax: { delivery: "melee", reach: 21.1 },
  shashka: { delivery: "melee", reach: 36.5 },
  shield: { delivery: "melee", reach: 11.7 },
  shortbow: { delivery: "projectile", reach: 9.1 },
  shortsword: { delivery: "melee", reach: 27.2 },
  shotel: { delivery: "melee", reach: 29.6 },
  sickle: { delivery: "melee", reach: 18.0 },
  sling: { delivery: "projectile", reach: 34.6 },
  "small shield": { delivery: "melee", reach: 5.6 },
  spear: { delivery: "melee", reach: 38.2 },
  spetum: { delivery: "melee", reach: 39.5 },
  spike: { delivery: "melee", reach: 23.7 },
  staff: { delivery: "wave", reach: 22.1 },
  stick: { delivery: "melee", reach: 22.6 },
  stiletto: { delivery: "melee", reach: 20.5 },
  sword: { delivery: "melee", reach: 36.0 },
  tabar: { delivery: "melee", reach: 22.3 },
  tachi: { delivery: "melee", reach: 41.9 },
  talon: { delivery: "melee", reach: 11.7 },
  talwar: { delivery: "melee", reach: 36.0 },
  tanto: { delivery: "melee", reach: 17.0 },
  targe: { delivery: "melee", reach: 8.8 },
  tetsubo: { delivery: "melee", reach: 31.0 },
  tomahawk: { delivery: "projectile", reach: 9.0 },
  tome: { delivery: "aura", reach: 9.6 },
  tonfa: { delivery: "melee", reach: 11.3 },
  torch: { delivery: "aura", reach: 7.3 },
  "tree trunk": { delivery: "melee", reach: 42.1 },
  trident: { delivery: "melee", reach: 40.6 },
  truncheon: { delivery: "melee", reach: 15.2 },
  urumi: { delivery: "melee", reach: 52.7 },
  voulge: { delivery: "melee", reach: 42.7 },
  wand: { delivery: "wave", reach: 10.7 },
  "war horn": { delivery: "aura", reach: 10.9 },
  whip: { delivery: "melee", reach: 90.6 },
  wrench: { delivery: "melee", reach: 10.9 },
  xiphos: { delivery: "melee", reach: 29.2 },
  yari: { delivery: "melee", reach: 39.0 },
};

/** How a weapon reaches on the grid, and whether its hit is magic. */
export interface Reach {
  readonly delivery: Delivery;
  readonly squares: number;
  readonly magic: boolean;
}

/** Melee weapons longer than this many inches reach a second square. */
const LONG_REACH = 40;

/**
 * A mainhand's reach on the grid: melee 1 square (2 past 40 inches), projectiles 10, waves 5 and
 * auras 3, the last two as magic. A mainhand the table doesn't know reaches like a sword.
 */
export function reachOf(mainhand: string): Reach {
  const weapon = WEAPONS[mainhand.toLowerCase()] ?? { delivery: "melee", reach: 36 };
  switch (weapon.delivery) {
    case "projectile":
      return { delivery: "projectile", squares: 10, magic: false };
    case "wave":
      return { delivery: "wave", squares: 5, magic: true };
    case "aura":
      return { delivery: "aura", squares: 3, magic: true };
    case "melee":
      return { delivery: "melee", squares: weapon.reach > LONG_REACH ? 2 : 1, magic: false };
  }
}
