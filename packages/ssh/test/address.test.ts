import { describe, expect, test } from "bun:test";
import { addressBucket, normalizeAddress } from "../src/index.ts";

describe("addresses, as limits count them", () => {
  test("an IPv4 address, mapped or not, is itself", () => {
    expect(normalizeAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(addressBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeAddress(undefined)).toBe("unknown");
  });

  test("an IPv6 address counts as its /64, which one person usually holds whole", () => {
    const bucket = addressBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(bucket).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:0db8:0001:0002::1")).toBe(bucket);
    expect(addressBucket("2001:DB8:1:2::ffff")).toBe(bucket);
    expect(addressBucket("2001:db8:1:3::1")).not.toBe(bucket);
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
    expect(addressBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  test("anything else is left as it is", () => {
    expect(addressBucket("unknown")).toBe("unknown");
    expect(addressBucket("not:an:address::x")).toBe("not:an:address::x");
  });
});
