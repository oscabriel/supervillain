export interface Target {
	readonly os: "linux" | "darwin";
	readonly arch: "x64" | "arm64";
	readonly bunTarget: Bun.Build.CompileTarget;
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

export const TARGETS: ReadonlyArray<Target> = [
	target("linux", "x64"),
	target("linux", "arm64"),
	target("darwin", "arm64"),
	target("darwin", "x64"),
];

const names = TARGETS.map((t) => `${t.os}-${t.arch}`);

export interface BuildArgs {
	readonly targets: ReadonlyArray<Target>;
	readonly outdir: string;
	readonly version: string | undefined;
}

const named = (name: string): Target => {
	const found = TARGETS.find(
		(t) => `${t.os}-${t.arch}` === name.replace(/^bun-/u, "")
	);

	if (found === undefined) {
		throw new Error(
			`unknown target ${name}: the targets are ${names.join(", ")}`
		);
	}

	return found;
};

interface Flag {
	readonly flag: string;
	readonly inline: string | undefined;
}

const splitFlag = (arg: string): Flag => {
	const at = arg.indexOf("=");

	return arg.startsWith("--") && at !== -1
		? { flag: arg.slice(0, at), inline: arg.slice(at + 1) }
		: { flag: arg, inline: undefined };
};

const valueOf = (
	flag: string,
	inline: string | undefined,
	next: string | undefined
): string => {
	const value = inline ?? next;

	if (value === undefined || value === "") {
		throw new Error(`${flag} needs a value`);
	}

	return value;
};

export const parseBuildArgs = (
	argv: ReadonlyArray<string>,
	host: { readonly platform: string; readonly arch: string }
): BuildArgs => {
	const wanted: Array<Target> = [];
	let all = false;
	let outdir = "dist";
	let version: string | undefined;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		const { flag, inline } = splitFlag(arg);
		const next = argv[i + 1];
		const consumed = inline === undefined ? 1 : 0;

		switch (flag) {
			case "--target": {
				for (const name of valueOf(flag, inline, next).split(",")) {
					wanted.push(named(name.trim()));
				}

				i += consumed;
				break;
			}

			case "--all": {
				all = true;
				break;
			}

			case "--outdir": {
				outdir = valueOf(flag, inline, next);
				i += consumed;
				break;
			}

			case "--version": {
				version = valueOf(flag, inline, next).replace(/^v/u, "");
				i += consumed;
				break;
			}

			default: {
				throw new Error(
					`unknown argument ${arg}: use --target <${names.join("|")}>, --all, --outdir or --version`
				);
			}
		}
	}

	if (all) {
		return { targets: TARGETS, outdir, version };
	}

	if (wanted.length === 0) {
		const name = `${host.platform}-${host.arch}`;

		if (!names.includes(name)) {
			throw new Error(
				`can't build for this machine (${name}); pass --target ${names.join("|")}`
			);
		}

		wanted.push(named(name));
	}

	return { targets: [...new Set(wanted)], outdir, version };
};
