// What `bun scripts/build.ts` builds: the release targets and its arguments, kept apart from the
// build itself so they can be tested without compiling anything.

/** One executable to build: Bun's compile target, its file name and OpenTUI's native package for it. */
export interface Target {
  readonly os: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
  readonly bunTarget: string;
  readonly file: string;
  readonly nativePackage: string;
}

const target = (os: Target["os"], arch: Target["arch"]): Target => ({
  os,
  arch,
  bunTarget: `bun-${os}-${arch}`,
  file: `supervillain-${os}-${arch}`,
  nativePackage: `@opentui/core-${os}-${arch}`,
});

/** Every target a release ships, in the order a release lists them. */
export const TARGETS: readonly Target[] = [
  target("linux", "x64"),
  target("linux", "arm64"),
  target("darwin", "arm64"),
  target("darwin", "x64"),
];

const names = TARGETS.map((t) => `${t.os}-${t.arch}`);

export interface BuildArgs {
  readonly targets: readonly Target[];
  /** Where the executables go, relative to the repo root unless absolute. */
  readonly outdir: string;
  /** What `supervillain --version` reports, without a leading v; the package's when left out. */
  readonly version: string | undefined;
}

const named = (name: string): Target => {
  const found = TARGETS.find((t) => `${t.os}-${t.arch}` === name.replace(/^bun-/, ""));
  if (found === undefined)
    throw new Error(`unknown target ${name}: the targets are ${names.join(", ")}`);
  return found;
};

/**
 * Reads `[--target <os-arch>[,<os-arch>]]... [--all] [--outdir <dir>] [--version <v>]`.
 * With no target it builds for `host`, the machine it runs on.
 */
export const parseBuildArgs = (
  argv: readonly string[],
  host: { readonly platform: string; readonly arch: string },
): BuildArgs => {
  const wanted: Target[] = [];
  let all = false;
  let outdir = "dist";
  let version: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--target":
        for (const name of value().split(",")) wanted.push(named(name.trim()));
        break;
      case "--all":
        all = true;
        break;
      case "--outdir":
        outdir = value();
        break;
      case "--version":
        version = value().replace(/^v/, "");
        break;
      default:
        throw new Error(
          `unknown argument ${arg}: use --target <${names.join("|")}>, --all, --outdir or --version`,
        );
    }
  }
  if (all) return { targets: TARGETS, outdir, version };
  if (wanted.length === 0) {
    const name = `${host.platform}-${host.arch}`;
    if (!names.includes(name))
      throw new Error(`can't build for this machine (${name}); pass --target ${names.join("|")}`);
    wanted.push(named(name));
  }
  return { targets: [...new Set(wanted)], outdir, version };
};
