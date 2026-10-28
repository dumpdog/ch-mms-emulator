# Roon support

A slot can be driven by a Roon zone, or a BluOS slot can get a "Roon" entry on its Home Menu. Nothing changes for slots that don't use Roon:
the Roon packages are only loaded when a slot asks for them.

**Status: new and tested only against a mock Roon, not yet against a real Roon Core.** See "Testing on your own system" and "Not verified yet".

## How it works

The emulator is a Roon *extension*. It finds your Roon Core on the network (or connects to `MMS_ROON_HOST`), pairs, and shows up in
Roon under **Settings > Extensions** as "MMS Emulator". You enable it there once; the pairing is kept in `roon-state.json`.

- **Roon zone slot** (`--slot C=roon:"Living Room"`): the slot follows that Roon zone. Now playing, progress, play/pause/stop/next/previous,
  seek, fast-forward/rewind, shuffle and repeat all go through Roon. The Home Menu is Roon's own top level plus a Search entry. Selecting a
  track, album or playlist plays it now in that zone; press-and-hold shows Roon's other actions (Add Next, Queue, ...). The Up Next button
  shows the zone's queue.
- **BluOS + Roon in one slot** (`--roon-zone B="Living Room"` on a BluOS slot): the Home Menu is the BluOS home with **Roon** as its first entry.
  Now playing and the buttons follow whichever side is active: Roon while its zone is playing (or paused while BluOS is idle), BluOS otherwise.
  While Roon streams to the player the player's own status says little, and a BluOS command could upset the Roon session, so Roon gets the controls then.
- **Search.** Crestron Home has no text entry, so Home Menu > Search offers Artists / Albums / Tracks by letter. Crestron Custom (Smart Graphics)
  panels get free-text Find. Find needs the Crestron Custom branch; the letter search works on every panel.

A Roon zone is matched by name (the zone's name, or the name of one of its outputs), so a BluOS player that appears in Roon is simply a zone.

## Setting it up

```
./install.sh --slot C=roon:"Living Room"        # a slot driven by a Roon zone
./install.sh --roon-zone B="Living Room"        # add Home Menu > Roon to the BluOS slot B (--roon-zone B= removes it)
```

The installer runs `npm install` (the packages come from GitHub, so the Pi needs internet and `git`) and then asks you to enable the
extension in Roon. Until you do, a Roon menu says "Waiting for Roon". Optional settings in `.env`:

| Variable | Meaning |
|---|---|
| `MMS_<SLOT>_TYPE=roon`, `MMS_<SLOT>_URL=<zone name>` | A slot driven by a Roon zone |
| `MMS_<SLOT>_ROON_ZONE=<zone name>` | On a BluOS slot: also browse and play that Roon zone |
| `MMS_ROON_HOST=<host[:port]>` | Connect straight to a Core (default port 9330) instead of discovering one. Discovery needs the Pi and the Core on the same subnet |
| `MMS_ROON_STATE=<file>` | Where the pairing is kept (default `./roon-state.json`) |

## Testing on your own system

Test it next to the working install, never over it. The service points at whichever folder `install.sh` was run from, so switching
back and forth is one command.

```
cd ~
git clone -b roon https://github.com/dumpdog/ch-mms-emulator.git mms-emulator-roon
cp mms-emulator/.env mms-emulator/state.json mms-emulator-roon/      # your current settings and the processor link
cd mms-emulator-roon
./install.sh --slot C=roon:"<a zone name as shown in Roon>"         # or: ./install.sh --roon-zone B="<zone>"
```

Then in Roon: **Settings > Extensions > MMS Emulator > Enable**. Watch it connect:

```
sudo journalctl -u mms-emulator -f | grep -i roon        # expect: roon: paired with Core "..."
```

Things to try on the panel: browse Library > Artists > an artist > an album; play a track and an album; now-playing text, artwork and
progress; pause, next, previous, seek, shuffle, repeat; the Up Next button; Search > Artists by letter (and Find on a Custom panel);
and, on a BluOS + Roon slot, playing from BluOS and from Roon and watching the buttons follow.

## Rolling back

Go back to the version that was working before Roon (it is also tagged `pre-roon` in git):

```
cd ~/mms-emulator && ./install.sh --yes        # the old folder: re-points the service at it and restarts
```

or, if you keep one clone: `git checkout pre-roon && ./install.sh --yes` (use `git checkout main` to come back to the branch). Your
`.env` and `state.json` stay in each folder, so neither one touches the other's settings. To remove only the Roon bits from a slot,
run `./install.sh --slot C=none` or `./install.sh --roon-zone B=`.

## Not verified yet (no Roon Core was available while this was written)

- The shape of Roon's browse tree: that the top level has a **Library** with **Artists**, **Albums** and **Tracks** in it, and which `hint` values
  each item carries. If Library is missing, Search by letter says so; free-text Find and normal browsing do not depend on it.
- The default port 9330 for `MMS_ROON_HOST` (discovery needs no port).
- Search by letter finds where a letter starts by bisection and assumes Roon sorts titles by their first letter. If Roon sorts "The Beatles" under B,
  those rows can land under T.
- Artwork is requested at 500x500; that size and the Crestron panels' own scaling have not been checked.
- The Favorites button is not mapped for Roon (the Up Next button is).
- The Crestron Custom branch (`mms-emulator-custom`) has not been merged with this; the Find hook there calls `backend.search`, which the Roon backend provides.
