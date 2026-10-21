/**
 * Keeps last time's line and segment objects wherever they read the same. The band and the map
 * render lines with `<For>`, which keys rows by identity: a fresh array of equal lines would tear
 * down and rebuild every text renderable, so one changed token or meter redraws one line.
 */
export function keepLines<S extends object>(): (
  lines: ReadonlyArray<ReadonlyArray<S>>,
) => ReadonlyArray<ReadonlyArray<S>> {
  let previous: ReadonlyArray<ReadonlyArray<S>> = [];
  let byText = new Map<string, ReadonlyArray<S>>();
  return (lines) => {
    const next = new Map<string, ReadonlyArray<S>>();
    let same = lines.length === previous.length;
    const kept = lines.map((line, i) => {
      const key = JSON.stringify(line);
      const old = byText.get(key) ?? next.get(key);
      const row =
        old ??
        line.map((segment, j) => {
          const was = previous[i]?.[j];
          return was !== undefined && JSON.stringify(was) === JSON.stringify(segment)
            ? was
            : segment;
        });
      next.set(key, row);
      if (row !== previous[i]) same = false;
      return row;
    });
    byText = next;
    if (same) return previous;
    previous = kept;
    return kept;
  };
}
