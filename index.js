'use strict';
// Entry point. Config via env (systemd EnvironmentFile ~/mms-emulator/.env, mode 600):
//   PLEX_URL, PLEX_TOKEN                 Plex Media Server
//   MMS_<SLOT>_TYPE=plexamp|bluos|wiim|roon  what drives each slot; SLOT is MAIN, A, B, C, D or USB (Player A..D); unset slots show "Not configured"
//   MMS_<SLOT>_URL                       that player's address: Plexamp/Caldera (default port 32500), BluOS (default port 11000) or WiiM/LinkPlay (https, then http);
//                                        for TYPE=roon it is the Roon zone name
//   MMS_<SLOT>_ROON_ZONE                 on a bluos slot: also browse and play that Roon zone from the slot (Home Menu > Roon)
//   MMS_ROON_HOST (host[:port], optional) connect to this Roon Core instead of discovering one; MMS_ROON_STATE (default ./roon-state.json) holds the pairing
//   MMS_PLEXAMP_A..D                     older spelling of MMS_<A..D>_TYPE=plexamp + MMS_<A..D>_URL
//   MMS_DEMO=1                           fake library on unconfigured slots instead
//   MMS_PROVIDER_LABEL (optional visible text for the Services screen; default is blank, see emulator.js),
//   MMS_HOSTNAME (default os.hostname(); must be resolvable by the processor, e.g. via avahi), MMS_MODEL (5A|3E),
//   Crestron Custom (SIMPL) instead of Crestron Home: MMS_SYSTEM=custom, MMS_MASTER=<processor ip>[:port]@<IP-ID hex> (default for every slot),
//   MMS_<SLOT>_MASTER=... overrides it per slot; slots sharing a processor and IP-ID share one connection. No discovery or console is started.
//   MMS_SYSTEM=bridge: a SIMPL+ module on the processor (processor/PlexampDeviceModule.usp, a drop-in for a RoonDeviceModule zone) connects to tcp MMS_BRIDGE_BASE+slot (default 41810); no CIP, IP-ID, discovery or console
//   MMS_HTTP_PORT (default 80), MMS_STATE_FILE (default ./state.json), MMS_ADVERTISE_IP

const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { startEmulator, MODELS } = require('./emulator');
const { parseMasters } = require('./masters');
const { createDemoBackend } = require('./backend-demo');
const { createPlexBackend } = require('./backend-plex');
const { createBluosBackend } = require('./backend-bluos');
const { createWiimBackend } = require('./backend-wiim');
const { createRoonBackend } = require('./backend-roon');
const { createBluosRoonBackend } = require('./backend-bluos-roon');

const log = m => console.log(`${new Date().toISOString()} ${m}`);
const env = process.env;

const emptyBackend = label => ({ providerName: label, player: new EventEmitter(), home: () => ({ title: 'Home Menu', items: [{ l1: label, play: () => {} }] }) });

const slotKey = name => (/^Player ([A-D])$/.exec(name) || [])[1] || name.toUpperCase();

// one Roon connection for all slots; the node-roon-api packages are only loaded when a slot asks for Roon
let roonCore = null;
function roon() {
  if (!roonCore) {
    const { createRoonCore } = require('./roon-core');
    roonCore = createRoonCore({ log: m => log(m), host: env.MMS_ROON_HOST, statePath: env.MMS_ROON_STATE || path.join(__dirname, 'roon-state.json'), version: require('./package.json').version });
    roonCore.start();
  }
  return roonCore;
}

function createBackend(name) {
  const k = slotKey(name);
  const legacy = env[`MMS_PLEXAMP_${k}`];
  const type = (env[`MMS_${k}_TYPE`] || (legacy ? 'plexamp' : '')).toLowerCase(), url = env[`MMS_${k}_URL`] || legacy;
  if (url && type === 'plexamp' && env.PLEX_URL && env.PLEX_TOKEN) return createPlexBackend({ plexUrl: env.PLEX_URL, token: env.PLEX_TOKEN, plexampUrl: url, name, log });
  const zone = env[`MMS_${k}_ROON_ZONE`];
  try {
    if (url && type === 'roon') return createRoonBackend({ core: roon(), zoneName: url, name, log });
    if (url && type === 'bluos' && zone) {
      return createBluosRoonBackend({ bluos: createBluosBackend({ playerUrl: url, name, log }), roon: createRoonBackend({ core: roon(), zoneName: zone, name, log, title: 'Roon' }), zoneName: zone, name, log });
    }
  } catch (e) { log(`${name}: Roon unavailable: ${e.message}`); return type === 'roon' ? emptyBackend('Roon not installed') : createBluosBackend({ playerUrl: url, name, log }); }
  if (url && type === 'bluos') return createBluosBackend({ playerUrl: url, name, log });
  if (url && type === 'wiim') return createWiimBackend({ playerUrl: url, name, log });
  return env.MMS_DEMO ? createDemoBackend() : emptyBackend('Not configured');
}

startEmulator({
  hostname: env.MMS_HOSTNAME || os.hostname(),
  model: env.MMS_MODEL || '5A',
  advertiseIp: env.MMS_ADVERTISE_IP, providerLabel: env.MMS_PROVIDER_LABEL,
  discoveryPort: 41794, consolePort: 5004, directBase: 41798,
  httpPort: parseInt(env.MMS_HTTP_PORT || '80', 10),
  stateFile: env.MMS_STATE_FILE || path.join(__dirname, 'state.json'),
  bridgeBase: env.MMS_SYSTEM === 'bridge' ? parseInt(env.MMS_BRIDGE_BASE || '41810', 10) : undefined,
  masters: env.MMS_SYSTEM === 'custom' ? parseMasters(env, MODELS[env.MMS_MODEL || '5A'].map(slotKey)) : undefined,
  createBackend, log,
}).catch(e => { console.error(e); process.exit(1); });
