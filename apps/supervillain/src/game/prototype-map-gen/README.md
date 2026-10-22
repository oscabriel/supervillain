# PROTOTYPE: generated battlemaps in MEKMODE letters (throwaway)

**The question:** can we generate battlemaps that are sound for Draw Steel and look like MEK's scenes, from a seed?

This lives on the `prototype/set-world` branch, beside the map-art and Set prototypes. Nothing here is meant to merge.

## Run it

```sh
bun apps/supervillain/src/game/prototype-map-gen/demo.ts crossing 1
bun apps/supervillain/src/game/prototype-map-gen/demo.ts keep 1
```

Each run does three things:
- generates a map, prints it, and writes it to `/tmp/sv-map-gen/maps/<kind>-<seed>.txt` (a scratch folder, wiped on each run);
- sets up the sample fight on it, heroes west and bandits east;
- hosts it with the painted look, on port 2401.

Any seed gives a map, and the same seed always gives the same one. F2 to the text look shows what the rules see.

## How it works

**A map file can be written in MEKMODE letters.** Add a `style: mekmode` line under the `name:` line, then write the rows in Ding Mode letters.
- **The legend** (`legend.ts`) gives each letter what it depicts, what the rules see (`.` floor, `#` wall, `~` difficult) and a colour tone.
- **The host** reads the file into two layers: the rules' grid, which is all Draw Steel ever reads, and the letters.
- **Display:** the painted look draws each square's letter, and the text look is unchanged.

**MEK's three groups are his:** landscape and nature (`q` to `p`), human-made structures (`a` to `l`), geometric shapes (`z` to `m`). What each glyph depicts within a group is our reading of his key chart. He has no per-glyph key.

**The generator** (`generate.ts`) lays out what the rules care about first, then dresses it:

- **crossing.**
  - **The river** wanders north to south, two or three squares wide, deep in the middle and reedy at the banks.
  - **The road** crosses west to east and fords the river in the shallows.
  - **The rest:** a ruined building on one bank (brick, corner pillars, two archways, stretches fallen to rubble), two or three woods, and outcrops of boulders.
- **keep.**
  - **The curtain wall** is a ring with three-square towers at the corners, a gate west and a rubble breach east.
  - **The yard** holds a roofed hall with two doors, a well and a statue, with rubble about it.
  - **Outside:** woods beyond the walls.
- **Every kind:**
  - **Ground** is noise over MEK's density ramp: bare earth, grass, scrub, hillocks.
  - **Woods** are dense in the middle and thin at the edge.
  - **Soundness:** every map can be crossed from west to east without passing a wall (otherwise the seed's next draw is used), and the outer three columns on each side are where each side deploys.

## What it showed so far (2026-10-22, from renders, not yet play)

- **Both kinds read as places.** You can see the river, ford, woods and ruin, and the keep's walls, gates, towers, hall, well and breach.
- **Floors must look different from walls.** Flagstones (`A`) and brick (`s`) are both horizontal courses, and in one colour a courtyard read as solid wall. Yards and rooms now use MEK's floor textures (`c`, `C`, `v`), and roads take a darker tone.
- **Not yet checked at a table:** whether the maps make good fights (cover, chokepoints, a reason to cross the ford), and how they read at 80x24 in the text look, where only `. # ~` shows.
