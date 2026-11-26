main() {
  set -eu

  repo="${SUPERVILLAIN_REPO:-oscabriel/supervillain}"
  bin_dir="${SUPERVILLAIN_BIN:-$HOME/.local/bin}"
  base="https://github.com/$repo/releases/latest/download"

  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    c_brand="$(printf '\033[1;38;2;224;108;117m')"
    c_ok="$(printf '\033[1;38;2;152;195;121m')"
    c_err="$(printf '\033[1;38;2;224;108;117m')"
    c_bold="$(printf '\033[1m')"
    c_dim="$(printf '\033[2m')"
    c_reset="$(printf '\033[0m')"
    tty_out=1
  else
    c_brand=""
    c_ok=""
    c_err=""
    c_bold=""
    c_dim=""
    c_reset=""
    tty_out=0
  fi

  step() {
    printf '  %s[%s/3]%s %s\n' "$c_dim" "$1" "$c_reset" "$2"
  }

  ok() {
    printf '  %s✓%s %s\n' "$c_ok" "$c_reset" "$1"
  }

  note() {
    printf '  %s%s%s\n' "$c_dim" "$1" "$c_reset"
  }

  fail() {
    printf '%ssupervillain install:%s %s\n' "$c_err" "$c_reset" "$*" >&2
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

  staged="$bin_dir/.supervillain.new.$$"
  work="$(mktemp -d 2>/dev/null || mktemp -d -t supervillain)"
  trap 'rm -rf "$work"; rm -f "$staged"' EXIT
  trap 'exit 130' INT TERM

  printf '%s◆ supervillain%s %s· installer%s\n' "$c_brand" "$c_reset" "$c_dim" "$c_reset"
  printf '  %splatform%s  %s-%s\n' "$c_dim" "$c_reset" "$os" "$arch"
  printf '  %starget%s    %s/supervillain\n\n' "$c_dim" "$c_reset" "$bin_dir"

  step 1 "Downloading $binary..."
  if [ "$tty_out" = "1" ]; then
    curl --proto '=https' --tlsv1.2 -fL --progress-bar -o "$work/$binary" "$base/$binary" || fail "can't download $base/$binary"
  else
    curl --proto '=https' --tlsv1.2 -fsSL -o "$work/$binary" "$base/$binary" || fail "can't download $base/$binary"
  fi

  step 2 "Verifying SHA256SUMS..."
  curl --proto '=https' --tlsv1.2 -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "can't download $base/SHA256SUMS"

  want="$(awk -v name="$binary" '($2 == name || $2 == "*" name) && length($1) == 64 && $1 !~ /[^0-9a-fA-F]/ { print tolower($1); exit }' "$work/SHA256SUMS")"
  [ -n "$want" ] || fail "SHA256SUMS lists no $binary, so it can't be checked"

  got="$(digest "$work/$binary")"
  [ "$got" = "$want" ] || fail "the download doesn't match SHA256SUMS (want $want, got $got); nothing installed"
  ok "checksum verified ($(printf '%.12s' "$got")…)"

  step 3 "Installing binary..."
  mkdir -p "$bin_dir" || fail "can't create $bin_dir; nothing installed"
  cp "$work/$binary" "$staged" || fail "can't write to $bin_dir; nothing installed"
  chmod 0755 "$staged" || fail "can't make $staged executable; nothing installed"
  mv -f "$staged" "$bin_dir/supervillain" || fail "can't replace $bin_dir/supervillain; nothing installed"
  ok "installed $bin_dir/supervillain"

  printf '\n'
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) note "$bin_dir isn't on your PATH; add it with: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac

  printf '  %snext, run:%s %ssupervillain%s\n' "$c_dim" "$c_reset" "$c_bold" "$c_reset"
  note "update anytime: supervillain update"
}

main "$@"
