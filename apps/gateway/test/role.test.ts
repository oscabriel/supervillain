/* oxlint-disable vitest/prefer-importing-vitest-globals -- the gateway is Bun-bound (bun:sqlite); its tests run in Bun's native lane. */
import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
	GATEWAY_ROLE_USAGE,
	parseGatewayRoleArgs,
	resolveGatewayStateDir,
} from "../src/index.js";
import type { GatewayRoleEnvironment } from "../src/index.js";

const bareEnvironment: GatewayRoleEnvironment = {
	env: {},
	homeDir: "/home/gm",
};

const withEnv = (
	env: Readonly<Record<string, string | undefined>>
): GatewayRoleEnvironment => ({ env, homeDir: "/home/gm" });

describe("the gateway role's state directory", () => {
	test("defaults to the XDG state root, never the campaign folder", () => {
		expect(
			resolveGatewayStateDir({
				homeDir: "/home/gm",
				xdgStateHome: "/home/gm/.local/state",
			})
		).toBe(path.join("/home/gm/.local/state", "supervillain", "gateway"));
	});

	test("falls back to ~/.local/state when XDG_STATE_HOME is unset or empty", () => {
		const expected = path.join(
			"/home/gm",
			".local",
			"state",
			"supervillain",
			"gateway"
		);
		expect(resolveGatewayStateDir({ homeDir: "/home/gm" })).toBe(expected);
		expect(
			resolveGatewayStateDir({ homeDir: "/home/gm", xdgStateHome: "" })
		).toBe(expected);
	});

	test("the environment beats the default and the flag beats the environment", () => {
		expect(
			resolveGatewayStateDir({
				env: "/srv/gateway-state",
				homeDir: "/home/gm",
			})
		).toBe("/srv/gateway-state");
		expect(
			resolveGatewayStateDir({
				env: "/srv/gateway-state",
				flag: "/var/lib/supervillain/gateway",
				homeDir: "/home/gm",
			})
		).toBe("/var/lib/supervillain/gateway");
	});
});

describe("parseGatewayRoleArgs", () => {
	test("a bare `serve` takes the pinned defaults", () => {
		const parsed = parseGatewayRoleArgs([], bareEnvironment);
		expect(parsed.kind).toBe("run");
		if (parsed.kind !== "run") {
			return;
		}
		expect(parsed.options.sshPort).toBe(2222);
		expect(parsed.options.sshHost).toBe("127.0.0.1");
		// Unset, not defaulted: the SSH door and the Host pipe bind differently
		// and the runner owns that asymmetry.
		expect(parsed.options.bindHost).toBeUndefined();
		expect(parsed.options.brokerPort).toBeUndefined();
		expect(parsed.options.stateDir).toBe(
			path.join("/home/gm", ".local", "state", "supervillain", "gateway")
		);
	});

	test("flags beat the environment on every option", () => {
		const parsed = parseGatewayRoleArgs(
			[
				"--state",
				"/var/lib/supervillain/gateway",
				"--ssh-host",
				"table.example",
				"--ssh-port",
				"22",
				"--bind",
				"127.0.0.1",
				"--broker-port",
				"9443",
				"--broker-url",
				"wss://table.example/pipe",
			],
			withEnv({
				SUPERVILLAIN_GATEWAY_BIND: "0.0.0.0",
				SUPERVILLAIN_GATEWAY_BROKER_PORT: "1",
				SUPERVILLAIN_GATEWAY_BROKER_URL: "ws://ignored",
				SUPERVILLAIN_GATEWAY_SSH_HOST: "ignored.example",
				SUPERVILLAIN_GATEWAY_SSH_PORT: "1",
				SUPERVILLAIN_GATEWAY_STATE: "/ignored",
			})
		);
		expect(parsed).toEqual({
			kind: "run",
			options: {
				bindHost: "127.0.0.1",
				brokerPort: 9443,
				brokerUrl: "wss://table.example/pipe",
				sshHost: "table.example",
				sshPort: 22,
				stateDir: "/var/lib/supervillain/gateway",
			},
		});
	});

	test("the environment is the fallback layer when no flag is given", () => {
		const parsed = parseGatewayRoleArgs(
			[],
			withEnv({
				SUPERVILLAIN_GATEWAY_BROKER_PORT: "9443",
				SUPERVILLAIN_GATEWAY_SSH_HOST: "table.example",
				SUPERVILLAIN_GATEWAY_SSH_PORT: "2200",
				SUPERVILLAIN_GATEWAY_STATE: "/srv/state",
			})
		);
		expect(parsed.kind).toBe("run");
		if (parsed.kind !== "run") {
			return;
		}
		expect(parsed.options.sshPort).toBe(2200);
		expect(parsed.options.sshHost).toBe("table.example");
		expect(parsed.options.brokerPort).toBe(9443);
		expect(parsed.options.stateDir).toBe("/srv/state");
	});

	test("--help asks for the role's own usage", () => {
		expect(parseGatewayRoleArgs(["--help"], bareEnvironment)).toEqual({
			kind: "help",
		});
		expect(GATEWAY_ROLE_USAGE).toContain("supervillain gateway serve");
	});

	test("a bad port is a one-line complaint, not a crash", () => {
		const parsed = parseGatewayRoleArgs(
			["--ssh-port", "not-a-port"],
			bareEnvironment
		);
		expect(parsed.kind).toBe("error");
		if (parsed.kind !== "error") {
			return;
		}
		expect(parsed.message).toContain("--ssh-port");
	});

	test("an out-of-range port is refused before anything binds", () => {
		expect(
			parseGatewayRoleArgs(["--broker-port", "70000"], bareEnvironment).kind
		).toBe("error");
	});

	test("an unknown flag or a stray positional is refused", () => {
		expect(parseGatewayRoleArgs(["--relay"], bareEnvironment).kind).toBe(
			"error"
		);
		expect(parseGatewayRoleArgs(["extra"], bareEnvironment).kind).toBe("error");
	});
});
