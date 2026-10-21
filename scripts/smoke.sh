#!/usr/bin/env bash
# Smoke-runs a compiled supervillain from an empty folder, the way a GM would:
#   scripts/smoke.sh dist/supervillain-linux-x64
# It makes the sample campaign, hosts it headless on a free port, talks to it with OpenSSH (one
# command at a time, and a real terminal through tmux when tmux is there), checks that the host key
# OpenSSH saw is the one the host printed, stops the host and reads the log back with `check`.
# Then it runs a relay, hosts the campaign through it, and plays one command through the relay.
# Needs ssh and ssh-keygen. Exits non-zero, with the host's output, on the first thing that's wrong.
# With SMOKE_REQUIRE_TTY=1 (as CI sets it), a missing tmux is a failure, not a skipped step: the
# terminal seat is the only step that loads OpenTUI's native library.
set -euo pipefail

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: scripts/smoke.sh <path to a supervillain binary>" >&2
  exit 2
fi
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
work="$(mktemp -d "${TMPDIR:-/tmp}/supervillain-smoke.XXXXXX")"
host_pid=""
relay_pid=""
tmux_socket="supervillain-smoke-$$"

cleanup() {
  if command -v tmux >/dev/null 2>&1; then tmux -L "$tmux_socket" kill-server 2>/dev/null || true; fi
  if [ -n "$host_pid" ]; then kill "$host_pid" 2>/dev/null || true; fi
  if [ -n "$relay_pid" ]; then kill "$relay_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "smoke: FAIL: $*" >&2
  if [ -f "$work/host.out" ]; then
    echo "--- host output ---" >&2
    cat "$work/host.out" >&2
  fi
  if [ -f "$work/relay.out" ]; then
    echo "--- relay output ---" >&2
    cat "$work/relay.out" >&2
  fi
  exit 1
}

step() { echo "smoke: $*"; }

cd "$work"
cp "$bin" ./supervillain
chmod +x ./supervillain

step "$(./supervillain --version)"
./supervillain new ./camp --example || fail "new --example"
if [ ! -f camp/heroes/brann.yaml ] || [ ! -f camp/maps/ford-road.txt ]; then
  fail "the sample campaign wasn't copied"
fi

./supervillain host ./camp --headless --port 0 >host.out 2>&1 &
host_pid=$!
port=""
for _ in $(seq 1 100); do
  port="$(sed -n 's/^players join with: ssh -p \([0-9][0-9]*\) .*/\1/p' host.out | head -n 1)"
  [ -n "$port" ] && break
  kill -0 "$host_pid" 2>/dev/null || fail "the host exited before it listened"
  sleep 0.1
done
[ -n "$port" ] || fail "the host never printed its port"
printed_fp="$(sed -n 's/^host key \(SHA256:[A-Za-z0-9+/]*\)$/\1/p' host.out | head -n 1)"
step "hosting on 127.0.0.1:$port, host key $printed_fp"

ssh-keygen -q -t ed25519 -N "" -C smoke -f "$work/player_key"
cat >"$work/ssh_config" <<EOF
Host table
  HostName 127.0.0.1
  Port $port
  User camp
  IdentityFile $work/player_key
  IdentitiesOnly yes
  UserKnownHostsFile $work/known_hosts
  StrictHostKeyChecking accept-new
  BatchMode yes
  ConnectTimeout 10
  LogLevel ERROR
EOF

# One exec, its stdout checked for a piece of text.
expect_exec() {
  local line="$1" want="$2" out
  out="$(ssh -F "$work/ssh_config" table "$line" 2>/dev/null)" || fail "ssh '$line' exited $?: $out"
  case "$out" in
  *"$want"*) step "ssh table '$line' -> $(printf '%s' "$out" | head -n 1)" ;;
  *) fail "ssh table '$line' printed '$out', not '$want'" ;;
  esac
}

expect_exec "/name Smoke" "is now Smoke"
expect_exec "hello from the smoke test" "Smoke: hello from the smoke test"
expect_exec "/roll 2d10+2" "Smoke rolled 2d10+2"

seen_fp="$(ssh-keygen -l -f "$work/known_hosts" | awk '{print $2}' | head -n 1)"
[ "$seen_fp" = "$printed_fp" ] || fail "OpenSSH saw host key $seen_fp, the host printed $printed_fp"
step "OpenSSH saw the host key the host printed"

