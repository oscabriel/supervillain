#!/bin/sh
# Usage: gateway-smoke.sh <binary>
#
# The gateway-role half of the release smoke (ADR-0014). The CLI-role smoke
# proves the downloaded artifact can host a table; this one proves the *same*
# artifact can be the gateway — no repo checkout, no bun, no node, nothing on
# the box but the one file a user downloaded. That is the whole content of
# "free to self-host, forever" (ADR-0012, NQ-9), so it is a release gate.
#
# It runs the binary in the gateway role, then runs the same binary in the CLI
# role against it: `create --name --gateway` only reaches a live table if the
# gateway accepted the outbound pipe and the durable claim landed in the
# gateway's own store.
set -eu

binary=$1
case "$binary" in
	/*) ;;
	*) binary=$(pwd)/$binary ;;
esac

smoke_directory=$(cd "$(dirname "$0")" && pwd)
room=smokeroom
ssh_port=${SUPERVILLAIN_SMOKE_SSH_PORT:-42222}

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/supervillain-gateway-smoke.XXXXXX")
gateway_pid=
cleanup() {
	if [ -n "$gateway_pid" ]; then
		kill "$gateway_pid" 2>/dev/null || true
	fi
	rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

runtime_binary=$temporary_directory/supervillain
state=$temporary_directory/state
log=$temporary_directory/gateway.log
cp "$binary" "$runtime_binary"
chmod 755 "$runtime_binary"

# env -i is the clean box: no PATH to a checkout, no bun, no node, and no
# SUPERVILLAIN_* left over from the runner.
env -i HOME="$temporary_directory" PATH=/usr/bin:/bin \
	"$runtime_binary" gateway serve \
	--state "$state" \
	--ssh-host 127.0.0.1 \
	--ssh-port "$ssh_port" \
	--bind 127.0.0.1 \
	--broker-port 0 \
	>"$log" 2>&1 &
gateway_pid=$!

attempt=0
gateway_url=
while [ "$attempt" -lt 600 ]; do
	gateway_url=$(sed -n 's|.*\(ws://[^ ]*\).*|\1|p' "$log" | head -1)
	if [ -n "$gateway_url" ]; then
		break
	fi
	if ! kill -0 "$gateway_pid" 2>/dev/null; then
		echo "gateway smoke: the gateway exited before opening the gate" >&2
		cat "$log" >&2
		exit 1
	fi
	attempt=$((attempt + 1))
	sleep 0.1
done

if [ -z "$gateway_url" ]; then
	echo "gateway smoke: the gateway never announced its address" >&2
	cat "$log" >&2
	exit 1
fi

# A clean box arrives with no state directory; the gateway makes its own.
for artifact in identity.json ssh_host_ed25519_key registry.db; do
	if [ ! -s "$state/$artifact" ]; then
		echo "gateway smoke: the gateway did not create $artifact" >&2
		exit 1
	fi
done

# The CLI role, same binary, against the gateway this binary is serving. A
# failed registration exits `create` before any campaign artifact appears, so
# the CLI smoke's own assertions are the end-to-end check.
sh "$smoke_directory/release-smoke.sh" "$runtime_binary" \
	--name "$room" --gateway "$gateway_url"

# The claim is durable, in the gateway's store — not just a live attachment.
if ! grep -alq "$room" "$state"/*; then
	echo "gateway smoke: the room name never reached the gateway's store" >&2
	exit 1
fi

# The operator's stop is a clean one: SIGTERM, not a kill.
kill -TERM "$gateway_pid"
wait "$gateway_pid" || {
	echo "gateway smoke: the gateway did not shut down cleanly" >&2
	exit 1
}
gateway_pid=

echo "gateway smoke: one binary served the gateway and hosted a room through it"
