'use strict';
// A BluOS slot that can also browse and play Roon (the BluOS player is a zone in Roon). Home Menu = the BluOS home plus a first
// "Roon" entry that opens the Roon browse tree. Now playing and the transport buttons follow whichever side is active:
// Roon while its zone is playing (or paused with BluOS idle), BluOS otherwise. While Roon streams to the player, the player's own
// status says little and a BluOS command could upset the Roon session, so Roon gets the controls then.
// Backend contract: see backend-wiim.js; art guids start with 'b' (BluOS) or 'r' (Roon).

const EventEmitter = require('events');

const NIL = '00000000-0000-0000-0000-000000000000';
const CLEARED = { Title: '', Artist: '', Album: '', art: NIL, ActionsAvailable: ['Play'], ProgressBar: false, StationName: '', TrackNum: 0, TrackCnt: 0 };
const METHODS = ['play', 'pause', 'stop', 'next', 'prev', 'seek', 'ffwd', 'rewind', 'shuffle', 'repeat', 'playAll', 'thumbsUp', 'thumbsDown', 'star'];

function createBluosRoonBackend({ bluos, roon, zoneName, log, name = 'MMS' }) {
  const player = new EventEmitter();
  let active = 'bluos';
  const side = () => (active === 'roon' ? roon : bluos);
  const roonLive = () => {
    const r = roon.player.snapshot().PlayerState, b = bluos.player.snapshot().PlayerState;
    return r === 'playing' || (r === 'paused' && b !== 'playing');
  };
  function update(from, patch) {
    const next = roonLive() ? 'roon' : 'bluos';
    if (next !== active) {
      active = next;
      log(`[bluos+roon ${name}] now following ${active}`);
      player.emit('source', active);                                                  // for MMS_PROVIDER_FOLLOWS_SOURCE (emulator.js)
      player.emit('state', { ...CLEARED, ...side().player.snapshot() });             // the other side's text must not linger
    } else if (from === active) player.emit('state', patch);
  }
  bluos.player.on('state', p => update('bluos', p));
  roon.player.on('state', p => update('roon', p));

  for (const m of METHODS) {
    player[m] = async (...a) => {
      const s = side(), f = s.player[m];
      if (typeof f === 'function') return f.apply(s.player, a);
      log(`[bluos+roon ${name}] ${m} not implemented by ${active}`);
    };
  }
  player.snapshot = () => side().player.snapshot();

  const roonEntry = { l1: 'Roon', l2: zoneName || '', open: () => roon.home() };
  async function home() {
    let base;
    try { base = await bluos.home(); }
    catch (e) { log(`[bluos+roon ${name}] BluOS home unavailable (${e.message}); showing Roon only`); return { title: 'Home Menu', items: [roonEntry] }; }
    if (base.page) {
      return { ...base, count: async () => (await base.count()) + 1,
        page: async (s, n) => (s === 0 ? [roonEntry, ...(n > 1 ? await base.page(0, n - 1) : [])] : base.page(s - 1, n)) };
    }
    return { ...base, items: async () => [roonEntry, ...(typeof base.items === 'function' ? await base.items() : base.items)] };
  }

  return {
    providerName: 'BluOS', player, home,
    favorites: bluos.favorites && (() => bluos.favorites()),
    quickList: () => (active === 'roon' ? roon.quickList() : bluos.quickList ? bluos.quickList() : Promise.resolve({ title: 'Up Next', items: [{ l1: 'Nothing here', play: () => {} }] })),
    search: q => roon.search(q),
    art: guid => (guid && guid[0] === 'r' ? roon.art(guid) : bluos.art(guid)),
    async start() { await Promise.allSettled([bluos.start && bluos.start(), roon.start()]); },
    close() { if (bluos.close) bluos.close(); roon.close(); },
  };
}

module.exports = { createBluosRoonBackend };
