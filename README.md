# mms-emulator

Emulates an Autonomic Mirage MMS (default model 5A, six player slots) so Crestron Home can browse a library through a real
menu tree. Protocol notes and decoded captures: `../mms-research/` (captures/ has the cap1/cap2 exchanges).

Status: Plexamp/Caldera backend live-tested; BluOS backend (`backend-bluos.js`, from API v1.7) tested against a mock only.

Install on a Pi (Raspberry Pi OS; needs git):
```
git clone https://github.com/dumpdog/mirage-mms-emulator.git && cd mirage-mms-emulator   # private repo: needs GitHub auth on the Pi
./install.sh
```
The installer asks per slot: Plexamp/Caldera, BluOS (and which output) or unused, then the address; it checks each, installs a systemd service and starts it.
Re-runnable; `--status`, `--slot B=bluos:192.168.1.50#2`, `--uninstall`. Update: `git pull && ./install.sh --yes` (re-uses your saved answers).
Settings live in `.env`: `MMS_<MAIN|A|B|C|D|USB>_TYPE=plexamp|bluos`, `MMS_<slot>_URL`, plus `PLEX_URL`/`PLEX_TOKEN` when any slot is Plexamp.

- UDP 41794: Crestron autodiscovery reply (so the "Ethernet and Wi-Fi" scan lists it)
- TCP 5004: MMS console (`getlicensemessage`, `ipt`, `addmaster <ipid> <host> <port>`), then we dial out to the processor's CIP port
- Outbound CIP client: registers as the IP-ID Crestron Home picked, publishes direct-connect ports (41798+n), config strings
- TCP 41798..41803: per-slot CRPC JSON-RPC (MirageMediaPlayerN / MirageMediaMenuN)
- HTTP (default :80): `/getart?guid=...` artwork

Run: `MMS_HOSTNAME=<resolvable name> node index.js` (port 80 needs root on Linux, or set `MMS_HTTP_PORT`).
Do not run it while the real MMS is on the network (same discovery/ports). The processor learns the master from the console,
persisted in `state.json`.
Test: `npm test` (mock processor replaying the captured sequence).

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

## TODO / to investigate
- FF / rewind: Crestron Home sends ONE `Ffwd` call per tap or hold (no release, no repeat); `Rewind` is only sent when `Rewind` is in `ActionsAvailable`. Implemented as a skip that grows on repeated presses in the same direction within 2 s: 15, 20, 25, 30 s (see SKIP_STEPS in backend-plex.js). A true scan mode (FfwdSpeed/RewindSpeed, joins 104/105) was not attempted; revisit only if wanted.
- ThumbsUp / ThumbsDown: CONFIRMED working. Crestron Home only enables a button (and only sends `MirageMediaPlayerN.ThumbsUp|ThumbsDown`) when the action is in `ActionsAvailable`, not just `ActionsSupported`. The `Rating` read-back encoding ({current:1|-1,max:1,system:1}) is a guess that the user says gives visible feedback. Star not tried.
- After an emulator restart the processor re-registers each slot for ~90 s (several `Crpc.Register` rounds) before settling; harmless.
- Now-playing text lines (join 131-134 + 100n) vs the 'Mirage' / artist / 'Player A My Music' layout in the app.

## Confirmed behaviours (live, Crestron Home + Plexamp)
- `RepeatState`: 0 off, 1 repeat one, 2 repeat all (same as Plex). Each press cycles off -> one -> all.
- `ShuffleState` 0/1; Plexamp only keeps a shuffle change while a queue is playing.
- Thumbs: only sent when ThumbsUp/ThumbsDown are in `ActionsAvailable`; stored as Plex userRating 10 / 2; pressing the active one again clears it (`rating=-1`).
