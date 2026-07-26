#!/bin/sh
# Usage: release-smoke.sh <binary> [extra create args...]
# Proves the downloaded artifact runs the CLI role — `create` reaching a live
# table — with no repo checkout, no bun, and no node. Extra arguments are
# appended to the `create` line; smoke/gateway-smoke.sh uses them to point this
# same run at a gateway the same binary is serving.
set -eu

binary=$1
shift
create_arguments=$*
case "$binary" in
	/*) ;;
	*) binary=$(pwd)/$binary ;;
esac

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/supervillain-release-smoke.XXXXXX")
script_pid=
watchdog_pid=
cleanup() {
	if [ -n "$watchdog_pid" ]; then
		kill "$watchdog_pid" 2>/dev/null || true
	fi
	if [ -n "$script_pid" ]; then
		kill "$script_pid" 2>/dev/null || true
	fi
	rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

runtime_binary=$temporary_directory/supervillain
campaign=$temporary_directory/campaign
transcript=$temporary_directory/screen.txt
input=$temporary_directory/input
runner=$temporary_directory/run.sh
cp "$binary" "$runtime_binary"
chmod 755 "$runtime_binary"
mkfifo "$input"

cat >"$runner" <<'EOF'
#!/bin/sh
stty cols 100 rows 30
# shellcheck disable=SC2086 -- CREATE_ARGS is our own flag list and must split.
exec "$RUN_BINARY" create "$CAMPAIGN" $CREATE_ARGS
EOF
chmod 755 "$runner"

case $(uname -s) in
	Darwin)
		# BSD script demands a tty stdin (tcgetattr), which CI lacks; python's
		# pty.spawn tolerates a non-tty stdin and still gives the child a real pty.
		env -i HOME="$HOME" TERM=xterm PATH=/usr/bin:/bin \
			RUN_BINARY="$runtime_binary" CAMPAIGN="$campaign" \
			CREATE_ARGS="$create_arguments" \
			/usr/bin/python3 -c 'import pty,sys; sys.exit(pty.spawn(["/bin/sh", sys.argv[1]]))' "$runner" \
			<"$input" >"$transcript" 2>&1 &
		;;
	Linux)
		command="env -i HOME='$HOME' TERM=xterm PATH=/usr/bin:/bin RUN_BINARY='$runtime_binary' CAMPAIGN='$campaign' CREATE_ARGS='$create_arguments' /bin/sh '$runner'"
		script -qec "$command" "$transcript" <"$input" &
		;;
	*)
		echo "release smoke: unsupported host" >&2
		exit 1
		;;
esac
script_pid=$!
exec 3>"$input"
(
	sleep 90
	kill "$script_pid" 2>/dev/null || true
) &
watchdog_pid=$!

attempt=0
while [ "$attempt" -lt 600 ]; do
	if [ -s "$campaign/events.jsonl" ] && grep -q "your table is live\." "$transcript"; then
		break
	fi
	if ! kill -0 "$script_pid" 2>/dev/null; then
		echo "release smoke: supervillain exited before creating the campaign" >&2
		exit 1
	fi
	attempt=$((attempt + 1))
	sleep 0.1
done

if [ ! -s "$campaign/events.jsonl" ] || ! grep -q "your table is live\." "$transcript"; then
	echo "release smoke: create did not reach a live table" >&2
	exit 1
fi

printf 'q' >&3
exec 3>&-
sleep 1
kill "$script_pid" 2>/dev/null || true
wait "$script_pid" 2>/dev/null || true
script_pid=
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=

echo "release smoke: table reached and event log created without bun or node"
