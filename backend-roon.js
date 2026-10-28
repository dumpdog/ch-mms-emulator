'use strict';
// Roon zone for one MMS slot. The emulator is a Roon extension (roon-core.js); the slot follows one zone, picked by name.
//  - State: pushed by Roon (zone state, now playing, a seek tick once a second); nothing is polled
//  - Browse: Roon's browse API ("browse" hierarchy). Roon keeps a server-side stack of levels per session, so each slot has its own
//    session and every level the Menu pushes is popped again through node.leave. Calls are serialised: a level's item keys only
//    mean something while that level is the deepest one.
//  - Search: free text (Smart Graphics "Find") through the "search" hierarchy. Crestron Home has no text entry, so Home Menu > Search
//    offers Artists / Albums / Tracks by letter: the Library list is alphabetical, so a letter's first row is found by bisection.
//  - QuickList button = the zone's play queue
// Backend contract: { providerName, home(), quickList(), search(text), player (EventEmitter), art(guid), start, close } (see backend-wiim.js).

const EventEmitter = require('events');

const enc = k => (k ? 'r' + Buffer.from(k).toString('base64url') : '');
const dec = g => (g && g[0] === 'r' ? Buffer.from(g.slice(1), 'base64url').toString() : '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NIL = '00000000-0000-0000-0000-000000000000';
const SKIP_STEPS = [15, 20, 25, 30], SKIP_WINDOW_MS = 2000;
const REPEAT = { disabled: 0, loop_one: 1, loop: 2 };            // MMS RepeatState: 2 all, 1 one, 0 off
const REPEAT_NEXT = ['loop_one', 'loop', 'disabled'];            // by current RepeatState: off -> one -> all -> off
const BUCKETS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const bucketOf = t => { const c = String(t || '').normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '')[0]; return c && /[a-z]/i.test(c) ? c.toUpperCase() : '#'; };
const placeholder = (title, text, l2) => ({ title, items: [{ l1: text, l2: l2 || '', play: () => {} }] });
const line = (np, k, n) => ((np[`${k}_line`] || {})[`line${n}`]) || '';

