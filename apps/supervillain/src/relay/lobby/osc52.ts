const ESC = "\u001B";

const BEL = "\u0007";

const ST = `${ESC}\\`;

export const OSC52_MAX_BYTES = 74_994;

const SCREEN_CHUNK = 76;

const insideTmux = (term: string, env: Readonly<Record<string, string>>) =>
	term.startsWith("tmux") ||
	env.TMUX !== undefined ||
	env.TERM_PROGRAM === "tmux";

const screenChunks = (sequence: string): string => {
	const pieces: Array<string> = [];

	for (let at = 0; at < sequence.length; at += SCREEN_CHUNK) {
		pieces.push(`${ESC}P${sequence.slice(at, at + SCREEN_CHUNK)}${ST}`);
	}

	return pieces.join("");
};

export const osc52 = (
	text: string,
	term: string,
	env: Readonly<Record<string, string>> = {}
): string => {
	const encoded = Buffer.from(text.trimEnd(), "utf-8").toString("base64");

	if (encoded.length > OSC52_MAX_BYTES) {
		return "";
	}

	const sequence = `${ESC}]52;c;${encoded}${BEL}`;

	if (insideTmux(term, env)) {
		return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;
	}

	return term.startsWith("screen") ? screenChunks(sequence) : sequence;
};
