# MMS Emulator for Crestron Home

Emulates an MMS (model 5A: Main, Player A-D, USB) so Crestron Home can browse and control music through its
normal media-player menus. Each slot is driven by a Plexamp/Caldera player (your Plex library), a BluOS player or a WiiM player.

## How it works

1. **Discovery.** The emulator answers Crestron autodiscovery (UDP 41794), so it shows up when Crestron Home scans
   "Ethernet and Wi-Fi" for an MMS.
2. **Registration.** Crestron Home adds the device through the emulator's console (TCP 5004, `addmaster <ipid> <host> <port>`).
   The emulator then dials out to the processor's CIP port and registers as the IP-ID Crestron Home picked. The processor
   address is saved in `state.json`.
3. **Browsing and control.** Per slot, the emulator publishes a CRPC JSON-RPC port (TCP 41798-41803). Crestron Home talks to it
   for the menu tree, now playing, transport, shuffle/repeat and thumbs.
4. **Artwork.** Served over HTTP (`/getart`, default port 80).
5. **Backends.** A slot maps to a backend: Plexamp/Caldera (`backend-plex.js`, via the Plex server and the Plexamp player) or
   BluOS (`backend-bluos.js`, via the BluOS HTTP API) or WiiM (`backend-wiim.js`, via the WiiM HTTP API). Unconfigured slots show "Not configured".

| Port | Protocol | Purpose |
|---|---|---|
| 41794 | UDP | Crestron autodiscovery reply |
| 5004 | TCP | MMS console used by the processor |
| 41798-41803 | TCP | Per-slot CRPC (Main, A, B, C, D, USB) |
| 80 (or `MMS_HTTP_PORT`) | TCP | Artwork |

Outbound: the CIP connection to the processor, the Plex server, Plexamp (default port 32500), BluOS (default port 11000) and WiiM (HTTPS, then HTTP).

## Requirements

- Crestron Home processor (tested on an MC4-R) on the same LAN/VLAN as the emulator.
- A Raspberry Pi (or any Debian-based Linux host) with a fixed or reserved IP address, `sudo`, and `git`.
- Node.js 18+ and `avahi-daemon`. The installer offers to apt-install them. Avahi lets the processor resolve the host name
  (`<hostname>.local`).
- For Plexamp slots: a Plex server, its address and a Plex token, and a Plexamp or Caldera player (reachable on its port, default 32500).
- For BluOS slots: the player's IP address (and the output number on multi-output players).
- For WiiM slots: the player's IP address.
- **A real MMS on the same network is fine** (tested alongside a real MMS 3E).

## Install

```
git clone https://github.com/dumpdog/ch-mms-emulator.git
cd ch-mms-emulator
./install.sh
```

Run it as your normal user, not root. The installer:

- installs missing packages
- asks for each slot: Plexamp/Caldera, BluOS (and which output), WiiM, or unused
- asks for the player address (and Plex server and token when any slot is Plexamp)
- checks that each player is reachable
- writes `.env`
- installs and starts the `mms-emulator` systemd service, enabled at boot

Then, in Crestron Home, add a media device, scan for the MMS and add it. Browse from a room's media source.

### Installer options

```
./install.sh --status                          show service state and settings
./install.sh --slot B=bluos:192.168.1.50#2     change one slot (#2 = BluOS output 2)
./install.sh --slot B=wiim:192.168.1.113       use a WiiM player for a slot
./install.sh --slot C=none                     disable a slot
./install.sh --dry-run                         show what it would do
./install.sh --yes --slot A=plexamp:192.168.1.105 --plex-url 192.168.1.22   non-interactive (PLEX_TOKEN in env or .env)
./install.sh --uninstall                       remove the service
```

Slot keys: `MAIN`, `A`, `B`, `C`, `D`, `USB`. Re-running keeps your saved answers as defaults.

**Update:** `git pull && ./install.sh --yes`

**Logs:** `sudo journalctl -u mms-emulator -f`

## Configuration (`.env`)

| Variable | Meaning |
|---|---|
| `MMS_<SLOT>_TYPE` | `plexamp`, `bluos` or `wiim` |
| `MMS_<SLOT>_URL` | Player address (Plexamp default port 32500, BluOS 11000, WiiM tries HTTPS then HTTP) |
| `PLEX_URL`, `PLEX_TOKEN` | Plex server and token (when any slot is Plexamp) |
| `MMS_PROVIDER_LABEL` | Optional visible text after the output label on Crestron's Services screen (default: nothing) |
| `MMS_HOSTNAME` | Name the processor resolves (default: system host name) |
| `MMS_MODEL` | `5A` (default) or `3E` |
| `MMS_HTTP_PORT` | Artwork port (default 80) |
| `MMS_STATE_FILE` | Saved processor registration (default `./state.json`) |
| `MMS_ADVERTISE_IP` | Override the advertised IP |
| `MMS_DEMO=1` | Fake library on unconfigured slots |

## Features

Browse the library (including a Plexamp "Search" that jumps by first letter: Home Menu > Search), play, pause, skip, seek, shuffle, repeat, thumbs up/down (Plexamp), fast-forward/rewind (as a growing skip),
now-playing artwork and metadata, and, on BluOS, add to queue and Up Next.

On a WiiM slot the player's presets are the browse list (Home Menu and Favorites), since the WiiM has no library API. Play, pause, skip, seek, shuffle and repeat work on the WiiM's own sources; radio streams have no seek, shuffle or repeat.

## Run without the installer / tests

```
MMS_HOSTNAME=<resolvable name> MMS_HTTP_PORT=8080 node index.js
npm test
```

The tests use a mock processor and need no hardware.
