'use strict';
// Entry point. Config via env (systemd EnvironmentFile ~/mms-emulator/.env, mode 600):
//   PLEX_URL, PLEX_TOKEN                 Plex Media Server
//   MMS_<SLOT>_TYPE=plexamp|bluos       what drives each slot; SLOT is MAIN, A, B, C, D or USB (Player A..D); unset slots show "Not configured"
//   MMS_<SLOT>_URL                       that player's address: Plexamp/Caldera (default port 32500) or BluOS (default port 11000)
//   MMS_PLEXAMP_A..D                     older spelling of MMS_<A..D>_TYPE=plexamp + MMS_<A..D>_URL
//   MMS_DEMO=1                           fake library on unconfigured slots instead
//   MMS_HOSTNAME (default os.hostname(); must be resolvable by the processor, e.g. via avahi), MMS_MODEL (5A|3E),
//   MMS_HTTP_PORT (default 80), MMS_STATE_FILE (default ./state.json), MMS_ADVERTISE_IP

const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { startEmulator } = require('./emulator');
const { createDemoBackend } = require('./backend-demo');
const { createPlexBackend } = require('./backend-plex');
const { createBluosBackend } = require('./backend-bluos');

const log = m => console.log(`${new Date().toISOString()} ${m}`);
const env = process.env;

const emptyBackend = label => ({ providerName: label, player: new EventEmitter(), home: () => ({ title: 'Home Menu', items: [{ l1: label, play: () => {} }] }) });

const slotKey = name => (/^Player ([A-D])$/.exec(name) || [])[1] || name.toUpperCase();

function createBackend(name) {
  const k = slotKey(name);
  const legacy = env[`MMS_PLEXAMP_${k}`];
  const type = (env[`MMS_${k}_TYPE`] || (legacy ? 'plexamp' : '')).toLowerCase(), url = env[`MMS_${k}_URL`] || legacy;
  if (url && type === 'plexamp' && env.PLEX_URL && env.PLEX_TOKEN) return createPlexBackend({ plexUrl: env.PLEX_URL, token: env.PLEX_TOKEN, plexampUrl: url, name, log });
  if (url && type === 'bluos') return createBluosBackend({ playerUrl: url, name, log });
  return env.MMS_DEMO ? createDemoBackend() : emptyBackend('Not configured');
}

startEmulator({
  hostname: env.MMS_HOSTNAME || os.hostname(),
  model: env.MMS_MODEL || '5A',
  advertiseIp: env.MMS_ADVERTISE_IP,
  discoveryPort: 41794, consolePort: 5004, directBase: 41798,
  httpPort: parseInt(env.MMS_HTTP_PORT || '80', 10),
  stateFile: env.MMS_STATE_FILE || path.join(__dirname, 'state.json'),
  createBackend, log,
}).catch(e => { console.error(e); process.exit(1); });
