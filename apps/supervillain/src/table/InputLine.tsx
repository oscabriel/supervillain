import { inputWindow } from "./input.ts";
import type { LineState } from "./input.ts";
import { color } from "./theme.ts";

const PLACEHOLDER = "say something, or /help";

export const InputLine = (props: {
	prompt: string;
	line: LineState;
	width: number;
	placeholder: boolean;
}) => {
	const slice = () =>
		inputWindow(
			props.line.text,
			props.line.cursor,
			props.width - props.prompt.length - 2
		);

	const hint = () =>
		props.placeholder && props.line.text === "" ? PLACEHOLDER : "";

	return (
		<box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
			<text wrapMode="none" truncate>
				<span style={{ fg: color.gm }}>{props.prompt}</span>
				<span style={{ fg: color.bright }}>{slice().before}</span>
				<span style={{ fg: color.cursorFg, bg: color.cursorBg }}>
					{slice().at}
				</span>
				<span style={{ fg: color.bright }}>{slice().after}</span>
				<span style={{ fg: color.dim }}>{hint()}</span>
			</text>
		</box>
	);
};
