import { Show } from "solid-js";
import type { Accessor } from "solid-js";

import { App } from "./App.tsx";
import { Knock } from "./Knock.tsx";
import type { KnockView, TableView } from "./view.ts";

export const Doorway = (props: {
	knock: KnockView;
	table: Accessor<TableView | undefined>;
}) => (
	<Show when={props.table()} fallback={<Knock view={props.knock} />}>
		{(view: Accessor<TableView>) => <App view={view()} />}
	</Show>
);
