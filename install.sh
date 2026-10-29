#!/usr/bin/env bash
# Installer for the MMS emulator (Raspberry Pi OS / Debian). Crestron Home (or a Crestron Custom SIMPL program) sees an MMS; each of its
# player slots is driven by a Plexamp/Caldera player (your Plex library), a real BluOS player, a real WiiM player or a Roon zone.
#
#   ./install.sh
#
# Safe to re-run: it keeps your existing answers as defaults, so re-running also applies updates after copying new files.
#   ./install.sh [--dry-run] [--yes] [--model 5A|3E] [--slot KEY=plexamp:ADDR | KEY=bluos:ADDR[#N] | KEY=wiim:ADDR | KEY=roon:ZONE | KEY=none]...
#                [--roon-zone KEY=ZONE]... [--plex-url URL] [--hostname NAME] [--status] [--uninstall]
#                [--system home|custom] [--master IP[:PORT]@IPID] [--slot-master KEY=IP[:PORT]@IPID]...
# Roon: --slot B=roon:Living Room drives a slot from that Roon zone; --roon-zone B="Living Room" on a BluOS slot adds Home Menu > Roon to it.
# BluOS devices with several outputs: ADDR#N picks output N (port 11000 + 10*(N-1)), e.g. --slot B=bluos:192.168.1.50#2
# Slot keys: MAIN, A, B, C, D, USB  (5A: Main, Player A-D, USB;  3E: Main, Player A, Player B).
# Non-interactive: pass --yes with the --slot options (and PLEX_URL / PLEX_TOKEN in the environment or .env when any slot is plexamp).
# Crestron Custom (SIMPL / Studio program with an Autonomic MMS symbol): the processor is configured here instead of discovered.
# Give each used slot its processor's IP address and the hex IP-ID of its MMS symbol; slots may share one. --master sets all slots.
# Crestron Home: a real MMS on the same network is fine (tested alongside a real MMS 3E). Custom: the IP-ID must not be in use by a real MMS.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

