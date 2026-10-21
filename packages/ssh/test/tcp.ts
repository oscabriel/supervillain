import { createServer, type Server, type Socket } from "node:net";
import { Effect } from "effect";

/** A loopback TCP listener for the life of the scope, handing each accepted socket to `onSocket`. */
export const tcpListener = (onSocket: (socket: Socket) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: Server; port: number; sockets: Set<Socket> }>((resolve) => {
          const sockets = new Set<Socket>();
          const server = createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => socket.destroy());
            onSocket(socket);
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
              server,
              port: typeof address === "object" && address ? address.port : 0,
              sockets,
            });
          });
        }),
    ),
    ({ server, sockets }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      ),
  );
