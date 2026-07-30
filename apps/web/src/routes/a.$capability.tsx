import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

/**
 * The tracer's SSR artifact route: 200 with a server-rendered body for a
 * known capability, 404 for anything else — the #43 spike's shape. The real
 * page (#106: the generic document renderer, day-break anchors, MonoMek)
 * replaces the body; the capability-safety headers and indistinguishable
 * 404 semantics are #102's spec.
 */
const getArtifact = createServerFn({ method: "GET" })
	.validator((capability: string) => capability)
	.handler(async ({ data }) => {
		// Dynamic import keeps the store out of the client bundle: this
		// handler body runs only on the server after serverFn extraction.
		const { getArtifact: read } = await import("../server/store");
		const artifact = read(data);
		if (!artifact) {
			throw notFound();
		}
		// Only the fields the page renders: the opaque `document` is #100's
		// schema and doesn't satisfy the serverFn serializability constraint
		// (nor should the tracer pretend to render it).
		return { name: artifact.name, type: artifact.type };
	});

const ArtifactPage = () => {
	// oxlint-disable-next-line eslint/no-use-before-define -- TanStack's route↔component shape is mutually referential; `Route` resolves lazily at render time.
	const artifact = Route.useLoaderData();
	return (
		<main>
			<h1>{artifact.name}</h1>
			<p>
				Published <strong>{artifact.type}</strong> artifact.
			</p>
		</main>
	);
};

const ArtifactNotFound = () => (
	<main>
		<h1>Not found</h1>
		<p>No artifact lives at this address.</p>
	</main>
);

export const Route = createFileRoute("/a/$capability")({
	component: ArtifactPage,
	loader: ({ params }) => getArtifact({ data: params.capability }),
	notFoundComponent: ArtifactNotFound,
});