DRY=0; YES=0; UNINSTALL=0; STATUS=0; MODEL_OPT=""; HOST_OPT=""; PLEXURL_OPT=""; SLOT_OPTS=(); ROON_OPTS=(); SYSTEM_OPT=""; MASTER_OPT=""; SMASTER_OPTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --model) shift; MODEL_OPT="${1:?--model needs 5A or 3E}" ;;
    --slot) shift; SLOT_OPTS+=("${1:?--slot needs KEY=plexamp:ADDR, KEY=bluos:ADDR, KEY=wiim:ADDR, KEY=roon:ZONE or KEY=none}") ;;
    --roon-zone) shift; ROON_OPTS+=("${1:?--roon-zone needs KEY=ZONE NAME}") ;;
    --plex-url) shift; PLEXURL_OPT="${1:?--plex-url needs an address}" ;;
    --hostname) shift; HOST_OPT="${1:?--hostname needs a name}" ;;
    --uninstall) UNINSTALL=1 ;;
    --status) STATUS=1 ;;
    --system) shift; SYSTEM_OPT="${1:?--system needs home or custom}" ;;
    --master) shift; MASTER_OPT="${1:?--master needs IP@IPID}" ;;
    --slot-master) shift; SMASTER_OPTS+=("${1:?--slot-master needs KEY=IP@IPID}") ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print } /^set -/ { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if (( DRY )); then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

[[ $EUID -ne 0 ]] || die "Run this as your normal user (not root); it uses sudo only where needed."
command -v sudo >/dev/null || die "sudo is required to install the systemd service."
RUN_USER="$(id -un)"
UNIT=mms-emulator

confirm() { # confirm "question" default(y|n)
  local def=${2:-n} ans
  (( YES )) && { [[ $def == y ]]; return; }
  printf '%s [%s] ' "$1" "$([[ $def == y ]] && echo Y/n || echo y/N)" >&2
  read -r ans || true; ans=${ans:-$def}; [[ $ans =~ ^[Yy] ]]
}
envget() { [[ -f .env ]] && { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; } || true; }
bluos_url() { # bluos_url "host[:port][#N]" -> URL; output N of a multi-output device listens on port 11000 + 10*(N-1)
  local v="${1//[[:space:]]/}" n=1
  if [[ $v == *'#'* ]]; then n="${v#*#}"; v="${v%%#*}"; fi
  [[ $n =~ ^[1-8]$ ]] || { warn "Output '$n' is not 1-8; using 1."; n=1; }
  v="${v#http://}"; v="${v%/}"
  [[ $v =~ :[0-9]+$ ]] || v="$v:$((11000 + 10 * (n - 1)))"
  printf 'http://%s' "$v"
}
wiim_url() { # wiim_url "host[:port]" -> the host as given; the emulator tries https, then http, itself
  local v="${1//[[:space:]]/}"; v="${v%/}"; printf '%s' "$v"
}
norm_url() { # norm_url "<host or url>" <default port>
  local v="${1//[[:space:]]/}"; v="${v%/}"
  [[ $v =~ ^https?:// ]] || v="http://$v"
  [[ $v =~ ^https?://[^/]+:[0-9]+ ]] || v="${v}:$2"
  printf '%s' "$v"
}

# ------------------------------------------------------------------ status / uninstall
SLOT_KEYS_5A=(MAIN A B C D USB); SLOT_KEYS_3E=(MAIN A B)
slot_label() { case $1 in MAIN) echo Main ;; USB) echo USB ;; *) echo "Player $1" ;; esac; }
if (( STATUS )); then
  printf '%-16s %s / %s\n' "$UNIT" "$(systemctl is-active $UNIT 2>/dev/null || true)" "$(systemctl is-enabled $UNIT 2>/dev/null || true)"
  printf 'Model %s, hostname %s, system %s\n' "$(envget MMS_MODEL)" "$(envget MMS_HOSTNAME)" "$([[ $(envget MMS_SYSTEM) == custom ]] && echo 'Crestron Custom' || echo 'Crestron Home')"
  for k in "${SLOT_KEYS_5A[@]}"; do
    t="$(envget "MMS_${k}_TYPE")"; [[ -n $t ]] || { t="$([[ -n $(envget "MMS_PLEXAMP_$k") ]] && echo plexamp || echo none)"; }
    printf '  %-9s %-8s %s%s
' "$(slot_label "$k")" "$t" "$(envget "MMS_${k}_URL")" "$([[ -n $(envget "MMS_${k}_MASTER") ]] && echo "  -> processor $(envget "MMS_${k}_MASTER")" || true)"
    z="$(envget "MMS_${k}_ROON_ZONE")"; [[ -z $z ]] || printf '  %-9s %-8s %s
' '' '+ roon' "$z"
  done
  exit 0
fi
if (( UNINSTALL )); then
  step "Uninstalling"
  confirm "Stop and remove the $UNIT service?" n || exit 0
  run sudo systemctl disable --now $UNIT 2>/dev/null || true
  run sudo rm -f /etc/systemd/system/$UNIT.service
  run sudo systemctl daemon-reload
  (( DRY )) || ok "Service removed."
  if confirm "Also delete the saved settings (.env with your Plex token) and state.json (the Crestron processor link)?" n; then
    run rm -f "$DIR/.env" "$DIR/state.json"; (( DRY )) || ok "Settings deleted."
  fi
  echo "The code in $DIR was left in place; delete the folder to remove it entirely."
  exit 0
fi

step "MMS emulator installer"
echo "Install folder: $DIR   (service runs as: $RUN_USER)"
echo "Press Enter to accept the value in [brackets]."

# ------------------------------------------------------------------ control system
SYSTEM="${SYSTEM_OPT:-$(envget MMS_SYSTEM)}"; SYSTEM="${SYSTEM:-home}"
if [[ -z $SYSTEM_OPT ]] && (( ! YES )); then
  step "Which control system will use this MMS?"
  echo "    1 = Crestron Home (the app finds the MMS by scanning and adds it)"
  echo "    2 = Crestron Custom (SIMPL / Studio program with an Autonomic MMS symbol)"
  echo "    3 = Control4 (not supported: it uses a different protocol)"
  d=1; [[ $SYSTEM == custom ]] && d=2
  while :; do
    printf '  Choose 1-3 [%s]: ' "$d" >&2; read -r a || true; a="${a:-$d}"
    case $a in 1|2) break ;; 3) die "Control4 is not supported by this emulator." ;; *) echo "    Please answer 1, 2 or 3." >&2 ;; esac
  done
  case $a in 1) SYSTEM=home ;; 2) SYSTEM=custom ;; esac
