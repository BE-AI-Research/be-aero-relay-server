# BE-Aero Relay Server

Keeps your [BE-Aero Desktop](https://github.com/BE-AI-Research/be-aero-desktop) devices in touch
when they are not online at the same time. Run it on any always-on machine: a home server, a
NAS, a Raspberry Pi-class box or a cloud VM.

- **Store and forward.** When one of your devices is offline, the others leave its messages on the
  relay, and the device collects them when it next connects:
  - state changes: theme, notes, pinned apps, conversations, tasks
  - AI requests, tasks and late answers
  - clipboard and web-widget sends
- **Shared storage.** A folder all your devices can open in the BE-Aero file browser, even when
  the others are off.
- **File Pool copy.** A copy of your File Pool, kept current by whichever device is online.
- **End-to-end encrypted.** Messages are sealed for the one device they are meant for. Files and
  their names are encrypted on your devices with a key only your devices share. The relay
  cannot read any of it: it sees who sent an item, to whom, its kind, size and time.
- **Pinned and paired.** Devices pair with a 6-digit code, like BE-Aero devices pair with each
  other. Connections are TLS 1.3, and both sides are pinned by device ID.

## Install

### Linux (x86-64, systemd)

One line. It installs a single executable, so nothing else is needed:

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-relay-server/releases/latest/download/install.sh | sudo bash
```

This sets up a `be-aero-relay` service that starts at boot, with its data in
`/var/lib/be-aero-relay`. Run the same line again to update. To remove it:
`sudo bash /opt/be-aero-relay/install-linux.sh --uninstall`. The data is kept, so pairings
survive a reinstall.

### Windows

1. Download `be-aero-relay-windows-x64.zip` from the
   [latest release](https://github.com/BE-AI-Research/be-aero-relay-server/releases/latest)
   and unzip it.
2. To try it, double-click `be-aero-relay.exe`. It runs in a console window.
3. To install it as a background task that starts at boot, open an **elevated** PowerShell in
   that folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File install-windows.ps1
   ```

   That also opens TCP port 41811 in Windows Firewall. Add `-Uninstall` to remove it.

### Docker or Node.js

The `be-aero-relay-<version>-node.tar.gz` release (or this repository) runs with Node.js 18 or
newer:

```bash
node relay.js
```

With Docker:

```bash
docker build -t be-aero-relay .
docker run -d --name be-aero-relay --restart unless-stopped -p 41811:41811 -v be-aero-relay:/data be-aero-relay
```

## Pair your devices

On the relay machine:

```bash
sudo be-aero-relay pair          # Linux service
be-aero-relay.exe pair           # Windows (or: node relay.js pair)
docker exec be-aero-relay node relay.js pair
```

That prints the relay's addresses, its port and a 6-digit code (valid for 5 minutes). Then, on
each device:
1. Open BE-Aero > **Settings > Devices**.
2. Choose **Pair by address**.
3. Enter `address:41811`, then the code.
4. Check that the ID shown matches, and confirm.

The relay then appears under Devices as **Relay Server**, and in the file browser with its
Shared storage and File Pool copy.

```bash
sudo be-aero-relay status        # paired devices, online or not, and what waits for each
```

## Control panel

```bash
sudo be-aero-relay panel         # Linux service
be-aero-relay.exe panel          # Windows (elevated, with RELAY_DATA set by the installer)
```

A full-screen panel in the terminal, with four tabs:
- **Health** (live): uptime, CPU, memory, disk, storage, traffic in and out, and uploads in
  progress.
- **Devices:** online or last seen, and what waits for each. Press `u` to unpair one.
- **Settings:** the name, port, storage cap, message lifetime and LAN announcements. Changes are
  saved at once; a restart (`r`) applies the ones that need it.
- **Log:** the relay's recent log.

`p` opens pairing and `q` quits; the relay keeps running.

The panel, `pair` and `status` talk to the running relay over a local admin port (41813, this
machine only), using a token kept in the relay's data folder (`admin.token`). Only the relay's own
user and administrators can use them.

## Settings

Settings are kept in `config.json` in the data folder; change them in the panel. Environment
variables win over the file:

| Variable | Default | |
|---|---|---|
| `RELAY_DATA` | `~/.be-aero-relay` (service: `/var/lib/be-aero-relay`) | Identity, paired devices, mailbox, storage |
| `RELAY_PORT` | `41811` | The port devices connect to (TCP) |
| `RELAY_ADMIN_PORT` | `41813` | `pair` and `status`; listens on this machine only |
| `RELAY_MAX_GB` | `2` | Storage cap for waiting messages and stored files together |
| `RELAY_TTL_DAYS` | `30` | Messages not collected by then are deleted |
| `RELAY_NAME` | `BE-Aero Relay Server (<host>)` | The name your devices see |
| `RELAY_DISCOVERY` | `1` | Announce on the local network, so devices follow an address change |

To reach the relay from outside your home network, forward `RELAY_PORT` (TCP) to it, or put the
relay and your devices on the same VPN.

## How it works

- **Identity:** the relay has a device identity (a P-256 key and a self-signed certificate). Its
  device ID comes from that certificate, the same way BE-Aero's do.
- **Messages:** each item is sealed for its recipient with an ephemeral ECDH P-256 key and the
  recipient's device key, then HKDF-SHA256 and AES-256-GCM. The sender signs it. The relay stores
  the envelope and hands it only to the recipient, which acknowledges it. A newer state item
  replaces the waiting one.
- **Storage:** files are encrypted in 1 MB AES-256-GCM chunks on the device. Names, sizes and
  checksums travel in sealed metadata. The relay keeps opaque objects, with one index for a fast
  start.
- **Large transfers:** uploads resume where they stopped, even after a relay restart. Devices fetch
  only what changed since their last look. A few files move at a time.
- **Conflicts:** every upload names the version it replaces. If another device changed the file
  meanwhile, the relay says so instead of overwriting it. Identical content is dropped, the File
  Pool copy keeps the newer file, and Shared storage keeps a "(conflict *device* *date*)" copy.
- **No permissions:** a relay gets none of a device's permissions. It cannot browse files, use
  the assistant or change settings on your devices.

## Building

```bash
node scripts/build.js
```

This writes `dist/`: the Windows and Linux single executables (Node.js single executable
applications, using the Node version that runs the build), the Node.js sources and
`install.sh`. Build on Windows.

## License

[AGPL-3.0](LICENSE)
