#!/usr/bin/env bun
// Compiles the one binary: `bun scripts/build.ts [--target linux-x64,...|--all] [--outdir dist]`
// writes dist/supervillain-<os>-<arch>, one self-contained executable per target.
//
// Three things make an OpenTUI app compile (OpenTUI's docs/reference/standalone-executables.mdx):
// the Solid JSX transform runs at build time through @opentui/solid's bun plugin; the native
// library comes from the target's @opentui/core-<os>-<arch> package, which Bun embeds because it is
// imported `with { type: "file" }`; and Linux defines OPENTUI_LIBC so only the glibc library goes in.
// The runtime preload that registers the transform for `bun run` has nothing left to do in a binary,
// so it compiles to an empty module. The sample campaign rides along as an embedded asset.
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { type BuildArgs, parseBuildArgs, type Target } from "./targets.ts";

const root = resolve(import.meta.dir, "..");
const app = join(root, "apps/supervillain");
const entry = join(app, "src/main.ts");
const example = join(root, "examples/campaign");

const { createSolidTransformPlugin } = (await import(
  Bun.resolveSync("@opentui/solid/bun-plugin", app)
)) as { createSolidTransformPlugin: () => BunPlugin };
const coreDir = dirname(Bun.resolveSync("@opentui/core/package.json", app));

/** The runtime Solid preload, emptied: the transform already ran. */
const noPreload: BunPlugin = {
  name: "supervillain-no-runtime-preload",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/solid\/preload$/ }, () => ({
      path: "solid-preload",
      namespace: "supervillain-empty",
    }));
    build.onLoad({ filter: /.*/, namespace: "supervillain-empty" }, () => ({
      contents: "export {};",
      loader: "js",
    }));
  },
};

/** Other platforms' native packages stay out: the binary never runs there, and they may not be installed. */
const onlyNative = (t: Target): BunPlugin => ({
  name: "supervillain-only-target-native",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/core-(?:darwin|linux|win32)-/ }, (args) =>
      args.path === t.nativePackage ? undefined : { path: args.path, external: true },
    );
  },
});

/**
 * ssh2's optional native addons stay out. They are built for the machine that ran `bun install`, so
 * a cross-compiled binary would carry the wrong platform's; ssh2 loads both in a try and falls back
 * to its JavaScript ciphers, so every binary behaves alike whichever machine built it.
 */
const noSsh2Addons: BunPlugin = {
  name: "supervillain-no-ssh2-addons",
  setup(build) {
    build.onResolve({ filter: /^cpu-features$|[/\\]sshcrypto\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const nativeInstalled = (t: Target) => {
  try {
    Bun.resolveSync(`${t.nativePackage}/package.json`, coreDir);
    return true;
  } catch {
    return false;
  }
};

const packageVersion = async () =>
  ((await Bun.file(join(app, "package.json")).json()) as { version: string }).version;

const build = async (t: Target, outdir: string, version: string) => {
  if (!nativeInstalled(t))
    throw new Error(
      `${t.nativePackage} isn't installed, so there is no native library to embed for ${t.os}-${t.arch}. ` +
        `Install every platform's with: bun install --frozen-lockfile --os="*" --cpu="*"`,
    );
  const outfile = join(outdir, t.file);
  const result = await Bun.build({
    entrypoints: [entry],
    plugins: [noPreload, noSsh2Addons, onlyNative(t), createSolidTransformPlugin()],
    minify: true,
    sourcemap: "none",
    define: {
      "process.env.SUPERVILLAIN_VERSION": JSON.stringify(version),
      ...(t.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify("glibc") } : {}),
    },
    compile: {
      target: t.bunTarget as Bun.Build.CompileTarget,
      outfile,
      // The sample campaign for `new --example`, at import.meta.dir/campaign inside the binary.
      assets: [example],
      // A GM's campaign folder is theirs: the binary reads no .env, bunfig.toml or package.json there.
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  for (const log of result.logs) console.error(`  ${log.level}: ${log.message}`);
  if (!result.success) throw new Error(`the build for ${t.os}-${t.arch} failed`);
  await chmod(outfile, 0o755);
  return outfile;
};

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const main = async () => {
  let args: BuildArgs;
  try {
    args = parseBuildArgs(process.argv.slice(2), process);
  } catch (e) {
    console.error(`supervillain build: ${messageOf(e)}`);
    process.exit(2);
  }
  const outdir = resolve(root, args.outdir);
  const version = args.version ?? (await packageVersion());
  await mkdir(outdir, { recursive: true });
  let failed = 0;
  for (const t of args.targets) {
    try {
      const outfile = await build(t, outdir, version);
      console.log(`built ${outfile} (${t.bunTarget}, ${version})`);
    } catch (e) {
      failed++;
      console.error(`supervillain build: ${messageOf(e)}`);
    }
  }
  if (failed > 0) process.exit(1);
};

await main();
