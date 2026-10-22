import { describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
  errLine,
  helloLine,
  isReservedRoom,
  isRoomName,
  LineError,
  MAX_LINE_BYTES,
  parseAnswer,
  parseHello,
  readLine,
} from "../../src/relay/protocol.ts";

describe("the hello line", () => {
  test("names a room in the one version there is", () => {
    expect(helloLine("den")).toBe("SUPERVILLAIN 1 ROOM den\n");
    expect(parseHello("SUPERVILLAIN 1 ROOM den")).toEqual({ ok: true, room: "den" });
    expect(parseHello(`SUPERVILLAIN 1 ROOM a${"b-9".repeat(10)}c`)).toEqual({
      ok: true,
      room: `a${"b-9".repeat(10)}c`,
    });
    expect(parseHello(helloLine("x").slice(0, -1))).toEqual({ ok: true, room: "x" });
  });

  test("anything else is refused with a reason", () => {
    for (const line of [
      "",
      "GET / HTTP/1.1",
      "SSH-2.0-OpenSSH_9.9",
      "SUPERVILLAIN 2 ROOM den",
      "SUPERVILLAIN 1 ROOM",
      "SUPERVILLAIN 1 ROOM ",
      "SUPERVILLAIN 1 ROOM den\r",
      "SUPERVILLAIN 1 ROOM den extra",
      "SUPERVILLAIN 1 ROOM  den",
      "SUPERVILLAIN 1 ROOM Den",
      "SUPERVILLAIN 1 ROOM 9den",
      "SUPERVILLAIN 1 ROOM -den",
      "SUPERVILLAIN 1 ROOM den_1",
      "SUPERVILLAIN 1 ROOM dën",
      `SUPERVILLAIN 1 ROOM a${"b".repeat(32)}`,
      "supervillain 1 room den",
    ]) {
      const parsed = parseHello(line);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
    }
  });

  test("room names: 1-32 of a-z, 0-9 and -, starting with a letter", () => {
    expect(isRoomName("a")).toBe(true);
    expect(isRoomName(`a${"0".repeat(31)}`)).toBe(true);
    expect(isRoomName(`a${"0".repeat(32)}`)).toBe(false);
    expect(isRoomName("")).toBe(false);
  });

  test("names ssh sends by default, and service words, are reserved", () => {
    // A bare `ssh relay` logs in as the local user: those names never route to a table.
    for (const name of [
      "root",
      "admin",
      "ubuntu",
      "pi",
      "ec2-user",
      "git",
      "lobby",
      "help",
      "watch",
    ])
      expect(isReservedRoom(name)).toBe(true);
    for (const name of ["den", "first-fight", "rootcellar", "pirates"])
      expect(isReservedRoom(name)).toBe(false);
    expect(parseHello("SUPERVILLAIN 1 ROOM root")).toEqual({
      ok: false,
      reason: "room name root is reserved: pick another",
    });
  });
});

describe("the answer line", () => {
  test("OK, or ERR with a reason on one line", () => {
    expect(parseAnswer("OK")).toEqual({ ok: true });
    expect(errLine("busy\nOK")).toBe("ERR busy OK\n");
    expect(parseAnswer(errLine("room busy").slice(0, -1))).toEqual({
      ok: false,
      reason: "room busy",
    });
    expect(parseAnswer("OK SHA256:abc").ok).toBe(false);
    expect(parseAnswer("").ok).toBe(false);
  });
});

/** A loopback pair: what one end writes, the other reads. */
const pair = () =>
  new Promise<{ near: Socket; far: Socket; close: () => void }>((resolve) => {
    const server: Server = createServer((far) => {
      resolve({
        near,
        far,
        close: () => {
          near.destroy();
          far.destroy();
          server.close();
        },
      });
    });
    let near: Socket;
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      near = connect(typeof address === "object" && address ? address.port : 0, "127.0.0.1");
    });
  });

describe("readLine", () => {
  test("reads one line and leaves what follows for the next reader, even in one chunk", async () => {
    const { near, far, close } = await pair();
    try {
      near.write(`${helloLine("den")}SSH-2.0-test\r\nmore`);
      expect(await readLine(far)).toBe("SUPERVILLAIN 1 ROOM den");
      const rest = await new Promise<string>((resolve) => {
        let text = "";
        far.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.endsWith("more")) resolve(text);
        });
        far.resume();
      });
      expect(rest).toBe("SSH-2.0-test\r\nmore");
    } finally {
      close();
    }
  });

  test("a line split across chunks is joined", async () => {
    const { near, far, close } = await pair();
    try {
      near.write("SUPERVILLAIN 1 ");
      setTimeout(() => near.write("ROOM den\n"), 30);
      expect(await readLine(far)).toBe("SUPERVILLAIN 1 ROOM den");
    } finally {
      close();
    }
  });

  test("an oversized line is refused without waiting for its end", async () => {
    const { near, far, close } = await pair();
    try {
      near.write("x".repeat(MAX_LINE_BYTES * 4));
      await expect(readLine(far)).rejects.toBeInstanceOf(LineError);
      // A newline past the limit doesn't save it either.
      const second = await pair();
      try {
        second.near.write(`${"y".repeat(MAX_LINE_BYTES)}\n`);
        await expect(readLine(second.far)).rejects.toThrow("line too long");
      } finally {
        second.close();
      }
    } finally {
      close();
    }
  });

  test("silence times out; a peer that leaves first fails the read", async () => {
    const { far, close } = await pair();
    try {
      await expect(readLine(far, 50)).rejects.toThrow("no line in time");
    } finally {
      close();
    }
    const gone = await pair();
    const reading = readLine(gone.far);
    gone.near.end("partial");
    await expect(reading).rejects.toBeInstanceOf(LineError);
    gone.close();
  });
});
