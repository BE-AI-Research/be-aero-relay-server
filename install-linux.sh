#!/usr/bin/env bash
# BE-Aero Relay Server: install (or update) as a systemd service.
#   sudo bash install-linux.sh              install / update
#   sudo bash install-linux.sh --uninstall  remove (keeps its data)
# Uses the bundled executable (be-aero-relay) when it is next to this
# script - nothing else needed - or relay.js with Node.js 18+.
set -euo pipefail
DIR=/opt/be-aero-relay
USER_NAME=be-aero-relay
DATA=/var/lib/be-aero-relay
UNIT=/etc/systemd/system/be-aero-relay.service
LINK=/usr/local/bin/be-aero-relay
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now be-aero-relay 2>/dev/null || true
  rm -f "$UNIT" "$LINK"; systemctl daemon-reload
  rm -rf "$DIR"
  echo "Removed. Its data is still in $DATA (delete it to forget the paired devices)."
  exit 0
fi

if [ -x "$HERE/be-aero-relay" ]; then
  EXEC="$DIR/be-aero-relay"
else
  NODE="$(command -v node || true)"
  if [ -z "$NODE" ]; then echo "Node.js 18+ is needed for relay.js (or use the release with the be-aero-relay executable)" >&2; exit 1; fi
  MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
  if [ "$MAJOR" -lt 18 ]; then echo "Node.js 18+ is needed (found $("$NODE" -v))" >&2; exit 1; fi
  EXEC="$NODE $DIR/relay.js"
fi

id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DIR" "$DATA"
# An update: stop the running copy before replacing its files.
systemctl stop be-aero-relay 2>/dev/null || true
cp -r "$HERE"/. "$DIR"/
chown -R root:root "$DIR"
chown -R "$USER_NAME": "$DATA"
chmod 700 "$DATA"

# "be-aero-relay pair" / "status" from any shell, as the service's user and data.
cat > "$LINK" <<WRAP
#!/bin/sh
exec sudo -u $USER_NAME RELAY_DATA=$DATA $EXEC "\$@"
WRAP
chmod 755 "$LINK"

cat > "$UNIT" <<UNIT
[Unit]
Description=BE-Aero Relay Server
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
Environment=RELAY_DATA=$DATA
ExecStart=$EXEC
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable be-aero-relay >/dev/null 2>&1
systemctl restart be-aero-relay      # an update must run the new code
sleep 1
systemctl --no-pager --lines=3 status be-aero-relay || true
echo
echo "Installed and running (port 41811). Pair your devices with:"
echo "    sudo be-aero-relay pair"
