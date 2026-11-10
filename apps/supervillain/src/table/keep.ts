/**
 * `next`, with every object and array in it that reads the same as last time's swapped for last
 * time's: `previous` itself when all of it does. In a list an item is matched wherever it moved,
 * else by place. The host keeps a seat's views so: an event that leaves the map as it was paints
 * no picture again, and one that changes a prep item rebuilds that item alone. The band and the
 * map keep their lines so too, since `<For>` keys rows by identity and would rebuild every row of
 * a fresh array.
 */
export function kept<A>(previous: A | undefined, next: A): A {
  if (previous === next) return next;
  if (
    typeof previous !== "object" ||
    typeof next !== "object" ||
    previous === null ||
    next === null ||
    Array.isArray(previous) !== Array.isArray(next)
  )
    return next;
  const was = previous as Record<string, unknown>;
  const now = next as Record<string, unknown>;
  const keys = Object.keys(now);
  const moved = Array.isArray(was) ? new Map(was.map((v) => [JSON.stringify(v), v])) : undefined;
  const out = (Array.isArray(now) ? [] : {}) as Record<string, unknown>;
  let same = keys.length === Object.keys(was).length;
  for (const key of keys) {
    out[key] = moved?.get(JSON.stringify(now[key])) ?? kept(was[key], now[key]);
    if (out[key] !== was[key] || !Object.hasOwn(was, key)) same = false;
  }
  return same ? previous : (out as A);
}
