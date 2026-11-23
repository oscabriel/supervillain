import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import { Effect, Predicate } from "effect";

interface TcpListener {
	readonly server: Server;
	readonly port: number;
	readonly sockets: Set<Socket>;
}

export const tcpListener = (onSocket: (socket: Socket) => void) =>
	Effect.acquireRelease(
		Effect.callback<TcpListener>((resume) => {
			const sockets = new Set<Socket>();

			const server = createServer((socket) => {
				sockets.add(socket);
				socket.once("close", () => {
					sockets.delete(socket);
				});
				socket.on("error", () => {
					socket.destroy();
				});
				onSocket(socket);
			});

			server.listen(0, "127.0.0.1", () => {
				const address = server.address();

				resume(
					Effect.succeed({
						server,
						port:
							address === null || Predicate.isString(address)
								? 0
								: address.port,
						sockets,
					})
				);
			});
		}),
		({ server, sockets }) =>
			Effect.callback<boolean>((resume) => {
				for (const socket of sockets) {
					socket.destroy();
				}

				server.close(() => {
					resume(Effect.succeed(true));
				});
			})
	);
