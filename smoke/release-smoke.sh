#!/bin/sh
set -eu

binary=$1
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
exec "$RUN_BINARY" create "$CAMPAIGN"
EOF
chmod 755 "$runner"

case $(uname -s) in
	Darwin)
		script -q "$transcript" env -i HOME="$HOME" TERM=xterm PATH=/usr/bin:/bin \
			RUN_BINARY="$runtime_binary" CAMPAIGN="$campaign" /bin/sh "$runner" <"$input" &
		;;
	Linux)
		command="env -i HOME='$HOME' TERM=xterm PATH=/usr/bin:/bin RUN_BINARY='$runtime_binary' CAMPAIGN='$campaign' /bin/sh '$runner'"
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
	if [ -s "$campaign/door.txt" ] && [ -s "$campaign/events.jsonl" ]; then
		break
	fi
	if ! kill -0 "$script_pid" 2>/dev/null; then
		echo "release smoke: supervillain exited before creating the campaign" >&2
		exit 1
	fi
	attempt=$((attempt + 1))
	sleep 0.1
done

if [ ! -s "$campaign/door.txt" ] || [ ! -s "$campaign/events.jsonl" ]; then
	echo "release smoke: campaign artifacts did not appear" >&2
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

echo "release smoke: door and event log created without bun or node"
