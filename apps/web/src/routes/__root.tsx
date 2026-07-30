import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

const RootDocument = ({ children }: { children: ReactNode }) => (
	<html lang="en">
		<head>
			<HeadContent />
		</head>
		<body>
			{children}
			<Scripts />
		</body>
	</html>
);

export const Route = createRootRoute({
	component: Outlet,
	head: () => ({
		links: [{ href: "/site.css", rel: "stylesheet" }],
		meta: [
			{ charSet: "utf-8" },
			{ content: "width=device-width, initial-scale=1", name: "viewport" },
			{ title: "supervillain" },
		],
	}),
	shellComponent: RootDocument,
});
