import { Runtime } from "foldkit";

import { init, subscriptions, update, view } from "./Main.ts";
import { Message, Model } from "./Model.ts";

import "./style.css";

Runtime.hydrate(
	Runtime.makeApplication({
		Model,
		init,
		update,
		view,
		subscriptions,
		container: document.querySelector("#root"),
		routing: {
			onUrlRequest: (request) => Message.ClickedLink({ request }),
			onUrlChange: (url) => Message.ChangedUrl({ url }),
		},
	})
);
