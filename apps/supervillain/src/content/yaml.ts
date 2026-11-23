import { Option, Predicate, Schema } from "effect";

export type YamlScalar = string | number | boolean;

export type YamlValue =
	| YamlScalar
	| undefined
	| ReadonlyArray<YamlValue>
	| { readonly [key: string]: YamlValue };

export interface YamlMap {
	readonly [key: string]: YamlValue;
}

const isScalar = (v: YamlValue): v is YamlScalar =>
	Predicate.isString(v) || Predicate.isNumber(v) || Predicate.isBoolean(v);

const isList = (v: YamlValue): v is ReadonlyArray<YamlValue> =>
	Array.isArray(v);

const isMap = (v: YamlValue): v is YamlMap =>
	Predicate.isObject(v) && !isList(v);

const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const echoed = Schema.decodeUnknownOption(Schema.Struct({ k: Schema.String }));

const readsBack = (v: string): boolean => {
	try {
		return Option.exists(
			echoed(Bun.YAML.parse(`k: ${v}`)),
			(parsed) => parsed.k === v
		);
	} catch {
		return false;
	}
};

const scalar = (v: YamlScalar): string => {
	if (!Predicate.isString(v)) {
		return String(v);
	}

	const plain = v !== "" && !v.includes("\n") && v.trim() === v;

	return plain && readsBack(v) ? v : quoted(v);
};

const flowScalar = (v: YamlScalar) =>
	Predicate.isString(v) && /[,[\]{}]/u.test(v) ? quoted(v) : scalar(v);

const flowKey = (k: string) =>
	/[,:[\]{}#"']/u.test(k) || k.trim() !== k || k === "" ? quoted(k) : k;

const mapping = (value: YamlMap, indent: string, out: Array<string>) => {
	for (const [key, v] of Object.entries(value)) {
		if (v === undefined) {
			continue;
		}

		if (isScalar(v)) {
			out.push(`${indent}${key}: ${scalar(v)}`);
		} else if (isList(v)) {
			list(key, v, indent, out);
		} else if (isMap(v)) {
			nested(key, v, indent, out);
		}
	}
};

const list = (
	key: string,
	v: ReadonlyArray<YamlValue>,
	indent: string,
	out: Array<string>
) => {
	const scalars = v.filter(isScalar);

	if (scalars.length === v.length) {
		out.push(`${indent}${key}: [${scalars.map(flowScalar).join(", ")}]`);

		return;
	}

	out.push(`${indent}${key}:`);

	for (const item of v.filter(isMap)) {
		const block: Array<string> = [];
		mapping(item, `${indent}    `, block);
		out.push(`${indent}  - ${block.join("\n").trimStart()}`);
	}
};

const nested = (
	key: string,
	v: YamlMap,
	indent: string,
	out: Array<string>
) => {
	const entries = Object.entries(v);

	const flow = entries.flatMap(([k, x]) =>
		Predicate.isNumber(x) ? [`${flowKey(k)}: ${x}`] : []
	);

	if (flow.length === entries.length) {
		out.push(`${indent}${key}: { ${flow.join(", ")} }`);

		return;
	}

	out.push(`${indent}${key}:`);
	mapping(v, `${indent}  `, out);
};

export const toYaml = (value: YamlMap, header: ReadonlyArray<string> = []) => {
	const lines = header.map((line) => (line === "" ? "#" : `# ${line}`));
	mapping(value, "", lines);

	return `${lines.join("\n")}\n`;
};
