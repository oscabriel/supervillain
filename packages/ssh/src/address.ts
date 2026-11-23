import { isIPv6 } from "node:net";

const MAPPED = "::ffff:";

export const normalizeAddress = (address: string | undefined): string => {
	if (address === undefined || address === "") {
		return "unknown";
	}

	return address.startsWith(MAPPED) ? address.slice(MAPPED.length) : address;
};

const groupsOf = (part: string | undefined): Array<number> =>
	part === undefined || part === ""
		? []
		: part.split(":").map((g) => Number.parseInt(g, 16));

const ipv6Groups = (address: string): Array<number> | undefined => {
	const [bare = address] = address.split("%");

	if (!isIPv6(bare) || bare.includes(".")) {
		return undefined;
	}

	const [head, tail] = bare.includes("::")
		? bare.split("::")
		: [bare, undefined];

	const front = groupsOf(head);
	const back = groupsOf(tail);

	const groups =
		tail === undefined
			? front
			: [
					...front,
					...Array.from(
						{ length: 8 - front.length - back.length },
						(): number => 0
					),
					...back,
				];

	return groups.length === 8 ? groups : undefined;
};

export const addressBucket = (
	address: string,
	prefix: 48 | 64 = 64
): string => {
	const normal = normalizeAddress(address);
	const groups = ipv6Groups(normal);

	if (groups === undefined) {
		return normal;
	}

	const kept = groups.slice(0, prefix / 16).map((g) => g.toString(16));

	return `${kept.join(":")}::/${prefix}`;
};
