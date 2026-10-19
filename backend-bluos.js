'use strict';
// BluOS player browse + playback for one MMS slot (BluOS Custom Integration API v1.7, HTTP+XML on :11000).
//  - Browse: /Browse?key=... (top level = the player's own sources, inputs, playlists and services), paged by nextKey
//  - State: /Status long-poll (etag); the position is advanced locally once a second while playing
//  - Favorites button = the player's presets, QuickList button = the play queue
// Backend contract: { providerName, home(): Node, player (EventEmitter, 'state' patches + control methods), art(guid) }.

const EventEmitter = require('events');

const unesc = s => String(s ?? '').replace(/&(lt|gt|amp|quot|apos|#39);/g, (_, c) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" }[c]));
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? unesc(m[1].trim()) : undefined; };
const attrs = s => { const o = {}; for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = unesc(m[2]); return o; };
const rootAttrs = (xml, name) => { const m = xml.match(new RegExp(`<${name}\\b([^>]*)>`)); return m ? attrs(m[1]) : {}; };
const elements = (xml, name) => [...xml.matchAll(new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'g'))].map(m => ({ a: attrs(m[1]), body: m[2] || '' }));
const enc = p => (p ? 'b' + Buffer.from(p).toString('base64url') : '');
const dec = g => (g && g[0] === 'b' ? Buffer.from(g.slice(1), 'base64url').toString() : '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SKIP_STEPS = [15, 20, 25, 30], SKIP_WINDOW_MS = 2000, MAX_ITEMS = 1000, QUEUE_WINDOW = 200;

function createBluosBackend({ playerUrl, name = 'MMS', log, pollMs = 1000, skipWindowMs = SKIP_WINDOW_MS }) {
  let base = playerUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  if (!/:\d+$/.test(base.replace(/^https?:\/\//i, ''))) base += ':11000';
  const player = new EventEmitter();
  const cur = {};                                   // last values emitted to the slot
  const s = { state: 'stop', secs: 0, at: Date.now(), totlen: 0, canSeek: false, stream: false, actions: {}, song: -1, pid: '', prid: '', title: '' };
  let stopped = false, started = false, ready = null, ticker = null, queueLen = 0;

  // ---------------------------------------------------------------- HTTP
  const abs = u => new URL(u, base + '/').toString();
  async function get(path, timeoutMs = 10000) {
    const r = await fetch(/^https?:\/\//i.test(path) ? path : abs(path), { signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.text();
    if (!r.ok) throw new Error(`bluos ${path.split('?')[0]} -> HTTP ${r.status}`);
    if (/^\s*<error\b/.test(body)) throw new Error(`bluos ${path.split('?')[0]} -> ${tag(body, 'message') || tag(body, 'detail') || 'error'}`);
    return body;
  }
  const key = k => `/Browse?key=${encodeURIComponent(k)}`;

  // ---------------------------------------------------------------- state -> slot
  function emit(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) if (!same(cur[k], v)) { cur[k] = v; out[k] = v; }
    if (Object.keys(out).length) player.emit('state', out);
  }
  const elapsed = () => Math.min(s.totlen || Infinity, Math.floor(s.secs + (s.state === 'play' || s.state === 'stream' ? (Date.now() - s.at) / 1000 : 0)));
  const ratingOf = v => ({ current: v, max: 1, system: 1 });

  async function applyStatus(x) {
    const st = tag(x, 'state') || 'stop';
    Object.assign(s, { state: st, secs: Number(tag(x, 'secs')) || 0, at: Date.now(), totlen: Number(tag(x, 'totlen')) || 0, canSeek: tag(x, 'canSeek') === '1',
      stream: x.includes('<streamUrl'), song: Number(tag(x, 'song') ?? -1) });
    s.actions = {}; for (const a of elements(x, 'action')) if (a.a.name) s.actions[a.a.name] = a.a.url || true;
    const title = tag(x, 'title1') || tag(x, 'name') || '', artist = tag(x, 'title2') || tag(x, 'artist') || '', album = tag(x, 'title3') || tag(x, 'album') || '';
    const trackId = [title, artist, album, tag(x, 'fn'), s.song].join('|');
    const rep = tag(x, 'repeat'), pid = tag(x, 'pid') || '', prid = tag(x, 'prid') || '';
    const acts = ['Pause', 'Play', 'Stop', 'NextTrack', 'PreviousTrack'];
    if (s.canSeek && s.totlen) acts.push('Seek', 'Ffwd', 'Rewind');
    if (!s.stream) acts.push('Repeat', 'Shuffle');
    if (s.actions.love) acts.push('ThumbsUp');
    if (s.actions.ban) acts.push('ThumbsDown');
    const patch = {
      PlayerState: st === 'play' || st === 'stream' || st === 'connecting' ? 'playing' : st === 'pause' ? 'paused' : 'stopped',
      ElapsedSec: elapsed(), TrackSec: s.totlen, ShuffleState: tag(x, 'shuffle') === '1' ? 1 : 0,
      RepeatState: rep === '1' ? 1 : rep === '0' ? 2 : 0,                       // BluOS: 0 queue, 1 track, 2 off  ->  MMS: 2 all, 1 one, 0 off
    };
    if (title || artist) {
      Object.assign(patch, { Title: title, Artist: artist, Album: album, art: enc(tag(x, 'image')) || '00000000-0000-0000-0000-000000000000',
        ActionsAvailable: acts.sort(), ProgressBar: s.totlen > 0, StationName: s.stream ? (tag(x, 'serviceName') || tag(x, 'service') || '') : '' });
      if (trackId !== s.title) { patch.Rating = ratingOf(0); s.title = trackId; }
    } else if (cur.Title) {
      Object.assign(patch, { Title: '', Artist: '', Album: '', art: '00000000-0000-0000-0000-000000000000', ActionsAvailable: ['Play'], ProgressBar: false, StationName: '', TrackNum: 0, TrackCnt: 0 });
    }
    if (!s.stream && (title || artist)) {
      if (pid !== s.pid) { s.pid = pid; queueLen = Number((await get('/Playlist?length=1').then(p => tag(p, 'length')).catch(() => 0)) || 0); }
      if (queueLen) Object.assign(patch, { TrackNum: s.song + 1, TrackCnt: queueLen, StationName: `Track ${s.song + 1} of ${queueLen}` });
    }
    if (prid) s.prid = prid;
    emit(patch);
  }

  async function longPoll() {
    let etag = '';
    while (!stopped) {
      try {
        const x = await get(`/Status?timeout=100${etag ? `&etag=${encodeURIComponent(etag)}` : ''}`, 120000);
        await applyStatus(x); etag = rootAttrs(x, 'status').etag || '';
      } catch (e) { if (!stopped) { log(`[bluos ${name}] status poll: ${e.message}; retry in 5 s`); await new Promise(r => setTimeout(r, 5000)); } etag = ''; }
    }
  }
  const refresh = () => get('/Status').then(applyStatus).catch(() => {});

  function init() {
    return ready || (ready = (async () => {
      try {
        const sync = rootAttrs(await get('/SyncStatus'), 'SyncStatus');
        log(`[bluos ${name}] "${sync.name || ''}" (${sync.modelName || sync.model || '?'}) at ${base}`);
        await applyStatus(await get('/Status'));
        if (!started) {
          started = true; longPoll();
          ticker = setInterval(() => { if (s.state === 'play' || s.state === 'stream') emit({ ElapsedSec: elapsed() }); }, pollMs); ticker.unref();
        }
      } catch (e) { ready = null; log(`[bluos ${name}] init failed: ${e.message}`); throw e; }
    })());
  }

  // ---------------------------------------------------------------- playback
  const cmd = path => async () => { await init(); await get(path); setTimeout(refresh, 300); };
  let skipRun = { dir: 0, n: 0, at: 0, pos: 0 };
  async function skip(dir) {
    await init();
    if (!s.canSeek || !s.totlen) return;
    const now = Date.now(), streak = dir === skipRun.dir && now - skipRun.at < skipWindowMs;
    const n = streak ? skipRun.n + 1 : 0, from = streak ? skipRun.pos : elapsed();
    const to = Math.min(Math.max(0, s.totlen - 1), Math.max(0, from + dir * SKIP_STEPS[Math.min(n, SKIP_STEPS.length - 1)]));
    skipRun = { dir, n, at: now, pos: to };
    await get(`/Play?seek=${to}`); Object.assign(s, { secs: to, at: Date.now() }); emit({ ElapsedSec: to }); setTimeout(refresh, 500);
  }
  async function action(which) { // love / ban on services that offer them
    await init();
    const u = s.actions[which]; if (typeof u !== 'string') return false;
    await get(u); return true;
  }

  Object.assign(player, {
    play: cmd('/Play'), pause: cmd('/Pause'), stop: cmd('/Stop'),
    async next() { await init(); await get(s.stream && typeof s.actions.skip === 'string' ? s.actions.skip : '/Skip'); setTimeout(refresh, 400); },
    async prev() { await init(); await get(s.stream && typeof s.actions.back === 'string' ? s.actions.back : '/Back'); setTimeout(refresh, 400); },
    async seek(p = {}) {
      const v = [p.sec, p.seconds, p.position, p.elapsedSec].find(Number.isFinite);
      if (v === undefined) return log(`[bluos ${name}] seek: unknown params ${JSON.stringify(p)}`);
      await init(); await get(`/Play?seek=${Math.max(0, v | 0)}`); Object.assign(s, { secs: v | 0, at: Date.now() }); emit({ ElapsedSec: v | 0 });
    },
    async ffwd() { await skip(1); },
    async rewind() { await skip(-1); },
    async shuffle() { const v = cur.ShuffleState ? 0 : 1; emit({ ShuffleState: v }); await init(); await get(`/Shuffle?state=${v}`); setTimeout(refresh, 300); },
    async repeat() {           // off -> one -> all
      const v = ((cur.RepeatState || 0) + 1) % 3; emit({ RepeatState: v }); await init();
      await get(`/Repeat?state=${v === 1 ? 1 : v === 2 ? 0 : 2}`); setTimeout(refresh, 300);
    },
    async thumbsUp() { if (await action('love')) emit({ Rating: ratingOf(1) }); },
    async thumbsDown() { if (await action('ban')) emit({ Rating: ratingOf(-1) }); },
  });

  // ---------------------------------------------------------------- browse tree
  const choose = (title, ...entries) => ({ title, items: entries.map(([l1, fn]) => ({ l1, play: fn })), functions: ['QuickList', 'Favorites', 'BackToTop'] });
  const act = url => async () => { await get(url); setTimeout(refresh, 500); };

  // follow nextKey up to MAX_ITEMS; a response is either <item>s or <category>s holding <item>s
  async function loadBrowse(k) {
    const items = []; let next = k, top = k === '';
    while ((next || top) && items.length < MAX_ITEMS) {
      const x = await get(top ? '/Browse' : key(next)); top = false;
      items.push(...elements(x, 'item').map(i => i.a));
      next = rootAttrs(x, 'browse').nextKey || '';
    }
    return items.slice(0, MAX_ITEMS);
  }
  const mk = a => {
    const playUrl = a.type === 'track' && a.autoplayURL ? a.autoplayURL : a.playURL || a.autoplayURL;
    const it = { l1: a.text || '', l2: a.text2 || '', art: enc(a.image) };
    if (a.browseKey) it.open = () => browseNode(a.text, a.browseKey);
    else if (playUrl) it.play = act(playUrl);
    else it.play = () => {};
    if (a.contextMenuKey || playUrl) it.context = async () => {
      const entries = [];
      if (playUrl) entries.push(['Play now', act(playUrl)]);
      if (a.contextMenuKey) {
        try { for (const c of elements(await get(key(a.contextMenuKey)), 'item')) if (c.a.actionURL && c.a.text) entries.push([c.a.text, act(c.a.actionURL)]); }
        catch (e) { log(`[bluos ${name}] context menu: ${e.message}`); }
      }
      return choose(a.text || 'Options', ...(entries.length ? entries : [['Nothing to do', () => {}]]));
    };
    return it;
  };
  const browseNode = (title, k) => ({ title: title || 'Browse', items: async () => { await init(); const l = await loadBrowse(k); return l.length ? l.map(mk) : [{ l1: 'Empty', play: () => {} }]; } });

  const placeholder = (title, text) => ({ title, items: [{ l1: text, play: () => {} }] });
  async function favorites() { // the player's presets
    await init();
    const p = elements(await get('/Presets'), 'preset');
    return p.length ? { title: 'Favorites', items: p.map(e => ({ l1: e.a.name || `Preset ${e.a.id}`, art: enc(e.a.image), play: act(`/Preset?id=${encodeURIComponent(e.a.id)}`) })) }
      : placeholder('Favorites', 'No presets set on this player');
  }
  async function quickList() { // the play queue
    await init();
    if (s.stream) return placeholder('Up Next', 'Streaming - no queue');
    const total = Number(tag(await get('/Playlist?length=1'), 'length') || 0);
    if (!total) return placeholder('Up Next', 'Queue is empty');
    const first = Math.max(0, s.song - 5), last = Math.min(total - 1, first + QUEUE_WINDOW - 1);
    const songs = elements(await get(`/Playlist?start=${first}&end=${last}`), 'song');
    return { title: 'Up Next', items: songs.map(e => {
      const id = Number(e.a.id), artist = tag(e.body, 'art') || '';
      return { l1: tag(e.body, 'title') || '', l2: id === s.song ? `Now playing - ${artist}` : artist, play: act(`/Play?seek=0&id=${id}`) };
    }) };
  }

  return {
    providerName: 'BluOS', favorites, quickList,
    async home() { await init(); return browseNode('Home Menu', ''); },
    player,
    async art(guid) {
      const p = dec(guid); if (!p) return null;
      const u = /^https?:\/\//i.test(p) ? p : abs(p);
      const r = await fetch(u + (u.includes('/Artwork') ? (u.includes('?') ? '&' : '?') + 'followRedirects=1' : ''), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      return { type: r.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
    },
    start: init,
    close() { stopped = true; clearInterval(ticker); },
  };
}

module.exports = { createBluosBackend };
