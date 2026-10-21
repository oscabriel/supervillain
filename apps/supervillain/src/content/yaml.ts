/**
 * Writes the YAML a GM would: block mappings, short lists and number maps on one line, and quotes
 * only where a plain value would read back differently. Enough for the sheets we write; not a
 * general emitter.
 */
export function toYaml(
  value: Readonly<Record<string, unknown>>,
  header: ReadonlyArray<string> = [],
) {
  const lines = header.map((line) => (line === "" ? "#" : `# ${line}`));
  mapping(value, "", lines);
  return `${lines.join("\n")}\n`;
}

type Scalar = string | number | boolean;

const isScalar = (v: unknown): v is Scalar =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function mapping(value: Readonly<Record<string, unknown>>, indent: string, out: string[]) {
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (isScalar(v)) out.push(`${indent}${key}: ${scalar(v)}`);
    else if (Array.isArray(v)) {
      if (v.every(isScalar)) out.push(`${indent}${key}: [${v.map(flowScalar).join(", ")}]`);
      else {
        out.push(`${indent}${key}:`);
        for (const item of v) {
          const block: string[] = [];
          mapping(item as Record<string, unknown>, `${indent}    `, block);
          out.push(`${indent}  - ${block.join("\n").trimStart()}`);
        }
      }
    } else {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.every(([, x]) => typeof x === "number"))
        out.push(`${indent}${key}: { ${entries.map(([k, x]) => `${k}: ${x}`).join(", ")} }`);
      else {
        out.push(`${indent}${key}:`);
        mapping(v as Record<string, unknown>, `${indent}  `, out);
      }
    }
  }
}

/** Plain when it reads back as the same string, double-quoted (JSON is valid YAML) when not. */
function scalar(v: Scalar): string {
  if (typeof v !== "string") return String(v);
  if (v !== "" && !v.includes("\n") && v.trim() === v) {
    try {
      if ((Bun.YAML.parse(`k: ${v}`) as { k: unknown }).k === v) return v;
    } catch {
      // Not plain-safe; quote it.
    }
  }
  return JSON.stringify(v);
}

/** Inside `[…]` a comma or bracket would end the item, so those are quoted too. */
const flowScalar = (v: Scalar) =>
  typeof v === "string" && /[,[\]{}]/.test(v) ? JSON.stringify(v) : scalar(v);
