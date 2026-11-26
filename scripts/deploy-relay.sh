set -euo pipefail

fail() {
  echo "deploy-relay: FAIL: $*" >&2
  exit 1
}

case "$(uname -m)" in
  x86_64 | amd64) binary="supervillain-linux-x64" ;;
  aarch64 | arm64) binary="supervillain-linux-arm64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  dest="/usr/local/bin/supervillain"
  service="supervillain-relay"
  restart_service() { systemctl restart "$service"; }
  service_active() { systemctl is-active --quiet "$service"; }
  dump_logs() { journalctl -u "$service" -n 20 --no-pager >&2 || true; }
  settle_delay=1
else
  [ -n "${DEPLOY_TEST_DEST:-}" ] || fail "must run as root"
  dest="$DEPLOY_TEST_DEST"
  restart_service() {
    [ -z "${DEPLOY_TEST_RESTART:-}" ] || bash "$DEPLOY_TEST_RESTART" "$dest"
  }
  service_active() {
    [ -z "${DEPLOY_TEST_CHECK:-}" ] || bash "$DEPLOY_TEST_CHECK" "$dest"
  }
  dump_logs() { true; }
  settle_delay="${DEPLOY_TEST_DELAY:-0}"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/supervillain-deploy.XXXXXX")"
chmod 700 "$work"
dest_dir="$(dirname "$dest")"
staged="$dest_dir/.supervillain.new.$$"

cleanup() {
  rm -f "$staged" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -m 700 "$work/stage"
tar -C "$work/stage" --no-same-owner --no-same-permissions -xf - || fail "invalid tar archive on stdin"

count="$(find "$work/stage" -mindepth 1 | wc -l | tr -d ' ')"
[ "$count" -eq 3 ] || fail "expected 3 files in archive, got $count"

for name in RELEASE SHA256SUMS "$binary"; do
  path="$work/stage/$name"
  [ -f "$path" ] && [ ! -L "$path" ] || fail "missing regular file: $name"
done

tag="$(tr -d '\r\n' < "$work/stage/RELEASE")"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  fail "invalid release tag: $tag"
fi

grep -Eq "^[0-9a-f]{64}  ${binary}$" "$work/stage/SHA256SUMS" || fail "$binary missing from SHA256SUMS"
(cd "$work/stage" && sha256sum --ignore-missing -c SHA256SUMS >/dev/null) || fail "checksum verification failed"

chmod 0755 "$work/stage/$binary"
got="$("$work/stage/$binary" --version 2>&1 || true)"
[ "$got" = "supervillain $tag" ] || fail "expected 'supervillain $tag', got '$got'"

had_prev=0
if [ -f "$dest" ] && [ ! -L "$dest" ]; then
  cp -p "$dest" "$work/previous"
  had_prev=1
fi

rollback() {
  if [ "$had_prev" -eq 1 ]; then
    echo "deploy-relay: rolling back to previous binary" >&2
    install -m 0755 "$work/previous" "$staged" && mv -f "$staged" "$dest" || true
    restart_service || true
  fi
  dump_logs
}

install -m 0755 "$work/stage/$binary" "$staged"
mv -f "$staged" "$dest"

if ! restart_service; then
  rollback
  fail "service restart failed"
fi

if [ "$settle_delay" != "0" ]; then
  sleep "$settle_delay"
fi

ready=0
for _ in 1 2 3 4 5; do
  if service_active; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  rollback
  fail "service did not stay active after restart"
fi

echo "deploy-relay: deployed $got"