fi
case ${SYSTEM,,} in
  home|crestron-home) SYSTEM=home ;;
  custom|crestron-custom) SYSTEM=custom ;;
  control4|c4) die "Control4 is not supported by this emulator (it uses a different protocol)." ;;
  *) die "--system must be home or custom (got '$SYSTEM')." ;;
esac
ok "System: $([[ $SYSTEM == custom ]] && echo 'Crestron Custom' || echo 'Crestron Home')"

# ------------------------------------------------------------------ prerequisites
step "Checking prerequisites"
PKGS=()
command -v node >/dev/null || PKGS+=(nodejs)
command -v curl >/dev/null || PKGS+=(curl)
[[ $SYSTEM == custom ]] || [[ -x /usr/sbin/avahi-daemon ]] || command -v avahi-daemon >/dev/null || PKGS+=(avahi-daemon)   # Crestron Home resolves this Pi's name via mDNS; Custom dials by IP
if (( ${#PKGS[@]} )); then
  warn "Missing packages: ${PKGS[*]}"
  confirm "Install them with apt now?" y || die "Install ${PKGS[*]} and re-run."
  run sudo apt-get update -qq
  run sudo apt-get install -y -qq "${PKGS[@]}"
fi
if (( ! DRY )); then
  NODE_BIN="$(command -v node)"
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  (( NODE_MAJOR >= 18 )) || die "Node.js 18 or newer is required (found $("$NODE_BIN" -v)). See https://nodejs.org or use NodeSource."
  ok "Node $("$NODE_BIN" -v) (npm packages are only fetched for Roon)"
else NODE_BIN="$(command -v node || echo /usr/bin/node)"; ok "(dry-run) skipping version checks"; fi

# ------------------------------------------------------------------ model + name
MODEL="${MODEL_OPT:-$(envget MMS_MODEL)}"; MODEL="${MODEL:-5A}"; MODEL="${MODEL^^}"
if [[ -z $MODEL_OPT && -z $(envget MMS_MODEL) ]] && (( ! YES )); then
  printf 'Emulate which model? 5A = Main + Player A-D + USB (6 players), 3E = Main + Player A + Player B [5A]: ' >&2; read -r a || true; MODEL="${a:-5A}"; MODEL="${MODEL^^}"
fi
case $MODEL in 5A) SLOT_KEYS=("${SLOT_KEYS_5A[@]}") ;; 3E) SLOT_KEYS=("${SLOT_KEYS_3E[@]}") ;; *) die "Model must be 5A or 3E." ;; esac
HOSTNAME_VAL="${HOST_OPT:-$(envget MMS_HOSTNAME)}"; HOSTNAME_VAL="${HOSTNAME_VAL:-$(hostname)}"
if [[ $SYSTEM == custom ]]; then ok "Model $MODEL (a Custom program addresses it by IP; the host name \"$HOSTNAME_VAL\" is not used)"
else ok "Model $MODEL, announced as host name \"$HOSTNAME_VAL\" (the Crestron processor must be able to resolve it; mDNS \"$HOSTNAME_VAL.local\" via avahi works)"; fi

# ------------------------------------------------------------------ per-slot choice
declare -A STYPE SURL ROONZ
for k in "${SLOT_KEYS[@]}"; do
  t="$(envget "MMS_${k}_TYPE")"; u="$(envget "MMS_${k}_URL")"; ROONZ[$k]="$(envget "MMS_${k}_ROON_ZONE")"
  if [[ -z $t && -n $(envget "MMS_PLEXAMP_$k") ]]; then t=plexamp; u="$(envget "MMS_PLEXAMP_$k")"; fi   # older .env spelling
  STYPE[$k]="${t:-none}"; SURL[$k]="$u"
done
for spec in ${SLOT_OPTS[@]+"${SLOT_OPTS[@]}"}; do
  k="${spec%%=*}"; k="${k^^}"; k="${k#PLAYER}"; k="${k// /}"; v="${spec#*=}"; t="${v%%:*}"; u=""; [[ $v == *:* ]] && u="${v#*:}"
  [[ " ${SLOT_KEYS[*]} " == *" $k "* ]] || die "Slot '$k' does not exist on a $MODEL (use ${SLOT_KEYS[*]})."
  case ${t,,} in plexamp|bluos|wiim|roon) [[ -n $u ]] || die "--slot $spec needs an address after the type (for roon: the zone name)." ;; none) u="" ;; *) die "--slot type must be plexamp, bluos, wiim, roon or none (got '$t')." ;; esac
  STYPE[$k]="${t,,}"; SURL[$k]="$u"
