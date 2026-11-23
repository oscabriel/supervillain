import { useTerminalDimensions } from "@opentui/solid";
import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";

import { color, fitLabels, people, personColor, personLabel } from "./theme.ts";
import type { Present } from "./view.ts";

const PADDING = 2;

export const Header = (props: {
	room: string;
	me: string;
	present: ReadonlyArray<Present>;
	alert?: string | undefined;
}) => {
	const size = useTerminalDimensions();

	const lead = () =>
		`supervillain · ${props.room}${props.alert === undefined ? "" : ` · ${props.alert}`}   here: `;

	const fitted = () => {
		const here = people(props.present);
		const labels = here.map((p) => personLabel(p, props.me));

		const { shown, more } = fitLabels(
			labels,
			size().width - PADDING - Bun.stringWidth(lead()),
			here.findIndex((p) => p.actor === props.me)
		);

		return {
			shown: shown.flatMap((i) => {
				const person = here[i];

				return person === undefined ? [] : [person];
			}),
			more,
		};
	};

	return (
		<box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
			<text wrapMode="none" truncate>
				<span style={{ fg: color.brand, bold: true }}>supervillain</span>
				<span style={{ fg: color.dim }}>{" · "}</span>
				<span style={{ fg: color.bright, bold: true }}>{props.room}</span>
				<Show when={props.alert}>
					{(alert: Accessor<string>) => (
						<>
							<span style={{ fg: color.dim }}>{" · "}</span>
							<span style={{ fg: color.notice, bold: true }}>{alert()}</span>
						</>
					)}
				</Show>
				<span style={{ fg: color.dim }}>{"   here: "}</span>
				<For each={fitted().shown}>
					{(p, i) => (
						<span style={{ fg: personColor(p, props.me) }}>
							{`${i() > 0 ? ", " : ""}${personLabel(p, props.me)}`}
						</span>
					)}
				</For>
				<Show when={fitted().more > 0}>
					<span
						style={{ fg: color.dim }}
					>{`${fitted().shown.length > 0 ? ", " : ""}+${fitted().more}`}</span>
				</Show>
			</text>
		</box>
	);
};
