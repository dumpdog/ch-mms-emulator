'use strict';
// WiiM / LinkPlay player for one MMS slot (HTTP API: httpapi.asp?command=..., HTTPS with a self-signed certificate or plain HTTP).
//  - Browse: the WiiM has no library API, so the Home menu is the player's presets (set in the WiiM app; 6-20 slots)
//  - State: getPlayerStatus polled every second (+ getMetaInfo when the track changes for the art URL)
//  - Favorites button = the same presets list; there is no queue API, so no QuickList
// Backend contract: { providerName, home(): Node, favorites(): Node, player (EventEmitter, 'state' patches + control methods), art(guid) }.

const EventEmitter = require('events');
const http = require('http');
const https = require('https');

const enc = p => (p ? 'b' + Buffer.from(p).toString('base64url') : '');
const dec = g => (g && g[0] === 'b' ? Buffer.from(g.slice(1), 'base64url').toString() : '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Title/Artist/Album arrive hex-encoded from getPlayerStatus; missing values are "unknow", "unknown" or "un_known"
const unhex = s => {
  if (typeof s !== 'string' || !s || s.length % 2 || !/^[0-9a-f]+$/i.test(s)) return s || '';
  try { return Buffer.from(s, 'hex').toString('utf8'); } catch { return s; }
};
const clean = s => (/^un_?known?$/i.test(s || '') ? '' : s || '');
const SKIP_STEPS = [15, 20, 25, 30], SKIP_WINDOW_MS = 2000;
// loopmode: 0 repeat all, 1 repeat one, 2 shuffle + repeat all, 3 shuffle, 4 neither
const modesOf = n => ({ shuffle: n === 2 || n === 3 ? 1 : 0, repeat: n === 0 || n === 2 ? 2 : n === 1 ? 1 : 0 }); // MMS RepeatState: 2 all, 1 one, 0 off
const loopOf = (shuffle, repeat) => (repeat === 1 ? 1 : shuffle && repeat === 2 ? 2 : shuffle ? 3 : repeat === 2 ? 0 : 4);

function createWiimBackend({ playerUrl, name = 'MMS', log, pollMs = 1000, skipWindowMs = SKIP_WINDOW_MS }) {
  const host = playerUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  let scheme = /^http:/i.test(playerUrl) ? 'http' : /^https:/i.test(playerUrl) ? 'https' : null;   // null = try https, then http
  const player = new EventEmitter();
  const cur = {};                                  // last values emitted to the slot
  const s = { status: 'none', pos: 0, at: Date.now(), totlen: 0, loop: 4, key: '', plicurr: 0, plicount: 0, mode: -1, vol: 0 };
  let stopped = false, started = false, ready = null, ticker = null, timer = null, meta = { image: '', station: '' };

  // ---------------------------------------------------------------- HTTP (the device certificate is self-signed)
  function rawGet(sch, url, timeoutMs, binary) {
    return new Promise((resolve, reject) => {
      const mod = sch === 'https' ? https : http;
      const req = mod.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve({ res, body: Buffer.concat(chunks) })));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    }).then(r => (binary ? r : r.body.toString('utf8')));
  }
  async function detect() {
    for (const sch of scheme ? [scheme] : ['https', 'http']) {
      try { await rawGet(sch, `${sch}://${host}/httpapi.asp?command=getStatusEx`, 5000); scheme = sch; return; } catch { /* try the other */ }
    }
    throw new Error(`no WiiM/LinkPlay API answered at ${host}`);
  }
  const cmd = (c, t = 8000) => rawGet(scheme, `${scheme}://${host}/httpapi.asp?command=${c}`, t);
  async function json(c, t) {
    const x = await cmd(c, t);
    try { return JSON.parse(x); } catch { throw new Error(`${c.split(':')[0]}: not JSON (${x.slice(0, 40)})`); }
  }

  // ---------------------------------------------------------------- state -> slot
  function emit(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) if (!same(cur[k], v)) { cur[k] = v; out[k] = v; }
    if (Object.keys(out).length) player.emit('state', out);
  }
  const playing = () => s.status === 'play';
  const elapsed = () => {
    const e = s.pos + (playing() ? Date.now() - s.at : 0);
    return Math.floor((s.totlen ? Math.min(s.totlen, e) : e) / 1000);
  };

  async function poll() {
    const st = await json('getPlayerStatus');
    const status = st.status || 'none', totlen = Number(st.totlen) || 0, pos = Number(st.curpos);
    Object.assign(s, { status, pos: Number.isFinite(pos) && pos >= 0 ? pos : 0, at: Date.now(), totlen, loop: Number(st.loop), mode: Number(st.mode),
      plicurr: Number(st.plicurr) || 0, plicount: Number(st.plicount) || 0 });
    const title = clean(unhex(st.Title)), artist = clean(unhex(st.Artist)), album = clean(unhex(st.Album));
    const key = [title, artist, album, st.totlen, st.mode, st.plicurr].join('|');
    let m = null;
    if (key !== s.key) {                                         // new track/station: the art URL and a station name live in getMetaInfo
      s.key = key;
      try { m = (await json('getMetaInfo')).metaData || {}; } catch { m = {}; }
      meta = { image: m['albumArtURI '] || m.albumArtURI || '', station: clean(m.subtitle), title: clean(m.title), artist: clean(m.artist), album: clean(m.album) };
    }
    const t = meta.title || title, ar = meta.artist || artist || meta.station, al = meta.album || album || meta.station;
    const stream = totlen === 0, modes = modesOf(s.loop);
    const acts = ['Pause', 'Play', 'Stop', 'NextTrack', 'PreviousTrack'];
    if (!stream) acts.push('Seek', 'Ffwd', 'Rewind', 'Repeat', 'Shuffle');
    const patch = {
      PlayerState: status === 'play' ? 'playing' : status === 'pause' ? 'paused' : status === 'load' ? 'playing' : 'stopped',
      ElapsedSec: elapsed(), TrackSec: Math.floor(totlen / 1000), ShuffleState: modes.shuffle, RepeatState: modes.repeat,
    };
    if (t || ar) {
      Object.assign(patch, { Title: t, Artist: ar, Album: al, art: enc(meta.image) || '00000000-0000-0000-0000-000000000000',
        ActionsAvailable: acts.sort(), ProgressBar: !stream, StationName: stream ? meta.station : '' });
      if (!stream && s.plicount > 1) Object.assign(patch, { TrackNum: s.plicurr, TrackCnt: s.plicount, StationName: `Track ${s.plicurr} of ${s.plicount}` });
    } else if (cur.Title) {
      Object.assign(patch, { Title: '', Artist: '', Album: '', art: '00000000-0000-0000-0000-000000000000', ActionsAvailable: ['Play'], ProgressBar: false, StationName: '', TrackNum: 0, TrackCnt: 0 });
    }
    emit(patch);
  }
  const refresh = () => poll().catch(() => {});

  function init() {
    return ready || (ready = (async () => {
      try {
        await detect();
        try { const d = await json('getStatusEx'); log(`[wiim ${name}] "${d.DeviceName || ''}" (${d.project || d.hardware || '?'}) at ${scheme}://${host}`); } catch { /* optional */ }
        await poll();
        if (!started) {
          started = true;
          timer = setInterval(() => { if (!stopped) poll().catch(e => log(`[wiim ${name}] status poll: ${e.message}`)); }, pollMs); timer.unref();
          ticker = setInterval(() => { if (playing()) emit({ ElapsedSec: elapsed() }); }, 500); ticker.unref();
        }
      } catch (e) { ready = null; log(`[wiim ${name}] init failed: ${e.message}`); throw e; }
    })());
  }

  // ---------------------------------------------------------------- playback
  const run = c => async () => { await init(); await cmd(c); setTimeout(refresh, 300); };
  let skipRun = { dir: 0, n: 0, at: 0, pos: 0 };
  async function skip(dir) {
    await init();
    if (!s.totlen) return;
    const now = Date.now(), streak = dir === skipRun.dir && now - skipRun.at < skipWindowMs;
    const n = streak ? skipRun.n + 1 : 0, from = streak ? skipRun.pos : elapsed(), total = Math.floor(s.totlen / 1000);
    const to = Math.min(Math.max(0, total - 1), Math.max(0, from + dir * SKIP_STEPS[Math.min(n, SKIP_STEPS.length - 1)]));
    skipRun = { dir, n, at: now, pos: to };
    await cmd(`setPlayerCmd:seek:${to}`); Object.assign(s, { pos: to * 1000, at: Date.now() }); emit({ ElapsedSec: to }); setTimeout(refresh, 500);
  }

  Object.assign(player, {
    play: run('setPlayerCmd:resume'), pause: run('setPlayerCmd:pause'), stop: run('setPlayerCmd:stop'),
    next: run('setPlayerCmd:next'), prev: run('setPlayerCmd:prev'),
    async seek(p = {}) {
      const v = [p.sec, p.seconds, p.position, p.elapsedSec].find(Number.isFinite);
      if (v === undefined) return log(`[wiim ${name}] seek: unknown params ${JSON.stringify(p)}`);
      await init(); await cmd(`setPlayerCmd:seek:${Math.max(0, v | 0)}`); Object.assign(s, { pos: (v | 0) * 1000, at: Date.now() }); emit({ ElapsedSec: v | 0 });
    },
    async ffwd() { await skip(1); },
    async rewind() { await skip(-1); },
    async shuffle() { const v = cur.ShuffleState ? 0 : 1; emit({ ShuffleState: v }); await init(); await cmd(`setPlayerCmd:loopmode:${loopOf(v, cur.RepeatState || 0)}`); setTimeout(refresh, 300); },
    async repeat() {                                            // off -> one -> all
      const v = ((cur.RepeatState || 0) + 1) % 3; emit({ RepeatState: v }); await init();
      await cmd(`setPlayerCmd:loopmode:${loopOf(cur.ShuffleState || 0, v)}`); setTimeout(refresh, 300);
    },
  });

  // ---------------------------------------------------------------- browse = presets
  const placeholder = (title, text) => ({ title, items: [{ l1: text, play: () => {} }] });
  async function presets(title) {
    await init();
    const list = ((await json('getPresetInfo')).preset_list || []).filter(e => e && e.number && (e.name || e.url));
    return list.length
      ? { title, items: list.map(e => ({ l1: e.name || `Preset ${e.number}`, l2: e.source && !/^un_?known?$/i.test(e.source) ? e.source : '', art: enc(e.picurl),
          play: async () => { await cmd(`MCUKeyShortClick:${encodeURIComponent(e.number)}`); setTimeout(refresh, 800); } })), functions: ['Favorites', 'BackToTop'] }
      : placeholder(title, 'No presets set - add them in the WiiM app');
  }

  return {
    providerName: 'WiiM', player,
    home: () => presets('Home Menu'),
    favorites: () => presets('Favorites'),
    async art(guid) {
      const p = dec(guid); if (!p) return null;
      try {
        await init();
        const abs = /^https?:\/\//i.test(p) ? p : `${scheme}://${host}${p.startsWith('/') ? p : `/${p}`}`;
        const { res, body } = await rawGet(abs.startsWith('https') ? 'https' : 'http', abs, 10000, true);
        return { type: res.headers['content-type'] || 'image/jpeg', body };
      } catch { return null; }
    },
    start: init,
    close() { stopped = true; clearInterval(timer); clearInterval(ticker); },
  };
}

module.exports = { createWiimBackend };
