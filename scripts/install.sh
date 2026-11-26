main() {
  set -eu

  repo="${SUPERVILLAIN_REPO:-oscabriel/supervillain}"
  bin_dir="${SUPERVILLAIN_BIN:-$HOME/.local/bin}"
  base="https://github.com/$repo/releases/latest/download"

  say() {
    printf 'supervillain install: %s\n' "$*"
  }

  fail() {
    printf 'supervillain install: %s\n' "$*" >&2
    exit 1
  }

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "this installer knows Linux and macOS, not $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "there's no supervillain build for $(uname -m)" ;;
  esac

  binary="supervillain-$os-$arch"

  command -v curl >/dev/null 2>&1 || fail "it needs curl to download the release"

  if command -v sha256sum >/dev/null 2>&1; then
    digest() {
      sha256sum "$1" | cut -d ' ' -f 1
    }
  elif command -v shasum >/dev/null 2>&1; then
    digest() {
      shasum -a 256 "$1" | cut -d ' ' -f 1
    }
  else
    fail "it needs sha256sum or shasum to check the download; install one and run it again"
  fi

  work="$(mktemp -d 2>/dev/null || mktemp -d -t supervillain)"
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT TERM

  say "downloading $binary from $base"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$work/$binary" "$base/$binary" || fail "can't download $base/$binary"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "can't download $base/SHA256SUMS"

  want="$(awk -v name="$binary" '$2 == name || $2 == "*" name { print $1; exit }' "$work/SHA256SUMS")"
  [ -n "$want" ] || fail "SHA256SUMS lists no $binary, so it can't be checked"

  got="$(digest "$work/$binary")"
  [ "$got" = "$want" ] || fail "the download doesn't match SHA256SUMS (want $want, got $got); nothing installed"

  mkdir -p "$bin_dir"
  chmod 0755 "$work/$binary"
  cp "$work/$binary" "$bin_dir/.supervillain.new"
  chmod 0755 "$bin_dir/.supervillain.new"
  mv -f "$bin_dir/.supervillain.new" "$bin_dir/supervillain"
  say "installed $bin_dir/supervillain"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) say "$bin_dir isn't on your PATH; add it with: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac

  say "next, run: supervillain"
}

main "$@"