done
for spec in ${ROON_OPTS[@]+"${ROON_OPTS[@]}"}; do
  [[ $spec == *=* ]] || die "--roon-zone $spec needs KEY=ZONE NAME (an empty zone removes it)."
  k="${spec%%=*}"; k="${k^^}"; k="${k#PLAYER}"; k="${k// /}"
  [[ " ${SLOT_KEYS[*]} " == *" $k "* ]] || die "Slot '$k' does not exist on a $MODEL (use ${SLOT_KEYS[*]})."
  ROONZ[$k]="${spec#*=}"
done

if (( ! YES )) && [[ ${#SLOT_OPTS[@]} -eq 0 ]]; then
  step "What drives each player?"
  echo "  Each slot shows up in Crestron Home as its own source. Choose, per slot:"
  echo "    p = Plexamp / Caldera (your Plex library, played on that Plexamp device's own output)"
  echo "    b = BluOS player (its sources, inputs, presets and queue)"
  echo "    w = WiiM / LinkPlay player (its presets; the WiiM has no library API)"
  echo "    r = Roon zone (browse and play through your Roon Core; the Roon extension is enabled once in Roon)"
  echo "    n = not used"
  for k in "${SLOT_KEYS[@]}"; do
    cur="${STYPE[$k]}"; d=n; [[ $cur == plexamp ]] && d=p; [[ $cur == bluos ]] && d=b; [[ $cur == wiim ]] && d=w; [[ $cur == roon ]] && d=r
    while :; do
      printf '  %-9s [p/b/w/r/n] [%s]: ' "$(slot_label "$k")" "$d" >&2; read -r a || true; a="${a:-$d}"; a="${a,,}"
      case $a in
        p|plexamp) STYPE[$k]=plexamp; ask_def="${SURL[$k]}"; q="Plexamp/Caldera address (e.g. 192.168.1.105 or 192.168.1.105:32500)"; break ;;
        b|bluos)   STYPE[$k]=bluos;   ask_def="${SURL[$k]}"; q="BluOS player IP address (e.g. 192.168.1.50; the output is asked next)"; break ;;
        w|wiim)    STYPE[$k]=wiim;    ask_def="${SURL[$k]}"; q="WiiM player IP address (e.g. 192.168.1.113)"; break ;;
        r|roon)    STYPE[$k]=roon;    ask_def="${SURL[$k]}"; q="Roon zone name, exactly as Roon shows it (e.g. Living Room)"; break ;;
        n|none)    STYPE[$k]=none; SURL[$k]=""; q=""; break ;;
        *) echo "    Please answer p, b, w, r or n." >&2 ;;
      esac
    done
    if [[ -n ${q-} ]]; then
      [[ ${STYPE[$k]} == "${cur}" ]] || ask_def=""
      while :; do
        printf '            %s%s: ' "$q" "${ask_def:+ [$ask_def]}" >&2; read -r a || true; a="${a:-$ask_def}"
        [[ -n $a ]] && { SURL[$k]="$a"; break; }; echo "            An address is required." >&2
      done
      if [[ ${STYPE[$k]} == bluos && ${SURL[$k]} != *'#'* && ! ${SURL[$k]} =~ :[0-9]+$ ]]; then
        printf '            Which output of that device is this? 1 for most; a multi-output device has 2-8 (output N is on port 11000+10*(N-1)) [1]: ' >&2
        read -r a || true; a="${a:-1}"; SURL[$k]="${SURL[$k]}#$a"
      fi
      if [[ ${STYPE[$k]} == bluos ]]; then
        printf '            Also browse and play Roon from this slot? Roon zone name for this player, - for none%s: ' "${ROONZ[$k]:+ [${ROONZ[$k]}]}" >&2
        read -r a || true; a="${a:-${ROONZ[$k]}}"; [[ $a == - ]] && a=""; ROONZ[$k]="$a"
      fi
    fi
    q=""
  done
fi