function createRoonBackend({ core, zoneName, name = 'MMS', log, sessionKey = name, skipWindowMs = SKIP_WINDOW_MS, title = 'Home Menu' }) {
  const player = new EventEmitter();
  const cur = {};                                                // last values emitted to the slot
  let zone = null, skipRun = { dir: 0, n: 0, at: 0 };
  const L = m => log(`[roon ${name}] ${m}`);
  const zoneId = () => (zone ? zone.zone_id : undefined);

  // ---------------------------------------------------------------- state -> slot
  function emit(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) if (!same(cur[k], v)) { cur[k] = v; out[k] = v; }
    if (Object.keys(out).length) player.emit('state', out);
  }
  const CLEARED = { Title: '', Artist: '', Album: '', art: NIL, ActionsAvailable: ['Play'], ProgressBar: false, StationName: '', TrackNum: 0, TrackCnt: 0 };
  function patchOf(z) {
    if (!z) return { PlayerState: 'stopped', ElapsedSec: 0, TrackSec: 0, ShuffleState: 0, RepeatState: 0, ...(cur.Title ? CLEARED : {}) };
    const np = z.now_playing, st = z.state, length = (np && np.length) || 0, stream = !!np && !length, set = z.settings || {};
    const patch = {
      PlayerState: st === 'playing' || st === 'loading' ? 'playing' : st === 'paused' ? 'paused' : 'stopped',
      ElapsedSec: Math.floor((np && np.seek_position) || 0), TrackSec: Math.floor(length),
      ShuffleState: set.shuffle ? 1 : 0, RepeatState: REPEAT[set.loop] || 0,
    };
    if (np) {
      const acts = ['Pause', 'Play', 'Stop'];
      if (z.is_next_allowed) acts.push('NextTrack');
      if (z.is_previous_allowed) acts.push('PreviousTrack');
      if (!stream) { if (z.is_seek_allowed) acts.push('Seek', 'Ffwd', 'Rewind'); acts.push('Repeat', 'Shuffle'); }
      Object.assign(patch, { Title: line(np, 'three', 1) || line(np, 'one', 1), Artist: line(np, 'three', 2), Album: line(np, 'three', 3),
        art: enc(np.image_key) || NIL, ActionsAvailable: acts.sort(), ProgressBar: !stream, StationName: stream ? line(np, 'three', 3) : '' });
    } else if (cur.Title) Object.assign(patch, CLEARED);
    return patch;
  }
  function refresh() { zone = core.ready() ? core.zoneByName(zoneName) : null; emit(patchOf(zone)); }
  core.events.on('zones', refresh); core.events.on('paired', refresh); core.events.on('unpaired', refresh);

  // ---------------------------------------------------------------- playback
  const control = how => async () => { const id = zoneId(); if (!id) return L(`zone "${zoneName}" not available`); await core.control(id, how); };
  async function skip(dir) {
    const id = zoneId(); if (!id) return;
    const now = Date.now(), streak = dir === skipRun.dir && now - skipRun.at < skipWindowMs, n = streak ? skipRun.n + 1 : 0;
    skipRun = { dir, n, at: now };
    await core.seek(id, 'relative', dir * SKIP_STEPS[Math.min(n, SKIP_STEPS.length - 1)]);
  }
  Object.assign(player, {
    play: control('play'), pause: control('pause'), stop: control('stop'), next: control('next'), prev: control('previous'),
    async seek(p = {}) {
      const v = [p.sec, p.seconds, p.position, p.elapsedSec].find(Number.isFinite), id = zoneId();
      if (v === undefined) return L(`seek: unknown params ${JSON.stringify(p)}`);
      if (id) { emit({ ElapsedSec: v | 0 }); await core.seek(id, 'absolute', Math.max(0, v | 0)); }
    },
    ffwd: () => skip(1), rewind: () => skip(-1),
    async shuffle() { const id = zoneId(); if (!id) return; const v = cur.ShuffleState ? 0 : 1; emit({ ShuffleState: v }); await core.settings(id, { shuffle: !!v }); },
    async repeat() { const id = zoneId(); if (!id) return; const loop = REPEAT_NEXT[cur.RepeatState || 0]; emit({ RepeatState: REPEAT[loop] }); await core.settings(id, { loop }); },
    snapshot: () => ({ ...cur }),
  });
  for (const k of ['play', 'pause', 'stop', 'next', 'prev', 'seek', 'ffwd', 'rewind', 'shuffle', 'repeat']) {     // a refused command is logged, not thrown
    const f = player[k]; player[k] = async (...a) => { try { await f(...a); } catch (e) { L(`${k} failed: ${e.message}`); } };
  }

  // ---------------------------------------------------------------- browse
  // Calls are serialised; gen[h] changes whenever a pop_all resets that hierarchy's stack, which makes older leave() calls no-ops.
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const gen = { browse: 0, search: 0 };
  const hier = h => ({ hierarchy: h, multi_session_key: sessionKey });
  const reset = async h => { gen[h]++; return core.browse({ ...hier(h), pop_all: true }); };     // call inside serial()
  const waiting = () => core.ready() ? [] : [{ l1: 'Waiting for Roon', l2: 'Enable "MMS Emulator" in Roon > Settings > Extensions', play: () => {} }];

  function itemOf(h, it) {
    const row = { l1: it.title || '', l2: it.subtitle || '', art: enc(it.image_key) }, k = it.item_key;
    if (!k || it.hint === 'header' || it.input_prompt) return row;          // not selectable here (search text is typed through Find)
    if (it.hint === 'action') return { ...row, play: () => act(h, k) };
    if (it.hint === 'action_list') return { ...row, play: () => playItem(h, k), context: () => actionsNode(h, k, row.l1) };
    return { ...row, open: () => openLevel(h, k, row.l1) };
  }
  function levelNode(h, list, pops = 1) {
    const g = gen[h], level = list.level;
    return {
      title: list.title || 'Roon', count: async () => list.count,
      page: async (start, n) => ((await serial(() => core.load({ ...hier(h), level, offset: start, count: n }))).items || []).map(i => itemOf(h, i)),
      leave: () => serial(async () => { if (g === gen[h]) for (let i = 0; i < pops; i++) await core.browse({ ...hier(h), pop_levels: 1 }); }).catch(e => L(`leave failed: ${e.message}`)),
    };
  }
  async function openLevel(h, key, label) {
    const r = await serial(() => core.browse({ ...hier(h), item_key: key, zone_or_output_id: zoneId() }));
    return r.action === 'list' ? levelNode(h, r.list) : placeholder(label || 'Roon', r.message || 'Nothing to show');   // no level was pushed: no leave
  }
  const act = (h, key) => serial(() => core.browse({ ...hier(h), item_key: key, zone_or_output_id: zoneId() })).catch(e => L(`action failed: ${e.message}`));
  async function actionsNode(h, key, label) {
    const r = await serial(() => core.browse({ ...hier(h), item_key: key, zone_or_output_id: zoneId() }));
    if (r.action !== 'list') return placeholder(label, r.message || 'No actions');
    return { ...levelNode(h, r.list), title: label };
  }
  // Select on a track/album/playlist: run its "Play Now" action (the first action if there is none by that name)
  const playItem = (h, key) => serial(async () => {
    const id = zoneId(); if (!id) return L(`zone "${zoneName}" not available`);
    const r = await core.browse({ ...hier(h), item_key: key, zone_or_output_id: id });
    if (r.action !== 'list') return;                                           // played straight away, no action list was pushed
    try {
      const acts = ((await core.load({ ...hier(h), level: r.list.level, offset: 0, count: 50 })).items || []).filter(i => i.hint === 'action' && i.item_key);
      const pick = acts.find(i => /^play now$/i.test(i.title)) || acts.find(i => /^play/i.test(i.title)) || acts[0];
      if (pick) await core.browse({ ...hier(h), item_key: pick.item_key, zone_or_output_id: id });
      else L(`no play action offered for "${r.list.title}"`);
    } finally { await core.browse({ ...hier(h), pop_levels: 1 }); }
  }).catch(e => L(`play failed: ${e.message}`));

  // ---------------------------------------------------------------- search
  async function search(query) {
    const q = String(query || '').trim();
    if (!q) return placeholder('Search', 'Type something to search for');
    if (!core.ready()) return placeholder('Search', 'Waiting for Roon', 'Enable "MMS Emulator" in Roon > Settings > Extensions');
    const list = await serial(async () => {
      const r0 = await reset('search');
      let key;
      if (r0.action === 'list') key = (((await core.load({ ...hier('search'), offset: 0, count: 20 })).items || []).find(i => i.input_prompt && i.item_key) || {}).item_key;
      const r = await core.browse({ ...hier('search'), ...(key ? { item_key: key } : {}), input: q, zone_or_output_id: zoneId() });
      return r.action === 'list' ? r.list : null;
    });
    return list ? levelNode('search', list) : placeholder(`Search: ${q}`, 'No results');
  }

  // Library > <kind> in this slot's session, left open at that level (the letters node pops both levels when it is left)
  const libraryList = kind => serial(async () => {
    await reset('browse');
    const find = async re => ((await core.load({ ...hier('browse'), offset: 0, count: 100 })).items || []).find(i => i.item_key && re.test(i.title || ''));
    const lib = await find(/^library$/i); if (!lib) return null;
    if ((await core.browse({ ...hier('browse'), item_key: lib.item_key })).action !== 'list') return null;
    const it = await find(new RegExp(`^${kind}`, 'i'));
    if (!it) { await core.browse({ ...hier('browse'), pop_levels: 1 }); return null; }
    const r = await core.browse({ ...hier('browse'), item_key: it.item_key });
    if (r.action !== 'list') { await core.browse({ ...hier('browse'), pop_levels: 1 }); return null; }
    return r.list;
  });
  // first row whose bucket is >= `bucket`, by bisection (the list is alphabetical)
  async function lowerBound(list, bucket) {
    let lo = 0, hi = list.count; const want = BUCKETS.indexOf(bucket);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const row = ((await serial(() => core.load({ ...hier('browse'), level: list.level, offset: mid, count: 1 }))).items || [])[0];
      if (row && BUCKETS.indexOf(bucketOf(row.title)) < want) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  async function lettersNode(kind) {
    const list = await libraryList(kind);
    if (!list) return placeholder(`${kind} by letter`, 'Not available in this Roon library');
    const g = gen.browse;
    return { title: `${kind} by letter`, leave: () => serial(async () => { if (g === gen.browse) for (let i = 0; i < 2; i++) await core.browse({ ...hier('browse'), pop_levels: 1 }); }).catch(() => {}),
      items: [...BUCKETS].map((b, i) => ({ l1: b, open: async () => {
        const start = await lowerBound(list, b), end = i + 1 < BUCKETS.length ? await lowerBound(list, BUCKETS[i + 1]) : list.count, total = end - start;
        if (total <= 0) return placeholder(`${kind}: ${b}`, 'Nothing under this letter');
        return { title: `${kind}: ${b}`, count: async () => total,
          page: async (s, n) => ((await serial(() => core.load({ ...hier('browse'), level: list.level, offset: start + s, count: n }))).items || []).map(it => itemOf('browse', it)) };
      } })) };
  }
  const searchMenu = () => ({ title: 'Search', items: ['Artists', 'Albums', 'Tracks'].map(k => ({ l1: `${k} by letter`, open: () => lettersNode(k) })) });

  // ---------------------------------------------------------------- menus
  // the home node re-reads Roon's top level every time it is entered (also after a restart or once the extension is enabled)
  const home = () => ({
    title, functions: ['QuickList', 'BackToTop'],
    items: async () => {
      refresh();                                                    // the slot builds this menu before start(), so find the zone now
      if (!core.ready()) return waiting();
      const names = zone ? [] : core.zones().map(z => z.display_name);
      const notes = zone ? [] : [{ l1: `Roon zone "${zoneName}" not found`, l2: names.length ? `Zones: ${names.join(', ')}` : 'Roon reports no zones', play: () => {} }];
      if (!zone && names.length) log(`roon: zone "${zoneName}" not found; Roon has: ${names.join(', ')}`);
      const rows = await serial(async () => {
        const r = await reset('browse');
        return r.action === 'list' ? ((await core.load({ ...hier('browse'), offset: 0, count: 100 })).items || []) : [];
      });
      return [...notes, { l1: 'Search', open: searchMenu }, ...rows.map(i => itemOf('browse', i))];
    },
  });
  async function quickList() {
    const id = zoneId(); if (!id) return placeholder('Up Next', 'Roon zone not available');
    const items = await core.queue(id, 200).catch(e => { L(`queue failed: ${e.message}`); return null; });
    if (!items) return placeholder('Up Next', 'Queue not available - try again');
    return items.length ? { title: 'Up Next', items: items.map(q => ({ l1: line(q, 'three', 1) || line(q, 'one', 1), l2: line(q, 'three', 2), art: enc(q.image_key),
      play: () => core.playFromHere(id, q.queue_item_id).catch(e => L(`play from here failed: ${e.message}`)) })) } : placeholder('Up Next', 'The queue is empty');
  }

  return {
    providerName: 'Roon', player, home, quickList, search,
    async art(guid) {
      const k = dec(guid); if (!k) return null;
      try { const { type, body } = await core.image(k, { scale: 'fit', width: 500, height: 500, format: 'image/jpeg' }); return { type: type || 'image/jpeg', body }; } catch { return null; }
    },
    start() { refresh(); return Promise.resolve(); },
    close() { core.events.off('zones', refresh); core.events.off('paired', refresh); core.events.off('unpaired', refresh); },
  };
}

module.exports = { createRoonBackend };
