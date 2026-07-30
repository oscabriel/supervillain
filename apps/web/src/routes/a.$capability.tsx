import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { SnapshotDocumentRenderer } from "../artifact/document";

const getArtifact = createServerFn({ method: "GET" })
	.validator((capability: string) => capability)
	.handler(async ({ data }) => {
		// Dynamic imports keep durable reads and runtime schema validation out of
		// the client bundle; the capability exists only inside this server fence.
		const [{ validateSnapshotDocument }, { getArtifact: read }] =
			await Promise.all([
				import("@supervillain/core"),
				import("../server/store"),
			]);
		const artifact = read(data);
		if (!artifact) {
			throw notFound();
		}
		const validated = validateSnapshotDocument(artifact.document);
		if (!validated.ok) {
			throw new Error(
				`Stored snapshot has no renderer: ${validated.errors.map(({ message }) => message).join(" ")}`
			);
		}
		return validated.document;
	});

const ArtifactPage = () => {
	// oxlint-disable-next-line eslint/no-use-before-define -- TanStack's route↔component shape is mutually referential; `Route` resolves lazily at render time.
	const document = Route.useLoaderData();
	return (
		<main>
			<SnapshotDocumentRenderer document={document} />
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
	head: () => ({
		meta: [{ content: "noindex", name: "robots" }],
	}),
	loader: ({ params }) => getArtifact({ data: params.capability }),
	notFoundComponent: ArtifactNotFound,
});