NPLEX=0; NBLU=0; NWIIM=0; NROON=0; USED=0
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }
for k in "${SLOT_KEYS[@]}"; do
  [[ ${STYPE[$k]} == bluos ]] || ROONZ[$k]=""; ROONZ[$k]="$(trim "${ROONZ[$k]}")"; [[ -z ${ROONZ[$k]} ]] || NROON=$((NROON+1))
  case ${STYPE[$k]} in
    plexamp) SURL[$k]="$(norm_url "${SURL[$k]}" 32500)"; NPLEX=$((NPLEX+1)); USED=$((USED+1)) ;;
    bluos)   SURL[$k]="$(bluos_url "${SURL[$k]}")"; NBLU=$((NBLU+1)); USED=$((USED+1)) ;;
    wiim)    SURL[$k]="$(wiim_url "${SURL[$k]}")"; NWIIM=$((NWIIM+1)); USED=$((USED+1)) ;;
    roon)    SURL[$k]="$(trim "${SURL[$k]}")"; NROON=$((NROON+1)); USED=$((USED+1)) ;;      # a zone name keeps its spaces
  esac
done
(( USED )) || warn "No slot is configured: every player will show \"Not configured\" (you can re-run this later)."

# ------------------------------------------------------------------ Crestron Custom: processor + IP-ID per slot
valid_master() { # IP[:PORT]@IPID with a hex IP-ID in 03..FE
  [[ $1 =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3})(:[0-9]{1,5})?@([0-9A-Fa-f]{1,2})$ ]] || return 1
  local o ip="${BASH_REMATCH[1]}" id=$((16#${BASH_REMATCH[4]}))
  for o in ${ip//./ }; do (( 10#$o <= 255 )) || return 1; done
  (( id >= 3 && id <= 254 ))
}
declare -A SMASTER
if [[ $SYSTEM == custom ]]; then
  for k in "${SLOT_KEYS[@]}"; do SMASTER[$k]="$(envget "MMS_${k}_MASTER")"; [[ -n ${SMASTER[$k]} ]] || SMASTER[$k]="$(envget MMS_MASTER)"; done
  if [[ -n $MASTER_OPT ]]; then for k in "${SLOT_KEYS[@]}"; do SMASTER[$k]="$MASTER_OPT"; done; fi
  for spec in ${SMASTER_OPTS[@]+"${SMASTER_OPTS[@]}"}; do
    k="${spec%%=*}"; k="${k^^}"; k="${k#PLAYER}"; k="${k// /}"
    [[ " ${SLOT_KEYS[*]} " == *" $k "* ]] || die "Slot '$k' does not exist on a $MODEL (use ${SLOT_KEYS[*]})."
    SMASTER[$k]="${spec#*=}"
  done
  if (( ! YES )) && [[ -z $MASTER_OPT && ${#SMASTER_OPTS[@]} -eq 0 ]] && (( USED )); then
    step "Which Crestron processor does each player report to?"
    echo "  Each used slot needs the processor's IP address and the IP-ID of the Autonomic MMS symbol in your program (hex, e.g. 0A)."
    echo "  Players that share a processor and IP-ID are one MMS symbol; press Enter to repeat the previous answer."
    prev_ip=""; prev_id=""
    for k in "${SLOT_KEYS[@]}"; do
      [[ ${STYPE[$k]} != none ]] || continue
      cur="${SMASTER[$k]}"; dip="${cur%@*}"; did="${cur#*@}"; [[ -n $cur ]] || { dip="$prev_ip"; did="$prev_id"; }
      while :; do
        printf '  %-9s processor IP address%s: ' "$(slot_label "$k")" "${dip:+ [$dip]}" >&2; read -r a || true; ip="${a:-$dip}"
        printf '            IP-ID (hex)%s: ' "${did:+ [$did]}" >&2; read -r a || true; id="${a:-$did}"
        if valid_master "$ip@$id"; then SMASTER[$k]="$ip@${id^^}"; prev_ip="$ip"; prev_id="${id^^}"; break; fi
        echo "            That is not a valid IPv4 address and IP-ID 03..FE; try again." >&2
      done
    done
  fi
  for k in "${SLOT_KEYS[@]}"; do
    [[ ${STYPE[$k]} != none ]] || continue
    valid_master "${SMASTER[$k]-}" || die "$(slot_label "$k") needs a processor: --master IP@IPID or --slot-master $k=IP@IPID (got '${SMASTER[$k]-}')."
    id="${SMASTER[$k]#*@}"; SMASTER[$k]="${SMASTER[$k]%@*}@${id^^}"
  done
fi

# ------------------------------------------------------------------ Plex server (only if a slot uses Plexamp)
PLEX_URL="${PLEXURL_OPT:-${PLEX_URL-}}"; PLEX_TOKEN="${PLEX_TOKEN-}"
if (( NPLEX )); then
  step "Plex server"
  [[ -n $PLEX_URL ]] || PLEX_URL="$(envget PLEX_URL)"; [[ -n $PLEX_TOKEN ]] || PLEX_TOKEN="$(envget PLEX_TOKEN)"
  if (( ! YES )); then
    [[ -n $PLEXURL_OPT ]] || { printf 'Plex server address (e.g. 192.168.1.22 or 192.168.1.22:32400)%s: ' "${PLEX_URL:+ [$PLEX_URL]}" >&2; read -r a || true; PLEX_URL="${a:-$PLEX_URL}"; }
    if [[ -z ${PLEX_TOKEN-} || -z $(envget PLEX_TOKEN) ]]; then
      printf 'Plex token (input hidden): ' >&2; read -r -s a || true; printf '\n' >&2; PLEX_TOKEN="${a:-$PLEX_TOKEN}"
    else
      printf 'Plex token (input hidden) [Enter keeps the saved one]: ' >&2; read -r -s a || true; printf '\n' >&2; PLEX_TOKEN="${a:-$PLEX_TOKEN}"
    fi
  fi
  [[ -n $PLEX_URL && -n $PLEX_TOKEN ]] || die "A Plex address and token are required for Plexamp slots (set PLEX_URL / PLEX_TOKEN with --yes)."
  PLEX_URL="$(norm_url "$PLEX_URL" 32400)"
fi

# ------------------------------------------------------------------ validate
step "Checking the players"
PROBLEMS=0
if (( NPLEX )); then
  curl_plex() { printf 'header = "X-Plex-Token: %s"\n' "$PLEX_TOKEN" | curl -sS -m 10 -K - "$@"; }
  out="$(curl -sS -m 8 "$PLEX_URL/identity" 2>&1 || true)"
  if [[ $out == *machineIdentifier* ]]; then
    ok "Plex server reachable at $PLEX_URL"
    code="$(curl_plex -o /dev/null -w '%{http_code}' "$PLEX_URL/library/sections" 2>/dev/null || true)"
    if [[ $code == 200 ]]; then
      ok "Plex token accepted"
      secs="$(curl_plex -H 'Accept: application/json' "$PLEX_URL/library/sections" 2>/dev/null || true)"
      [[ $secs == *'"type":"artist"'* ]] && ok "Music library found" || warn "No music library found on that Plex server (browsing will be empty)"
    else warn "Plex rejected the token (HTTP ${code:-none}) - see https://support.plex.tv/articles/204059436"; PROBLEMS=1; fi
  else warn "No Plex server answered at $PLEX_URL"; PROBLEMS=1; fi
fi
for k in "${SLOT_KEYS[@]}"; do
  case ${STYPE[$k]} in
    plexamp) # any Plex Companion player (Plexamp, Caldera Music, ...) answers /resources with a protocol="plex" player
      out="$(curl -sS -m 8 "${SURL[$k]}/resources" 2>&1 || true)"
      if [[ $out == *'<Player '* && $out == *'protocol="plex"'* ]]; then
        prod="$(printf '%s' "$out" | grep -o 'product="[^"]*"' | head -1 | cut -d'"' -f2)"
        ok "$(slot_label "$k"): ${prod:-Plexamp-compatible player} reachable at ${SURL[$k]}"
      else warn "$(slot_label "$k"): no Plexamp (or Caldera) player answered at ${SURL[$k]} (is headless Plexamp/Caldera running? default port 32500)"; PROBLEMS=1; fi ;;
    bluos)
      out="$(curl -sS -m 8 "${SURL[$k]}/SyncStatus" 2>&1 || true)"
      if [[ $out == *SyncStatus* ]]; then
        pname="$(printf '%s' "$out" | grep -o ' name="[^"]*"' | head -1 | sed 's/^ name="//; s/"$//' || true)"
        ok "$(slot_label "$k"): BluOS player${pname:+ \"$pname\"} reachable at ${SURL[$k]}"
      else warn "$(slot_label "$k"): no BluOS player answered at ${SURL[$k]}/SyncStatus"; PROBLEMS=1; fi ;;
    wiim) # newer firmware answers on HTTPS (self-signed certificate), older on plain HTTP
      h="${SURL[$k]#http://}"; h="${h#https://}"; out=""
      for sch in https http; do
        out="$(curl -sSk -m 6 "$sch://$h/httpapi.asp?command=getStatusEx" 2>/dev/null || true)"
        [[ $out == *DeviceName* || $out == *'"uuid"'* ]] && break
      done
      if [[ $out == *DeviceName* || $out == *'"uuid"'* ]]; then
        pname="$(printf '%s' "$out" | grep -o '"DeviceName" *: *"[^"]*"' | head -1 | sed 's/^[^:]*: *"//; s/"$//' || true)"
        ok "$(slot_label "$k"): WiiM player${pname:+ \"$pname\"} reachable at ${SURL[$k]}"
      else warn "$(slot_label "$k"): no WiiM/LinkPlay player answered at ${SURL[$k]} (tried https and http /httpapi.asp)"; PROBLEMS=1; fi ;;
  esac
done
if [[ $SYSTEM == custom ]]; then
  declare -A SEEN
  for k in "${SLOT_KEYS[@]}"; do
    [[ ${STYPE[$k]} != none ]] || continue
    m="${SMASTER[$k]}"; [[ -z ${SEEN[$m]-} ]] || continue; SEEN[$m]=1
    hp="${m%@*}"; host="${hp%%:*}"; port=41794; [[ $hp == *:* ]] && port="${hp#*:}"
    if timeout 4 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then ok "Processor $host answers on CIP port $port (IP-ID ${m#*@})"
    else warn "Processor $host does not answer on port $port (is it on, and is the program with the MMS symbol running?)"; PROBLEMS=1; fi
  done
fi
(( USED )) || ok "Nothing to check"
if (( PROBLEMS )); then confirm "Problems were found. Continue anyway?" n || die "Fix the problems above and re-run ./install.sh (your answers are not saved yet)."; fi

# ------------------------------------------------------------------ Roon packages (only if a slot uses Roon)
if (( NROON )); then
  step "Roon support"
  if (( DRY )); then echo "  [dry-run] would run npm install in $DIR (node-roon-api, from GitHub)"
  else
    NEED=(); command -v git >/dev/null || NEED+=(git); command -v npm >/dev/null || NEED+=(npm)
    if (( ${#NEED[@]} )); then
      warn "Roon support needs: ${NEED[*]}"
      confirm "Install them with apt now?" y || die "Install ${NEED[*]} and re-run."
      run sudo apt-get update -qq; run sudo apt-get install -y -qq "${NEED[@]}"
    fi
    npm install --omit=dev --no-audit --no-fund --prefix "$DIR" >/dev/null 2>&1 || true
    "$NODE_BIN" -e "for (const m of ['node-roon-api','node-roon-api-transport','node-roon-api-browse','node-roon-api-image']) require(m)" 2>/dev/null \
      || die "The Roon packages could not be installed (they come from GitHub, so the Pi needs internet and git). Try: cd $DIR && npm install"
    ok "Roon packages installed"
  fi
  echo "  Zone names are not checked here; if one is wrong the slot's menu says so."
fi

# ------------------------------------------------------------------ install
step "Installing"
if (( DRY )); then
  echo "  [dry-run] would write .env (mode 600):"
  echo "    MMS_MODEL=$MODEL MMS_HOSTNAME=$HOSTNAME_VAL"
  [[ $SYSTEM == custom ]] && echo "    MMS_SYSTEM=custom"
  (( NPLEX )) && echo "    PLEX_URL=$PLEX_URL PLEX_TOKEN=(hidden)"
  for k in "${SLOT_KEYS[@]}"; do [[ ${STYPE[$k]} == none ]] || echo "    MMS_${k}_TYPE=${STYPE[$k]} MMS_${k}_URL=${SURL[$k]}${ROONZ[$k]:+ MMS_${k}_ROON_ZONE=${ROONZ[$k]}}${SMASTER[$k]:+ MMS_${k}_MASTER=${SMASTER[$k]}}"; done
else
  # keep any setting this installer does not manage (e.g. MMS_DEMO, MMS_ADVERTISE_IP)
  KEEP=""; [[ -f .env ]] && KEEP="$(grep -Ev '^(PLEX_URL|PLEX_TOKEN|MMS_MODEL|MMS_HOSTNAME|MMS_PLEXAMP_[A-D]|MMS_SYSTEM|MMS_MASTER|MMS_(MAIN|A|B|C|D|USB)_(TYPE|URL|ROON_ZONE|MASTER))=' .env || true)"
  {
    printf 'MMS_MODEL=%s\nMMS_HOSTNAME=%s\n' "$MODEL" "$HOSTNAME_VAL"
    [[ $SYSTEM != custom ]] || printf 'MMS_SYSTEM=custom\n'
    (( NPLEX )) && printf 'PLEX_URL=%s\nPLEX_TOKEN=%s\n' "$PLEX_URL" "$PLEX_TOKEN"
    for k in "${SLOT_KEYS[@]}"; do
      [[ ${STYPE[$k]} == none ]] || printf 'MMS_%s_TYPE=%s\nMMS_%s_URL=%s\n' "$k" "${STYPE[$k]}" "$k" "${SURL[$k]}"
      [[ $SYSTEM != custom || ${STYPE[$k]} == none ]] || printf 'MMS_%s_MASTER=%s\n' "$k" "${SMASTER[$k]}"
      [[ -z ${ROONZ[$k]} ]] || printf 'MMS_%s_ROON_ZONE=%s\n' "$k" "${ROONZ[$k]}"
    done
    [[ -z $KEEP ]] || printf '%s\n' "$KEEP"
  } > .env.new
  chmod 600 .env.new; mv .env.new .env
  ok "Saved settings to $DIR/.env (readable only by $RUN_USER)"
fi

if (( DRY )); then echo "  [dry-run] would install /etc/systemd/system/$UNIT.service"
else
  sed -e "s|@USER@|$RUN_USER|g" -e "s|@DIR@|$DIR|g" -e "s|@NODE@|$NODE_BIN|g" systemd/$UNIT.service.in | sudo tee /etc/systemd/system/$UNIT.service >/dev/null
fi
run sudo systemctl daemon-reload
run sudo systemctl enable $UNIT >/dev/null 2>&1
run sudo systemctl restart $UNIT
(( DRY )) || ok "Service installed (starts on boot and restarts if it crashes)"

# ------------------------------------------------------------------ verify
if (( ! DRY )); then
  step "Verifying"
  sleep 5
  if systemctl is-active --quiet $UNIT; then
    ok "$UNIT is running"
    jl="$(sudo journalctl -u $UNIT --since "-1min" --no-pager -o cat 2>/dev/null || true)"
    if [[ $jl == *'init failed'* ]]; then warn "A player could not be reached at startup - check: sudo journalctl -u $UNIT -n 50"; fi
  else warn "$UNIT is NOT running - see: sudo journalctl -u $UNIT -n 50"; fi
fi

step "Done"
if [[ $SYSTEM == custom ]]; then
PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF
Next steps (Crestron Custom):
  * In your SIMPL program the Autonomic MMS-5A symbol must use the IP-ID you entered (hex); if the symbol has an IP-table address, use
    this device's address (${PI_IP:-this Pi's IP}). The emulator dials the processor, so no scan or console step is needed.
  * Make sure each Media Object Router / touch panel in the program points at the matching player.
Useful commands:
  ./install.sh --status                       show the service, what drives each slot and its processor
  ./install.sh --slot-master B=192.168.4.6@0B change one slot's processor and IP-ID
  sudo journalctl -u $UNIT -f                 live log
  ./install.sh --uninstall                    remove the service
EOF
exit 0
fi
cat <<EOF
Next steps:
  * In Crestron Home setup: Crestron Wired and Wi-Fi > Ethernet and Wi-Fi > scan; the MMS appears as "$HOSTNAME_VAL". Add it,
    then assign each player's output to an amplifier. After a restart allow about 2 minutes for the app to re-register the players.
$( (( NROON )) && printf '%s\n' '  * Roon: in Roon go to Settings > Extensions and enable "MMS Emulator" (once). Until then a Roon menu says "Waiting for Roon".' )
Useful commands:
  ./install.sh --status                       show the service and what drives each slot
  ./install.sh --slot B=bluos:192.168.1.50    change one slot (others keep their saved settings)
  ./install.sh --slot B=wiim:192.168.1.113    drive a slot from a WiiM (its presets are the browse list)
  ./install.sh --slot C=roon:"Living Room"    drive a slot from a Roon zone
  ./install.sh --roon-zone B="Living Room"    add Home Menu > Roon to a BluOS slot (--roon-zone B= removes it)
  ./install.sh --slot C=none                  stop using a slot
  sudo journalctl -u $UNIT -f                 live log
  ./install.sh --uninstall                    remove the service
EOF
