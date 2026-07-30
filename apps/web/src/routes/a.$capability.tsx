import type { SnapshotDocument } from "@supervillain/core";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { SnapshotDocumentRenderer } from "../artifact/document";

export interface ArtifactLoaderData {
	readonly document: SnapshotDocument;
	readonly imageUrl: string;
}

const getArtifact = createServerFn({ method: "GET" })
	.validator((capability: string) => capability)
	.handler(async ({ data }): Promise<ArtifactLoaderData> => {
		// Dynamic imports keep durable reads and runtime schema validation out of
		// the client bundle; the capability exists only inside this server fence.
		const [
			{ validateSnapshotDocument },
			{ getRequestUrl },
			{ getArtifact: read },
			{ fullArtifactImageUrl },
		] = await Promise.all([
			import("@supervillain/core"),
			import("@tanstack/react-start/server"),
			import("../server/store"),
			import("../server/urls"),
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
		return {
			document: validated.document,
			imageUrl: fullArtifactImageUrl(data, getRequestUrl().toString()),
		};
	});

const ArtifactPage = () => {
	// oxlint-disable-next-line eslint/no-use-before-define -- TanStack's route↔component shape is mutually referential; `Route` resolves lazily at render time.
	const { document } = Route.useLoaderData();
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

// oxlint-disable-next-line eslint/sort-keys -- loader must precede head for TanStack's contextual loaderData inference.
export const Route = createFileRoute("/a/$capability")({
	component: ArtifactPage,
	loader: async ({ params }): Promise<ArtifactLoaderData> =>
		await getArtifact({ data: params.capability }),
	head: ({ loaderData }) => ({
		meta: [
			{ content: "noindex", name: "robots" },
			{
				content: loaderData?.document.card.title ?? "supervillain artifact",
				property: "og:title",
			},
			{
				content: loaderData?.document.card.description ?? "",
				property: "og:description",
			},
			{ content: loaderData?.imageUrl ?? "", property: "og:image" },
			{ content: "website", property: "og:type" },
			{ content: "summary_large_image", name: "twitter:card" },
		],
	}),
	notFoundComponent: ArtifactNotFound,
});
