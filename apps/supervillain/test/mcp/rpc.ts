import { Option, Predicate, Schema } from "effect";

const Message = Schema.Struct({
	id: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Null])),
	result: Schema.optionalKey(Schema.Json),
	error: Schema.optionalKey(Schema.Json),
});

export type Message = typeof Message.Type;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

const Tools = Schema.Struct({
	tools: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const decodeTools = Schema.decodeUnknownOption(Tools);

export const jsonText = Schema.encodeSync(
	Schema.fromJsonString(Schema.Unknown)
);

export interface LineRpc {
	readonly request: (
		method: string,
		params?: Schema.JsonObject
	) => Promise<Message>;
	readonly notify: (method: string, params?: Schema.JsonObject) => void;
	readonly initialize: (protocolVersion?: string) => Promise<Message>;
	readonly feed: (chunk: Uint8Array) => void;
}

const RPC_MS = 10_000;

export const lineRpc = (write: (text: string) => void): LineRpc => {
	let buffer = "";
	let next = 1;
	const waiting = new Map<number, (message: Message) => void>();
	const decoder = new TextDecoder();

	const feed = (chunk: Uint8Array) => {
		buffer += decoder.decode(chunk, { stream: true });

		for (
			let end = buffer.indexOf("\n");
			end !== -1;
			end = buffer.indexOf("\n")
		) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);

			const message = decodeLine(line);

			if (Option.isSome(message) && Predicate.isNumber(message.value.id)) {
				waiting.get(message.value.id)?.(message.value);
				waiting.delete(message.value.id);
			}
		}
	};

	const request = async (method: string, params: Schema.JsonObject = {}) => {
		const id = next;
		next += 1;

		const { promise, resolve, reject } = Promise.withResolvers<Message>();

		const timer = setTimeout(() => {
			reject(new Error(`no answer to ${method} in ${RPC_MS} ms`));
		}, RPC_MS);

		waiting.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		write(`${jsonText({ jsonrpc: "2.0", id, method, params })}\n`);

		return await promise;
	};

	const notify = (method: string, params: Schema.JsonObject = {}) => {
		write(`${jsonText({ jsonrpc: "2.0", method, params })}\n`);
	};

	const initialize = async (protocolVersion = "2025-06-18") => {
		const answer = await request("initialize", {
			protocolVersion,
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});

		notify("notifications/initialized");

		return answer;
	};

	return { request, notify, initialize, feed };
};

export const resultOf = (message: Message): Schema.Json | undefined =>
	message.result;

export const toolNames = (message: Message): ReadonlyArray<string> =>
	Option.match(decodeTools(message.result), {
		onNone: () => [],
		onSome: ({ tools }) => tools.map((tool) => tool.name),
	});
