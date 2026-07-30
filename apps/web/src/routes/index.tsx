import { createFileRoute } from "@tanstack/react-router";

/** Placeholder landing page — the real marketing/docs surface is #37's scope. */
const Landing = () => (
	<main>
		<h1>supervillain</h1>
		<p>
			A terminal-first virtual tabletop. The web surface is under construction.
		</p>
	</main>
);

export const Route = createFileRoute("/")({
	component: Landing,
});
