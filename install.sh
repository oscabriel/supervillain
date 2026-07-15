#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/oscabriel/supervillain/main/install.sh | sh
set -eu

system=$(uname -s)
machine=$(uname -m)
case "$system:$machine" in
	Linux:x86_64)
		triple=linux-x64
		;;
	Linux:aarch64 | Linux:arm64)
		triple=linux-arm64
		;;
	Darwin:arm64)
		triple=macos-arm64
		;;
	Darwin:x86_64)
		echo "no darwin-x64 iroh artifact; Intel Macs: use a Linux VM." >&2
		exit 1
		;;
	*)
		echo "unsupported platform: $system $machine. Windows GMs: use WSL2." >&2
		exit 1
		;;
esac

base_url=${SUPERVILLAIN_BASE_URL:-https://github.com/oscabriel/supervillain/releases}
if [ -n "${SUPERVILLAIN_VERSION:-}" ]; then
	download_url=$base_url/download/$SUPERVILLAIN_VERSION
else
	download_url=$base_url/latest/download
fi

archive=supervillain-$triple.tar.gz
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/supervillain-install.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

curl -fsSL "$download_url/$archive" -o "$temporary_directory/$archive"
curl -fsSL "$download_url/SHA256SUMS" -o "$temporary_directory/SHA256SUMS"
grep "  $archive\$" "$temporary_directory/SHA256SUMS" >"$temporary_directory/SHA256SUM"
(
	cd "$temporary_directory"
	if [ "$system" = Darwin ]; then
		shasum -a 256 -c SHA256SUM
	else
		sha256sum -c SHA256SUM
	fi
)

tar -xzf "$temporary_directory/$archive" -C "$temporary_directory" supervillain
install_directory=${SUPERVILLAIN_INSTALL_DIR:-$HOME/.local/bin}
mkdir -p "$install_directory"
install -m 755 "$temporary_directory/supervillain" "$install_directory/supervillain"

echo "installed $install_directory/supervillain"
case ":${PATH:-}:" in
	*":$install_directory:"*) ;;
	*) echo "add $install_directory to your PATH." ;;
esac
