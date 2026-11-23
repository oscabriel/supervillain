import type { Client } from "ssh2";

export interface ClientProtocol {
	shell: (channel: number, wantReply: boolean) => void;
	session: (channel: number, initWindow: number, maxPacket: number) => void;
	channelClose: (channel: number) => void;
}

declare module "ssh2" {
	interface Client {
		readonly _protocol?: ClientProtocol;
	}
}

export const protocolOf = (client: Client): ClientProtocol => {
	const protocol = client._protocol;

	if (protocol === undefined) {
		throw new Error("this ssh2 client has no protocol yet");
	}

	return protocol;
};
