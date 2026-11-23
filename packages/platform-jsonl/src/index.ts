export { CampaignLog, LogError } from "./CampaignLog.ts";

export {
	batchesOf,
	decodeBatch,
	decodeStoredEvent,
	encodeLine,
	encodeLines,
	epochOf,
	eventOf,
	timestampOf,
	type Batch,
	type Source,
} from "./codec.ts";

export { Line, LineJson, type Envelope } from "./envelope.ts";

export {
	JsonlPlatform,
	Refused,
	Unsupported,
	type JsonlPlatformOptions,
	type Snapshot,
} from "./JsonlPlatform.ts";

export { parseLog, type LineProblem, type ParsedLog } from "./parseLog.ts";
