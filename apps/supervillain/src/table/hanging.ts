/**
 * Splits a reply into lines that wrap under where their text starts: past the leading spaces, and
 * past a label set off by two or more spaces (`/turn [who]      Start a turn…`), so a long /help
 * summary or sheet line hangs under itself rather than running back to the left edge.
 */
export function hanging(
  text: string,
): ReadonlyArray<{ readonly lead: string; readonly rest: string }> {
  return text.split("\n").map((line) => {
    const match = /^( *(?:\S(?:.*?\S)? {2,})?)(.*)$/.exec(line);
    const lead = match?.[1] ?? "";
    // A line that is all label keeps it whole, so nothing hangs off an empty rest.
    return match?.[2] === ""
      ? { lead: "", rest: line === "" ? " " : line }
      : { lead, rest: match?.[2] ?? line };
  });
}
