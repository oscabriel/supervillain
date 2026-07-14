export type ParsedInput =
	| { readonly kind: "empty" }
	| { readonly kind: "chat"; readonly text: string }
	| { readonly kind: "roll"; readonly notation: string }
	| { readonly kind: "quit" }
	| { readonly kind: "unknown-command"; readonly command: string };

export const parseInput = (line: string): ParsedInput => {
	const trimmed = line.trim();
	if (trimmed === "") {
		return { kind: "empty" };
	}
	if (trimmed === "/quit") {
		return { kind: "quit" };
	}
	if (trimmed === "/roll" || trimmed.startsWith("/roll ")) {
		return { kind: "roll", notation: trimmed.slice(5).trim() };
	}
	if (trimmed.startsWith("/")) {
		return {
			command: trimmed.split(/\s/u, 1)[0] ?? trimmed,
			kind: "unknown-command",
		};
	}
	return { kind: "chat", text: trimmed };
};
