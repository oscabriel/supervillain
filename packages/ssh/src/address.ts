import { isIPv6 } from "node:net";

/** A peer's address as logs show it: an IPv4-mapped IPv6 address as plain IPv4. */
export const normalizeAddress = (address: string | undefined): string =>
  !address ? "unknown" : address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

/** The eight groups of an IPv6 address, as numbers, or undefined if it isn't one. */
const ipv6Groups = (address: string): number[] | undefined => {
  const bare = address.split("%")[0]!;
  if (!isIPv6(bare) || bare.includes(".")) return undefined;
  const [head, tail] = bare.includes("::") ? bare.split("::") : [bare, undefined];
  const parse = (part: string | undefined) =>
    part === undefined || part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const front = parse(head);
  const back = parse(tail);
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 ? groups : undefined;
};

/**
 * What per-address limits and rates count by. An IPv6 client usually holds a whole /64, so a cap
 * per exact address wouldn't hold one person back: IPv6 counts by its /64, or by its /48 (what one
 * site is usually given) for limits that must hold a whole site back. IPv4 counts as itself.
 */
export const addressBucket = (address: string, prefix: 48 | 64 = 64): string => {
  const normal = normalizeAddress(address);
  const groups = ipv6Groups(normal);
  if (groups === undefined) return normal;
  const kept = groups.slice(0, prefix / 16).map((g) => g.toString(16));
  return `${kept.join(":")}::/${prefix}`;
};
