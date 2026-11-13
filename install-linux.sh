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

UPD=/usr/local/sbin/be-aero-relay-update
UPD_UNIT=/etc/systemd/system/be-aero-relay-update.service
UPD_TIMER=/etc/systemd/system/be-aero-relay-update.timer

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now be-aero-relay be-aero-relay-update.timer 2>/dev/null || true
  rm -f "$UNIT" "$LINK" "$UPD" "$UPD_UNIT" "$UPD_TIMER"; systemctl daemon-reload
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

# Automatic updates: a daily timer runs this; it does nothing unless
# "auto-update" is on in the relay's settings (config.json), and installs
# only checksum-verified releases newer than the one running.
cat > "$UPD" <<UPDATE
#!/bin/sh
set -eu
CFG=$DATA/config.json
if [ "\${1:-}" != "--now" ] && ! grep -Eq '"autoUpdate"[[:space:]]*:[[:space:]]*true' "\$CFG" 2>/dev/null; then exit 0; fi
CUR="\$($EXEC --version 2>/dev/null || echo 0)"
API=https://api.github.com/repos/BE-AI-Research/be-aero-relay-server/releases/latest
if command -v curl >/dev/null; then J="\$(curl -fsSL -H 'User-Agent: be-aero-relay-update' "\$API")"; else J="\$(wget -qO- "\$API")"; fi
NEW="\$(printf '%s' "\$J" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' | head -1)"
[ -n "\$NEW" ] || { echo "could not read the latest release"; exit 1; }
if [ "\$NEW" = "\$CUR" ] || [ "\$(printf '%s\n%s\n' "\$CUR" "\$NEW" | sort -V | tail -1)" = "\$CUR" ]; then echo "up to date (\$CUR)"; exit 0; fi
echo "updating \$CUR -> \$NEW"
T="\$(mktemp -d)"; trap 'rm -rf "\$T"' EXIT
U=https://github.com/BE-AI-Research/be-aero-relay-server/releases/download/v\$NEW/install.sh
if command -v curl >/dev/null; then curl -fsSL "\$U" -o "\$T/install.sh"; else wget -qO "\$T/install.sh" "\$U"; fi
RELAY_VERSION="\$NEW" RELAY_REQUIRE_CHECKSUM=1 bash "\$T/install.sh"
UPDATE
chmod 755 "$UPD"
cat > "$UPD_UNIT" <<UNIT
[Unit]
Description=BE-Aero Relay Server update (when automatic updates are on)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$UPD
UNIT
cat > "$UPD_TIMER" <<UNIT
[Unit]
Description=Daily check for BE-Aero Relay Server updates

[Timer]
OnCalendar=daily
RandomizedDelaySec=4h
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable be-aero-relay >/dev/null 2>&1
systemctl enable --now be-aero-relay-update.timer >/dev/null 2>&1 || true
systemctl restart be-aero-relay      # an update must run the new code
sleep 1
systemctl --no-pager --lines=3 status be-aero-relay || true
echo

# Asked once, at setup: automatic updates. Never chosen = off. Without a
# terminal to ask on (a script, a pipe with no tty) it stays unset - off -
# unless RELAY_AUTO_UPDATE=on|off says.
AU="$(sudo -u "$USER_NAME" RELAY_DATA="$DATA" $EXEC auto-update 2>/dev/null || echo unset)"
if [ "$AU" = "unset" ]; then
  if [ -n "${RELAY_AUTO_UPDATE:-}" ]; then
    sudo -u "$USER_NAME" RELAY_DATA="$DATA" $EXEC auto-update "$RELAY_AUTO_UPDATE" >/dev/null && AU="$RELAY_AUTO_UPDATE"
  elif { exec 3</dev/tty; } 2>/dev/null; then
    printf 'Install BE-Aero Relay updates automatically (checked daily, checksum-verified)? [Y/n] ' >/dev/tty
    read -r ANSWER <&3 || ANSWER=""
    exec 3<&-
    case "$ANSWER" in [nN]*) AU=off ;; *) AU=on ;; esac
    sudo -u "$USER_NAME" RELAY_DATA="$DATA" $EXEC auto-update "$AU" >/dev/null
  fi
fi
case "$AU" in
  on|yes|true|1) echo "Automatic updates: on (sudo be-aero-relay auto-update off to stop them)" ;;
  off|no|false|0) echo "Automatic updates: off (sudo be-aero-relay auto-update on to turn them on)" ;;
  *) echo "Automatic updates: off - not chosen (sudo be-aero-relay auto-update on to turn them on)" ;;
esac
echo "Installed and running (port 41811). Pair your devices with:"
echo "    sudo be-aero-relay pair"
