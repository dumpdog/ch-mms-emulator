# MMS Emulator for Crestron Home and Crestron Custom

Emulates an MMS (model 5A: Main, Player A-D, USB) so Crestron Home can browse and control music through its
normal media-player menus. Each slot is driven by a Plexamp/Caldera player (your Plex library), a BluOS player, a WiiM player or a Roon zone (see [docs/ROON.md](docs/ROON.md)).

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
   BluOS (`backend-bluos.js`, via the BluOS HTTP API) or WiiM (`backend-wiim.js`, via the WiiM HTTP API) or Roon (`backend-roon.js`, as a Roon extension). Unconfigured slots show "Not configured".

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
- For Roon slots: a Roon Core on the same network, the zone name, and the extension enabled once in Roon (`npm` and `git` are installed for it). See [docs/ROON.md](docs/ROON.md).
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
| `MMS_<SLOT>_TYPE` | `plexamp`, `bluos`, `wiim` or `roon` |
| `MMS_<SLOT>_URL` | Player address (Plexamp default port 32500, BluOS 11000, WiiM tries HTTPS then HTTP, Roon is the zone name) |
| `MMS_<SLOT>_ROON_ZONE` | On a BluOS slot: also browse and play this Roon zone (Home Menu > Roon) |
| `MMS_ROON_HOST`, `MMS_ROON_STATE` | Connect to a given Roon Core instead of discovering one; where the pairing is kept |
| `PLEX_URL`, `PLEX_TOKEN` | Plex server and token (when any slot is Plexamp) |
| `MMS_PROVIDER_LABEL` | Optional visible text after the output label on Crestron's Services screen (default: nothing) |
| `MMS_SYSTEM`, `MMS_MASTER`, `MMS_<SLOT>_MASTER` | `custom` for a Crestron Custom (SIMPL) program, and the processor `IP[:port]@IP-ID` each slot reports to (see below) |
| `MMS_HOSTNAME` | Name the processor resolves (default: system host name) |
| `MMS_MODEL` | `5A` (default) or `3E` |
| `MMS_HTTP_PORT` | Artwork port (default 80) |
| `MMS_STATE_FILE` | Saved processor registration (default `./state.json`) |
| `MMS_ADVERTISE_IP` | Override the advertised IP |
| `MMS_DEMO=1` | Fake library on unconfigured slots |

## Crestron Custom (SIMPL / Studio)

Run `./install.sh` and choose system 2, or set `MMS_SYSTEM=custom` in .env. There is no discovery or console: the emulator dials each processor's CIP port (41794)
and registers as the IP-ID of your program's Autonomic MMS-5A symbol (the one from Autonomic's sample program: MMS symbol + Ethernet Offline Manager + one
Media Object Router per touch panel).

    MMS_SYSTEM=custom
    MMS_MASTER=192.168.4.5@0A          # processor IP[:port]@IP-ID (hex), default for every slot
    MMS_B_MASTER=192.168.4.6@0B        # optional per-slot override (MAIN, A, B, C, D, USB)

Slots with the same processor and IP-ID share one connection (one symbol); different pairs get their own. The join layout matches Crestron Home
(CRPC 1-6, Config 11+n, DirectConnectInfo 40+n); override with MMS_CONFIG_BASE / MMS_DIRECT_BASE if your program differs. Touch panels use Smart Graphics
(chunked CRPC, extra menu properties, a ListChanged event); the emulator detects them from their Crpc.Register name. In SIMPL, run Project > GUI Extender
Management > Select All > Sync > Commit or the panel Media Player area spins forever. MMS_CIP_TRACE=1 logs raw CIP and CRPC traffic.

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

## TODO / to investigate
- FF / rewind: Crestron Home sends ONE `Ffwd` call per tap or hold (no release, no repeat); `Rewind` is only sent when `Rewind` is in `ActionsAvailable`. Implemented as a skip that grows on repeated presses in the same direction within 2 s: 15, 20, 25, 30 s (see SKIP_STEPS in backend-plex.js). A true scan mode (FfwdSpeed/RewindSpeed, joins 104/105) was not attempted; revisit only if wanted.
- ThumbsUp / ThumbsDown: CONFIRMED working. Crestron Home only enables a button (and only sends `MirageMediaPlayerN.ThumbsUp|ThumbsDown`) when the action is in `ActionsAvailable`, not just `ActionsSupported`. The `Rating` read-back encoding ({current:1|-1,max:1,system:1}) is a guess that the user says gives visible feedback. Star not tried.
- After an emulator restart the processor re-registers each slot for ~90 s (several `Crpc.Register` rounds) before settling; harmless.
- Now-playing text lines (join 131-134 + 100n) vs the 'Mirage' / artist / 'Player A My Music' layout in the app.

## Confirmed behaviours (live, Crestron Home + Plexamp)
- `RepeatState`: 0 off, 1 repeat one, 2 repeat all (same as Plex). Each press cycles off -> one -> all.
- `ShuffleState` 0/1; Plexamp only keeps a shuffle change while a queue is playing.
- Thumbs: only sent when ThumbsUp/ThumbsDown are in `ActionsAvailable`; stored as Plex userRating 10 / 2; pressing the active one again clears it (`rating=-1`).