if command -v tmux >/dev/null 2>&1; then
  tmux -L "$tmux_socket" new-session -d -s seat -x 100 -y 30 "ssh -t -F $work/ssh_config table"
  screen=""
  for _ in $(seq 1 100); do
    screen="$(tmux -L "$tmux_socket" capture-pane -p -t seat 2>/dev/null || true)"
    case "$screen" in *"supervillain · camp"*) break ;; esac
    sleep 0.1
  done
  case "$screen" in *"supervillain · camp"*) ;; *) fail "the terminal seat never drew the table: $screen" ;; esac
  tmux -L "$tmux_socket" send-keys -t seat -l "typed in a terminal"
  sleep 0.3
  tmux -L "$tmux_socket" send-keys -t seat C-m
  for _ in $(seq 1 50); do
    screen="$(tmux -L "$tmux_socket" capture-pane -p -t seat)"
    case "$screen" in *"Smoke: typed in a terminal"*) break ;; esac
    sleep 0.1
  done
  case "$screen" in *"Smoke: typed in a terminal"*) ;; *) fail "the terminal seat didn't show its chat: $screen" ;; esac
  step "a terminal seat (tmux, 100x30) drew the table and sent a line"
  echo "$screen" | head -n 8
  tmux -L "$tmux_socket" kill-server 2>/dev/null || true
elif [ "${SMOKE_REQUIRE_TTY:-0}" = "1" ]; then
  fail "no tmux here, and SMOKE_REQUIRE_TTY=1 needs the terminal seat"
else
  step "no tmux here: skipped the terminal seat"
fi

kill -TERM "$host_pid"
status=0
wait "$host_pid" || status=$?
host_pid=""
[ "$status" -eq 0 ] || fail "the host exited $status on SIGTERM"
step "the host stopped cleanly on SIGTERM"

check_out="$(./supervillain check ./camp)" || fail "check exited $?: $check_out"
case "$check_out" in
*"Smoke: hello from the smoke test"*) ;;
*) fail "check didn't read the chat back: $check_out" ;;
esac
step "check read the log back:"
echo "$check_out" | head -n 12

# The relay: the host dials out to it, and players reach the campaign through it.
./supervillain relay --dir ./relay --bind 127.0.0.1 --player-port 0 --gm-port 0 >relay.out 2>&1 &
relay_pid=$!
player_port=""
gm_port=""
for _ in $(seq 1 100); do
  player_port="$(sed -n 's/^players join with: ssh -p \([0-9][0-9]*\) .*/\1/p' relay.out | head -n 1)"
  gm_port="$(sed -n 's/^GMs dial 127\.0\.0\.1:\([0-9][0-9]*\) .*/\1/p' relay.out | head -n 1)"
  [ -n "$player_port" ] && [ -n "$gm_port" ] && break
  kill -0 "$relay_pid" 2>/dev/null || fail "the relay exited before it listened"
  sleep 0.1
done
[ -n "$gm_port" ] || fail "the relay never printed its ports"
step "relay: players on $player_port, GMs on $gm_port"

./supervillain host ./camp --headless --port 0 --relay "127.0.0.1:$gm_port" \
  --relay-player-port "$player_port" >host.out 2>&1 &
host_pid=$!
for _ in $(seq 1 100); do
  grep -q 'linked as room "camp"' host.out && break
  kill -0 "$host_pid" 2>/dev/null || fail "the host exited before it linked"
  sleep 0.1
done
grep -q 'linked as room "camp"' host.out || fail "the host never linked to the relay"
grep -q "trusted relay key SHA256:.* on first use" host.out || fail "the host didn't pin the relay key"
step "the host linked to the relay and pinned its key in relay_known"

cat >>"$work/ssh_config" <<EOF
Host relayed
  HostName 127.0.0.1
  Port $player_port
  User camp
  IdentityFile $work/player_key
  IdentitiesOnly yes
  UserKnownHostsFile $work/known_hosts_relay
  StrictHostKeyChecking accept-new
  BatchMode yes
  ConnectTimeout 10
  LogLevel ERROR
EOF
out="$(ssh -F "$work/ssh_config" relayed "/roll 1d6" 2>/dev/null)" || fail "ssh through the relay exited $?: $out"
case "$out" in
*"Smoke rolled 1d6"*) step "ssh relayed '/roll 1d6' -> $out" ;;
*) fail "ssh through the relay printed '$out', not 'Smoke rolled 1d6'" ;;
esac

kill -TERM "$host_pid"
status=0
wait "$host_pid" || status=$?
host_pid=""
[ "$status" -eq 0 ] || fail "the relayed host exited $status on SIGTERM"
kill -TERM "$relay_pid"
status=0
wait "$relay_pid" || status=$?
relay_pid=""
[ "$status" -eq 0 ] || fail "the relay exited $status on SIGTERM"
step "the host and the relay stopped cleanly on SIGTERM"
step "ok"
