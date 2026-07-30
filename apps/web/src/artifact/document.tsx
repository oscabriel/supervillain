import type {
	SnapshotCardV1,
	SnapshotDocument,
	SnapshotDocumentV1,
	SnapshotFieldV1,
	SnapshotLogEntryV1,
	SnapshotMapGridV1,
	SnapshotTextAttributeV1,
	SnapshotTextRunV1,
	SnapshotThemeTokenV1,
} from "@supervillain/core";
import type { ReactNode } from "react";

const THEME_CLASSES: Readonly<Record<SnapshotThemeTokenV1, string>> = {
	accent: "theme-accent",
	danger: "theme-danger",
	muted: "theme-muted",
	primary: "theme-primary",
	success: "theme-success",
};

const ATTRIBUTE_CLASSES: Readonly<Record<SnapshotTextAttributeV1, string>> = {
	bold: "text-bold",
	dim: "text-dim",
	italic: "text-italic",
	reverse: "text-reverse",
	underline: "text-underline",
};

const Fields = ({
	fields,
}: {
	readonly fields: readonly SnapshotFieldV1[];
}) => (
	<dl className="artifact-fields">
		{fields.map((field) => (
			<div
				className="artifact-field"
				key={`${field.label}\u0000${field.value}`}
			>
				<dt>{field.label}</dt>
				<dd>{field.value}</dd>
			</div>
		))}
	</dl>
);

const ArtifactHeader = ({ card }: { readonly card: SnapshotCardV1 }) => (
	<header className="artifact-header">
		<h1>{card.title}</h1>
		{card.description.length > 0 && <p>{card.description}</p>}
		{card.fields.length > 0 && <Fields fields={card.fields} />}
	</header>
);

const MapGrid = ({ map }: { readonly map: SnapshotMapGridV1 }) => (
	<div className="map-content">
		<pre aria-label={`${map.name} terrain grid`} className="map-grid">
			{map.rows.join("\n")}
		</pre>
		<dl aria-label={`${map.name} legend`} className="map-legend">
			{Object.entries(map.legend).map(([character, terrain]) => (
				<div className="map-legend-entry" key={character}>
					<dt>{character}</dt>
					<dd>{terrain}</dd>
				</div>
			))}
		</dl>
	</div>
);

const InlineMap = ({ map }: { readonly map: SnapshotMapGridV1 }) => (
	<details>
		<summary>{map.name}</summary>
		<MapGrid map={map} />
	</details>
);

const TextRun = ({ run }: { readonly run: SnapshotTextRunV1 }) => {
	const classes = [
		THEME_CLASSES[run.token],
		...(run.attrs ?? []).map((attribute) => ATTRIBUTE_CLASSES[attribute]),
	];
	return <span className={classes.join(" ")}>{run.text}</span>;
};

interface DayBreak {
	readonly date: string;
	readonly id: string;
}

interface RenderedLogEntry {
	readonly dayBreak?: DayBreak;
	readonly entry: SnapshotLogEntryV1;
	readonly key: string;
}

const groupLogEntries = (
	entries: readonly SnapshotLogEntryV1[]
): readonly RenderedLogEntry[] => {
	const dateOccurrences = new Map<string, number>();
	let previousDate: string | undefined;
	return entries.map((entry, position) => {
		const date = entry.timestamp.slice(0, 10);
		let dayBreak: DayBreak | undefined;
		if (date !== previousDate) {
			const occurrence = (dateOccurrences.get(date) ?? 0) + 1;
			dateOccurrences.set(date, occurrence);
			dayBreak = {
				date,
				id: occurrence === 1 ? date : `${date}-${occurrence}`,
			};
			previousDate = date;
		}
		return {
			dayBreak,
			entry,
			key: `${entry.timestamp}\u0000${entry.block.type}\u0000${position}`,
		};
	});
};

const LogEntries = ({
	entries,
}: {
	readonly entries: readonly SnapshotLogEntryV1[];
}) => (
	<div className="artifact-log">
		{groupLogEntries(entries).map(({ dayBreak, entry, key }) => (
			<section className="log-entry" key={key}>
				{dayBreak !== undefined && (
					<h2 className="day-break" id={dayBreak.id}>
						<time dateTime={dayBreak.date}>{dayBreak.date}</time>
					</h2>
				)}
				<div className="log-block">
					{entry.block.type === "text" ? (
						<p>
							{entry.block.runs.map((run, position) => (
								<TextRun
									key={`${run.text}\u0000${run.token}\u0000${position}`}
									run={run}
								/>
							))}
						</p>
					) : (
						<InlineMap map={entry.block} />
					)}
				</div>
			</section>
		))}
	</div>
);

const unsupportedArtifactType = (_document: never): never => {
	throw new Error("Snapshot document has an unsupported artifact type");
};

const renderVersion1 = (document: SnapshotDocumentV1): ReactNode => {
	switch (document.artifactType) {
		case "character": {
			return (
				<article className="artifact artifact-character">
					<ArtifactHeader card={document.card} />
					{document.sections.map((section) => (
						<section className="character-section" key={section.title}>
							<h2>{section.title}</h2>
							<Fields fields={section.fields} />
						</section>
					))}
				</article>
			);
		}
		case "log": {
			return (
				<article className="artifact artifact-log-page">
					<ArtifactHeader card={document.card} />
					<LogEntries entries={document.entries} />
				</article>
			);
		}
		case "map": {
			return (
				<article className="artifact artifact-map">
					<ArtifactHeader card={document.card} />
					<MapGrid map={document.map} />
				</article>
			);
		}
		default: {
			return unsupportedArtifactType(document);
		}
	}
};

const unsupportedSchemaVersion = (document: SnapshotDocument): never => {
	throw new Error(
		`No renderer exists for snapshot schema version ${String(document.schemaVersion)}`
	);
};

/** The schema-version switch is the durable dispatch seam: a v2 adds one arm. */
export const SnapshotDocumentRenderer = ({
	document,
}: {
	readonly document: SnapshotDocument;
}) => {
	switch (document.schemaVersion) {
		case 1: {
			return renderVersion1(document);
		}
		default: {
			return unsupportedSchemaVersion(document);
		}
	}
};
