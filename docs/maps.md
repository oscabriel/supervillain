# Writing battle maps

A battle map is a plain-text terrain grid that you keep in your campaign folder. Tokens are not part of this file; they are added at the table and recorded in the campaign log.

Put each map at `maps/<address>.map` inside the campaign folder. For example, the address `cavern-mouth` refers to `maps/cavern-mouth.map`. An address must:

- start with an ASCII letter or digit;
- contain only ASCII letters, digits, `_`, and `-`; and
- be no more than 60 characters long.

In exact terms, an address must match `[A-Za-z0-9][A-Za-z0-9_-]{0,59}`. The address is the file name and is separate from the display name in the file.

## File layout

A map file has a header, a line containing `---`, and then the grid:

```text
name: Cavern Mouth
legend: . floor
legend: # wall
legend: + door
legend: ^ hazard
legend: ~ difficult
---
################
#......+.......#
#..~~~~..^^^^..#
#..............#
################
```

The header accepts only these keys:

- `name:` — required exactly once. This is the display name shown at the table. Leading and trailing whitespace is removed; what remains must be between 1 and 60 characters long.
- `legend:` — optional and repeatable. Each line defines one grid character as `legend: <character> <tile>`.

Blank lines are allowed in the header. The separator must be on its own line. Map files must be valid UTF-8 text.

Map files do not have comment syntax. Keep notes outside the `.map` file so that the validator does not mistake them for header lines or grid cells.

## Legends and tiles

If the header has no `legend:` lines, supervillain uses this default legend:

| Character | Tile              |
| --------- | ----------------- |
| `.`       | floor             |
| `#`       | wall              |
| `+`       | door              |
| `^`       | hazard            |
| `~`       | difficult terrain |

Declaring any `legend:` line replaces that default **wholesale**. Nothing from the default is added implicitly. If you declare only `legend: . floor`, then `.` is the only available grid character; using `#`, `+`, `^`, or `~` will make the file invalid until you declare them too.

The five tile names are exactly:

- `floor`
- `wall`
- `door`
- `hazard`
- `difficult`

A legend character must be one visible ASCII character from `!` through `~`. It cannot be a space, and each character can be declared only once. A legend may contain at most 64 entries.

The character is how terrain looks in text mode. The tile name gives it meaning. You can choose different characters—for example, `legend: X wall`—as long as every character used in the grid appears in the active legend.

## Grid rules

The lines after `---` are the map, with one character per cell.

- The grid must contain at least one cell.
- Every row must have exactly the same number of cells. Short rows are rejected; they are never padded.
- Spaces are not cells you can use. Do not indent the grid or add trailing spaces.
- Every grid character must be present in the active legend.
- A map may be at most 200 cells wide and 100 rows tall.

A final newline after the last row is fine. Extra blank lines after the grid are not: they become empty rows and break rectangularity.

## Copy the sample

A ready-to-copy file is available at [`examples/cavern.map`](examples/cavern.map). It declares all five entries explicitly, so it also demonstrates a complete replacement legend:

1. `name:` sets the display name.
2. The five `legend:` lines map the sample's visible characters to every available tile.
3. `---` ends the header.
4. The remaining lines form a 16-by-5 rectangular grid. Each character is declared, and there are no spaces.

Copy it into your campaign folder as, for example, `maps/cavern.map`, then change the display name, legend, and grid. Check your work with:

```sh
supervillain map check <campaign-folder> cavern
```

Omit `cavern` to check every `.map` file in the folder. Use `supervillain map list <campaign-folder>` to list valid and invalid maps. At a live table, the GM loads the file by its address with `/map load cavern`.
