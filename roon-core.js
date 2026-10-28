'use strict';
// One connection to a Roon Core, shared by every slot that uses Roon. The emulator is a Roon extension: it finds the Core on the
// network (or dials MMS_ROON_HOST), pairs, and must be enabled once in Roon > Settings > Extensions. Needs the node-roon-api packages
// (installed by ./install.sh when a slot uses Roon); they are only loaded here, so the emulator runs without them otherwise.
//   events: 'paired' (core), 'unpaired', 'zones' ({ changed: Zone[], removed: Zone[] })
//   zones are Roon's own zone objects (state, now_playing, settings, is_*_allowed, outputs[]), kept current from transport pushes.

const EventEmitter = require('events');
const fs = require('fs');

function loadRoonModules() {
  try {
    return {
      RoonApi: require('node-roon-api'), RoonApiTransport: require('node-roon-api-transport'),
      RoonApiBrowse: require('node-roon-api-browse'), RoonApiImage: require('node-roon-api-image'),
    };
  } catch (e) { throw new Error(`Roon support needs the node-roon-api packages: run ./install.sh (or npm install) in the emulator folder (${e.message})`); }
}

const norm = s => String(s || '').trim().toLowerCase();
const failure = err => new Error(typeof err === 'string' ? err : 'Roon request failed');

function createRoonCore({ modules, log, statePath, host, version = '1.0', publisher = 'MMS Emulator project', email = 'mms-emulator@users.noreply.github.com',
  website = 'https://github.com/dumpdog/ch-mms-emulator', reconnectMs = 5000 }) {
  const { RoonApi, RoonApiTransport, RoonApiBrowse, RoonApiImage } = modules || loadRoonModules();
  const events = new EventEmitter();
  const zones = new Map();
  let core = null, api = null, closed = false, retry = null;

  const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } };
  const writeState = s => { try { fs.writeFileSync(statePath, JSON.stringify(s, null, 2), { mode: 0o600 }); } catch (e) { log(`roon: cannot save ${statePath}: ${e.message}`); } };

  function onZones(resp, msg) {
    const changed = [], removed = [];
    if (resp === 'Subscribed') { zones.clear(); for (const z of msg.zones || []) { zones.set(z.zone_id, z); changed.push(z); } }
    else if (resp === 'Changed') {
      for (const id of msg.zones_removed || []) { const z = zones.get(id); if (z) removed.push(z); zones.delete(id); }
      for (const z of [...(msg.zones_added || []), ...(msg.zones_changed || [])]) { zones.set(z.zone_id, z); changed.push(z); }
      for (const e of msg.zones_seek_changed || []) {                  // once a second while playing
        const z = zones.get(e.zone_id); if (!z) continue;
        if (z.now_playing) z.now_playing.seek_position = e.seek_position;
        z.queue_time_remaining = e.queue_time_remaining; changed.push(z);
      }
    } else return;
    if (changed.length || removed.length) events.emit('zones', { changed, removed });
  }
  function paired(c) {
    core = c; log(`roon: paired with Core "${c.display_name || c.core_id}"`);
    c.services.RoonApiTransport.subscribe_zones(onZones);
    events.emit('paired', c);
  }
  function unpaired(c) {
    log(`roon: lost Core "${(c && c.display_name) || ''}"`);
    core = null; zones.clear(); events.emit('unpaired', c); events.emit('zones', { changed: [], removed: [] });
  }

  const svc = name => { if (!core) throw new Error('Roon Core not connected (enable "MMS Emulator" in Roon > Settings > Extensions)'); return core.services[name]; };
  const call = (name, method, ...args) => new Promise((resolve, reject) => svc(name)[method](...args, (err, body) => (err ? reject(failure(err)) : resolve(body))));

  function connectDirect() {
    const [h, p] = host.split(':'); const port = Number(p) || 9330;
    log(`roon: connecting to ${h}:${port}`);
    api.ws_connect({ host: h, port, onclose: () => { if (!closed) { retry = setTimeout(connectDirect, reconnectMs); retry.unref(); } } });
  }

  return {
    events,
    ready: () => !!core,
    zones: () => [...zones.values()],
    // a zone matches by its own name or by the name of any of its outputs (a single-output zone is named after the output)
    zoneByName(name) {
      const n = norm(name);
      return [...zones.values()].find(z => norm(z.display_name) === n) || [...zones.values()].find(z => (z.outputs || []).some(o => norm(o.display_name) === n)) || null;
    },
    start() {
      api = new RoonApi({ extension_id: 'com.mms-emulator.roon', display_name: 'MMS Emulator', display_version: version, publisher, email, website,
        get_persisted_state: readState, set_persisted_state: writeState, core_paired: paired, core_unpaired: unpaired });
      api.init_services({ required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage] });
      if (host) connectDirect(); else { log('roon: looking for a Core on the network'); api.start_discovery(); }
    },
    close() { closed = true; clearTimeout(retry); try { api && api.stop_discovery && api.stop_discovery(); } catch { /* already stopped */ } },

    control: (zoneId, how) => call('RoonApiTransport', 'control', zoneId, how),
    seek: (zoneId, how, seconds) => call('RoonApiTransport', 'seek', zoneId, how, seconds),
    settings: (zoneId, s) => call('RoonApiTransport', 'change_settings', zoneId, s),
    playFromHere: (zoneId, queueItemId) => new Promise((resolve, reject) => svc('RoonApiTransport').play_from_here(zoneId, queueItemId, (msg, body) => (msg && msg.name !== 'Success' ? reject(failure(msg.name)) : resolve(body)))),
    browse: opts => call('RoonApiBrowse', 'browse', opts),
    load: opts => call('RoonApiBrowse', 'load', opts),
    image: (key, opts) => new Promise((resolve, reject) => svc('RoonApiImage').get_image(key, opts, (err, type, body) => (err ? reject(failure(err)) : resolve({ type, body })))),
    // the play queue is only offered as a subscription: take the first snapshot, then unsubscribe
    queue(zoneId, max = 100, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        let sub = null, done = false;
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { sub && sub.unsubscribe(() => {}); } catch { /* gone */ } fn(v); };
        const timer = setTimeout(() => finish(reject, new Error('Roon queue timed out')), timeoutMs);
        try { sub = svc('RoonApiTransport').subscribe_queue(zoneId, max, (err, body) => {
          if (err && err !== 'Subscribed' && err !== 'Changed') finish(reject, failure(err));   // subscription pushes name the event in the error slot
          else if (body && body.items) finish(resolve, body.items);
        }); }
        catch (e) { finish(reject, e); }
      });
    },
  };
}

module.exports = { createRoonCore, loadRoonModules };
