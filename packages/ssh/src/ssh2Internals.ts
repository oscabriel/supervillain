import { Socket } from "node:net";

import type { KexAlgorithm, Server } from "ssh2";
import protocolConstants from "ssh2/lib/protocol/constants.js";

declare module "ssh2" {
	interface Connection {
		readonly _protocol?: {
			readonly channelClose?: (id: number) => void;
		};
	}

	interface Client {
		subsys(
			subsystem: string,
			options: { readonly env?: Readonly<Record<string, string>> },
			callback: ClientCallback
		): this;
	}

	interface Session {
		_ending?: boolean;
		readonly _chanInfo?: {
			readonly outgoing?: { readonly id?: number };
		};
	}
}

const SUPPORTED_KEX: ReadonlySet<string> = new Set(
	protocolConstants.SUPPORTED_KEX
);

const isKexAlgorithm = (name: string): name is KexAlgorithm =>
	SUPPORTED_KEX.has(name);

export const kexAlgorithm = (name: string): KexAlgorithm => {
	if (!isKexAlgorithm(name)) {
		throw new Error(
			`ssh2 does not offer ${name}: is patches/ssh2@1.17.0.patch applied?`
		);
	}

	return name;
};

type Ssh2Socket = Parameters<Server["injectSocket"]>[0];

const isSsh2Socket = (socket: Socket | Ssh2Socket): socket is Ssh2Socket =>
	socket instanceof Socket;

export const injectSocket = (server: Server, socket: Socket): boolean => {
	if (!isSsh2Socket(socket)) {
		return false;
	}

	server.injectSocket(socket);

	return true;
};
