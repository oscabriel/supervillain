import { describe, expect, test } from "bun:test";
import { parseBuildArgs, TARGETS } from "./targets.ts";

const linuxHost = { platform: "linux", arch: "x64" } as const;

describe("parseBuildArgs", () => {
  test("builds for the machine it runs on by default", () => {
    expect(parseBuildArgs([], linuxHost).targets).toEqual([
      {
        os: "linux",
        arch: "x64",
        bunTarget: "bun-linux-x64",
        file: "supervillain-linux-x64",
        nativePackage: "@opentui/core-linux-x64",
      },
    ]);
    expect(
      parseBuildArgs([], { platform: "darwin", arch: "arm64" }).targets.map((t) => t.file),
    ).toEqual(["supervillain-darwin-arm64"]);
  });

  test("refuses a host it can't build for without --target", () => {
    expect(() => parseBuildArgs([], { platform: "win32", arch: "x64" })).toThrow(/win32-x64/);
  });

  test("takes targets by name, with or without bun-, repeated or comma-separated", () => {
    const files = (argv: string[]) => parseBuildArgs(argv, linuxHost).targets.map((t) => t.file);
    expect(files(["--target", "darwin-arm64"])).toEqual(["supervillain-darwin-arm64"]);
    expect(files(["--target=bun-linux-arm64"])).toEqual(["supervillain-linux-arm64"]);
    expect(files(["--target", "linux-x64,darwin-x64", "--target", "linux-x64"])).toEqual([
      "supervillain-linux-x64",
      "supervillain-darwin-x64",
    ]);
  });

  test("--all is every release target", () => {
    expect(parseBuildArgs(["--all"], linuxHost).targets).toEqual([...TARGETS]);
    expect(TARGETS.map((t) => t.bunTarget)).toEqual([
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-darwin-arm64",
      "bun-darwin-x64",
    ]);
  });

  test("an unknown target names the ones it knows", () => {
    expect(() => parseBuildArgs(["--target", "windows-x64"], linuxHost)).toThrow(
      /windows-x64.*linux-x64, linux-arm64, darwin-arm64, darwin-x64/,
    );
  });

  test("a flag missing its value or a flag it doesn't know is an error", () => {
    expect(() => parseBuildArgs(["--target"], linuxHost)).toThrow(/--target needs a value/);
    expect(() => parseBuildArgs(["--outdir"], linuxHost)).toThrow(/--outdir needs a value/);
    expect(() => parseBuildArgs(["--fast"], linuxHost)).toThrow(/--fast/);
  });

  test("the output folder defaults to dist and the version to none", () => {
    expect(parseBuildArgs([], linuxHost)).toMatchObject({ outdir: "dist", version: undefined });
    expect(parseBuildArgs(["--outdir", "out", "--version=v1.2.3"], linuxHost)).toMatchObject({
      outdir: "out",
      version: "1.2.3",
    });
  });
});
