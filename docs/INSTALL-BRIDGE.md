# Installing the MMS emulator on a Raspberry Pi (processor bridge)

This replaces one Roon zone in a SIMPL program with a Plexamp player. A SIMPL+ module on the processor (`processor/PlexampZone.usp`) connects to
this Pi, which serves the Plexamp library to the panels.

## What you need
- A Raspberry Pi with Raspberry Pi OS, internet access, and a user that can use `sudo`.
- Your Plex server address and a Plex token (https://support.plex.tv/articles/204059436).
- The address of the Plexamp player to control (default port 32500).
- The Pi's own IP address (for example 192.168.5.23). It must match `PLEX_HOST` in `PlexampZone.usp` in the SIMPL program.

## 1. Get the files onto the Pi

**With git:**
```
sudo apt update && sudo apt install -y git
git clone -b crestron-custom-bridge https://github.com/dumpdog/ch-mms-emulator.git mms-emulator
cd mms-emulator
```

**Without git (from the zip):** copy `mms-emulator-bridge-install.zip` to the Pi (USB stick, or from Windows:
`scp mms-emulator-bridge-install.zip pi@<pi-ip>:~`), then on the Pi:
```
sudo apt update && sudo apt install -y unzip
unzip mms-emulator-bridge-install.zip
cd mms-emulator
chmod +x install.sh
```

## 2. Run the installer
Interactive (asks questions):
```
./install.sh --system bridge
```
Answer: model **5A**; Player A = **Plexamp** with that player's address; your Plex URL and token; leave the other slots as none.

Or in one line, with your own values:
```
PLEX_TOKEN=<your token> ./install.sh --yes --system bridge --plex-url http://<plex-ip>:32400 --slot A=plexamp:http://<plexamp-ip>:32500
```
The installer installs Node.js if missing, writes `.env`, installs a systemd service called `mms-emulator` and starts it.

## 3. Check it is running
```
./install.sh --status
ss -ltn | grep -E ':(41811|41799|80)\b'
```
You should see the service running and these ports listening:

| Port | Used by |
|---|---|
| tcp 41811 | the SIMPL+ module on the processor (Player A; 41810 + slot number: Main 0, A 1, B 2, C 3, D 4, USB 5) |
| tcp 41799 | panels connecting directly (Player A; 41798 + slot number) |
| tcp 80 | album artwork |

The processor and the panels must be able to reach all three from their network.

## 4. Connect the processor
Load the SIMPL program (the `.lpz`) onto the processor. Then watch the Pi:
```
sudo journalctl -u mms-emulator -f
```
The line `bridge[Player A]: module connected from <processor address>` means the processor reached the Pi.
On a panel, the replaced zone should show Plexamp's Home Menu (Playlists, Albums, Artists ...).

## Troubleshooting
- No "module connected" line: the processor cannot reach the Pi on tcp 41811, or `PLEX_HOST`/`PLEX_PORT` in `PlexampZone.usp` is wrong (recompile and resend the program after editing).
- Connected, but the panel stays on "No communication": check the processor's program slot IP table has the panel's IP-ID, and that no other slot has the same IP-ID.
- Menu is empty or shows "Not configured": check `.env` (Plex URL/token, `MMS_A_TYPE=plexamp`, `MMS_A_URL`) and `sudo journalctl -u mms-emulator -n 50`.
- Add `MMS_CIP_TRACE=1` to `.env` and run `sudo systemctl restart mms-emulator` for detailed logs; remove it afterwards.

## Updating and removing
- Update: replace the files (or `git pull`), then `./install.sh --yes` (it re-uses the saved answers).
- Remove: `./install.sh --uninstall`.
