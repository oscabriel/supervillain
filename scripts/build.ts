import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import type { BunPlugin } from "bun";

import { parseBuildArgs } from "./targets.ts";
import type { BuildArgs, Target } from "./targets.ts";

interface SolidPluginModule {
	readonly createSolidTransformPlugin: () => BunPlugin;
}

interface PackageJson {
	readonly version: string;
}

const root = path.resolve(import.meta.dir, "..");

const app = path.join(root, "apps/supervillain");

const entry = path.join(app, "src/main.ts");

const example = path.join(root, "examples/campaign");

const isText = (value: unknown): value is string => String(value) === value;

const isRecord = (value: unknown): value is object => Object(value) === value;

const isSolidPluginModule = (value: unknown): value is SolidPluginModule =>
	isRecord(value) && "createSolidTransformPlugin" in value;

const isPackageJson = (value: unknown): value is PackageJson =>
	isRecord(value) && "version" in value && isText(value.version);

const solidPluginModule: unknown = await import(
	Bun.resolveSync("@opentui/solid/bun-plugin", app)
);

if (!isSolidPluginModule(solidPluginModule)) {
	throw new Error(
		"@opentui/solid/bun-plugin has no createSolidTransformPlugin"
	);
}

const { createSolidTransformPlugin } = solidPluginModule;

const coreDir = path.dirname(
	Bun.resolveSync("@opentui/core/package.json", app)
);

const noPreload: BunPlugin = {
	name: "supervillain-no-runtime-preload",
	setup(build) {
		build.onResolve({ filter: /^@opentui\/solid\/preload$/u }, () => ({
			path: "solid-preload",
			namespace: "supervillain-empty",
		}));
		build.onLoad({ filter: /.*/u, namespace: "supervillain-empty" }, () => ({
			contents: "export {};",
			loader: "js",
		}));
	},
};

const onlyNative = (t: Target): BunPlugin => ({
	name: "supervillain-only-target-native",
	setup(build) {
		build.onResolve(
			{ filter: /^@opentui\/core-(?:darwin|linux|win32)-/u },
			(args) =>
				args.path === t.nativePackage
					? undefined
					: { path: args.path, external: true }
		);
	},
});

const noSsh2Addons: BunPlugin = {
	name: "supervillain-no-ssh2-addons",
	setup(build) {
		build.onResolve(
			{ filter: /^cpu-features$|[/\\]sshcrypto\.node$/u },
			(args) => ({
				path: args.path,
				external: true,
			})
		);
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

const packageVersion = async (): Promise<string> => {
	const manifest: unknown = await Bun.file(
		path.join(app, "package.json")
	).json();

	if (!isPackageJson(manifest)) {
		throw new Error(`${app}/package.json has no version`);
	}

	return manifest.version;
};

const defines = (t: Target, version: string): Record<string, string> => {
	const versioned = {
		"process.env.SUPERVILLAIN_VERSION": JSON.stringify(version),
	};

	return t.os === "linux"
		? { ...versioned, "process.env.OPENTUI_LIBC": JSON.stringify("glibc") }
		: versioned;
};

const build = async (t: Target, outdir: string, version: string) => {
	if (!nativeInstalled(t)) {
		throw new Error(
			`${t.nativePackage} isn't installed, so there is no native library to embed for ${t.os}-${t.arch}. ` +
				`Install every platform's with: bun install --frozen-lockfile --os="*" --cpu="*"`
		);
	}

	const outfile = path.join(outdir, t.file);

	const result = await Bun.build({
		entrypoints: [entry],
		plugins: [
			noPreload,
			noSsh2Addons,
			onlyNative(t),
			createSolidTransformPlugin(),
		],
		minify: true,
		sourcemap: "none",
		define: defines(t, version),
		compile: {
			target: t.bunTarget,
			outfile,
			assets: [example],
			autoloadDotenv: false,
			autoloadBunfig: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
	});

	for (const log of result.logs) {
		console.error(`  ${log.level}: ${log.message}`);
	}

	if (!result.success) {
		throw new Error(`the build for ${t.os}-${t.arch} failed`);
	}

	await chmod(outfile, 0o755);

	return outfile;
};

const messageOf = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const buildOne = async (
	t: Target,
	outdir: string,
	version: string
): Promise<number> => {
	try {
		const outfile = await build(t, outdir, version);
		console.log(`built ${outfile} (${t.bunTarget}, ${version})`);

		return 0;
	} catch (error) {
		console.error(`supervillain build: ${messageOf(error)}`);

		return 1;
	}
};

const buildEach = async (
	targets: ReadonlyArray<Target>,
	outdir: string,
	version: string
): Promise<number> => {
	const [first, ...rest] = targets;

	if (first === undefined) {
		return 0;
	}

	const failed = await buildOne(first, outdir, version);

	return failed + (await buildEach(rest, outdir, version));
};

const main = async () => {
	let args: BuildArgs;

	try {
		args = parseBuildArgs(process.argv.slice(2), process);
	} catch (error) {
		console.error(`supervillain build: ${messageOf(error)}`);
		process.exit(2);
	}

	const outdir = path.resolve(root, args.outdir);
	const version = args.version ?? (await packageVersion());
	await mkdir(outdir, { recursive: true });

	if ((await buildEach(args.targets, outdir, version)) > 0) {
		process.exit(1);
	}
};

await main();
