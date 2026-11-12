#!/usr/bin/env bash
# BE-Aero Relay Server - one-line install or update on Linux (x86-64, systemd):
#
#   curl -fsSL https://github.com/BE-AI-Research/be-aero-relay-server/releases/latest/download/install.sh | sudo bash
#
# Downloads the latest release (a single executable: nothing else to
# install), checks its SHA-256, and installs it as the be-aero-relay
# service. RELAY_VERSION=1.0.0 picks a specific release.
set -euo pipefail
REPO=BE-AI-Research/be-aero-relay-server

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo:  curl -fsSL <url> | sudo bash" >&2; exit 1; fi
case "$(uname -m)" in x86_64|amd64) ;; *) echo "only x86-64 Linux has a ready executable; on $(uname -m) use the Node.js release (see the README)" >&2; exit 1 ;; esac
command -v systemctl >/dev/null || { echo "systemd is needed" >&2; exit 1; }

if [ -n "${RELAY_VERSION:-}" ]; then
  BASE="https://github.com/$REPO/releases/download/v$RELAY_VERSION"; FILE="be-aero-relay-$RELAY_VERSION-linux-x64.tar.gz"
else
  BASE="https://github.com/$REPO/releases/latest/download"; FILE="be-aero-relay-linux-x64.tar.gz"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fetch() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
echo "Downloading the BE-Aero Relay Server..."
fetch "$BASE/$FILE" "$TMP/relay.tar.gz"
fetch "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt" || true
if [ -s "$TMP/SHA256SUMS.txt" ] && [ -z "${RELAY_VERSION:-}" ]; then
  # the stable name is a copy of the versioned file: check against that
  WANT="$(grep -E ' be-aero-relay-[0-9.]+-linux-x64\.tar\.gz$' "$TMP/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
elif [ -s "$TMP/SHA256SUMS.txt" ]; then
  WANT="$(grep " $FILE\$" "$TMP/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
fi
if [ -n "${WANT:-}" ]; then
  GOT="$(sha256sum "$TMP/relay.tar.gz" | awk '{print $1}')"
  [ "$GOT" = "$WANT" ] || { echo "checksum mismatch - not installing" >&2; exit 1; }
fi
mkdir "$TMP/x"
tar -xzf "$TMP/relay.tar.gz" -C "$TMP/x"
bash "$TMP/x/install-linux.sh"
