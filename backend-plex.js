'use strict';
// Plex library browse + Plexamp playback for one MMS slot.
//  - Browse / metadata / ratings: Plex Media Server HTTP API
//  - Playback control + state: Plexamp (headless) Plex Companion HTTP API, polled once per 1.5 s
// The Plex token only goes to the Plex server and Plexamp, never into URLs handed to Crestron (art goes through our /getart).
// Backend contract: { providerName, home(): Node, player (EventEmitter, 'state' patches + control methods), art(guid) }.

const EventEmitter = require('events');

const ARTPATH = /^\/(library\/metadata|playlists)\/\d+\/(thumb|composite|art)(\/\d+)?$/;
const attrs = tag => { const o = {}; for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; };
const enc = p => (p && ARTPATH.test(p) ? 'p' + Buffer.from(p).toString('base64url') : '');
const dec = g => (g && g[0] === 'p' ? Buffer.from(g.slice(1), 'base64url').toString() : '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ACTIONS = ['Ffwd', 'NextTrack', 'Pause', 'Play', 'PlayAll', 'PreviousTrack', 'Repeat', 'Rewind', 'Seek', 'Shuffle', 'Stop', 'ThumbsDown', 'ThumbsUp'];
// Ffwd / Rewind each arrive as one call per tap or hold (no repeat, no release), so they skip instead of scanning.
// Presses in the same direction within SKIP_WINDOW_MS grow the skip: 15, 20, 25, 30, 30... seconds.
const SKIP_STEPS = [15, 20, 25, 30], SKIP_WINDOW_MS = 2000;

function createPlexBackend({ plexUrl, token, plexampUrl, name = 'MMS', log, pollMs = 1500, skipWindowMs = SKIP_WINDOW_MS }) {
  plexUrl = plexUrl.replace(/\/$/, ''); plexampUrl = plexampUrl.replace(/\/$/, '');
  const clientId = `mms-emulator-${name.replace(/\W+/g, '-').toLowerCase()}`;
  const player = new EventEmitter();
  const cur = {};                         // last values emitted to the slot
  let serverId = null, ampId = null, section = null, cmd = 0, rk = null, ready = null, timer = null;
  const meta = new Map(), artCache = new Map();
  let queue = null;                       // current Plex play queue per the last Plexamp timeline

  // ---------------------------------------------------------------- HTTP
  async function plex(path, method = 'GET') {
    const r = await fetch(`${plexUrl}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${token}`, {
      method, headers: { Accept: 'application/json', 'X-Plex-Client-Identifier': clientId, 'X-Plex-Product': 'MMS emulator' }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`plex ${method} ${path.split('?')[0]} -> ${r.status}`);
    return r.status === 204 ? {} : r.json().catch(() => ({}));
  }
  async function amp(action, params = {}, timeoutMs = 8000) {
    const q = new URLSearchParams({ ...params, commandID: String(++cmd) });
    const r = await fetch(`${plexampUrl}/player/${action}?${q}`, {
      headers: { 'X-Plex-Client-Identifier': clientId, 'X-Plex-Device-Name': 'MMS emulator', 'X-Plex-Target-Client-Identifier': ampId || '' }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`plexamp ${action} -> ${r.status}`);
    return r.text();
  }
  const page = async (path, start, n) => {
    const r = (await plex(`${path}${path.includes('?') ? '&' : '?'}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${n}`)).MediaContainer || {};
    return { total: r.totalSize ?? r.size ?? 0, items: r.Metadata || [] };
  };

  function init() {
    return ready || (ready = (async () => {
      try {
        serverId = (await plex('/identity')).MediaContainer.machineIdentifier;
        ampId = ((await (await fetch(`${plexampUrl}/resources`, { signal: AbortSignal.timeout(8000) })).text()).match(/machineIdentifier="([^"]+)"/) || [])[1];
        const dirs = (await plex('/library/sections')).MediaContainer.Directory || [];
        section = (dirs.find(d => d.type === 'artist') || {}).key;
        log(`[plex ${name}] server ${serverId} | plexamp ${ampId} | music section ${section}`);
        if (!timer) { timer = setInterval(() => poll().catch(() => {}), pollMs); timer.unref(); }
      } catch (e) { ready = null; log(`[plex ${name}] init failed: ${e.message}`); throw e; }
    })());
  }

  // ---------------------------------------------------------------- state -> slot
  function emit(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) if (!same(cur[k], v)) { cur[k] = v; out[k] = v; }
    if (Object.keys(out).length) player.emit('state', out);
  }
  const ratingOf = r => ({ current: r >= 8 ? 1 : r > 0 && r <= 2 ? -1 : 0, max: 1, system: 1 });

  async function loadMeta(key) {
    if (meta.has(key)) return meta.get(key);
    const m = ((await plex(`/library/metadata/${key}`)).MediaContainer.Metadata || [])[0];
    if (!m) return null;
    const v = { title: m.title, artist: m.grandparentTitle || '', album: m.parentTitle || '', rating: Number(m.userRating || 0),
      thumb: m.thumb || m.parentThumb || m.grandparentThumb || '' };
    meta.set(key, v); if (meta.size > 300) meta.delete(meta.keys().next().value);
    return v;
  }

  async function poll() {
    const xml = await amp('timeline/poll', { wait: '0' });
    const t = [...xml.matchAll(/<Timeline\b([^>]*)\/?>/g)].map(m => attrs(m[1])).find(a => a.type === 'music') || {};
    const patch = {
      PlayerState: t.state === 'playing' || t.state === 'buffering' ? 'playing' : t.state === 'paused' ? 'paused' : 'stopped',
      ElapsedSec: Math.floor(Number(t.time || 0) / 1000), TrackSec: Math.floor(Number(t.duration || 0) / 1000),
      ShuffleState: t.shuffle === '1' ? 1 : 0, RepeatState: Number(t.repeat || 0),
    };
    queue = t.playQueueID ? { id: t.playQueueID, item: t.playQueueItemID } : null;
    if (t.shuffle !== cur._tlShuffle || t.repeat !== cur._tlRepeat) {
      log(`[plex ${name}] timeline shuffle=${t.shuffle} repeat=${t.repeat} state=${t.state}`);
      cur._tlShuffle = t.shuffle; cur._tlRepeat = t.repeat;
    }
    if (t.ratingKey && t.ratingKey !== rk) {
      rk = t.ratingKey;
      const m = await loadMeta(rk);
      if (m) {
        Object.assign(patch, { Title: m.title, Artist: m.artist, Album: m.album, art: enc(m.thumb) || '00000000-0000-0000-0000-000000000000',
          Rating: ratingOf(m.rating), ProgressBar: true, ActionsAvailable: ACTIONS, TrackNum: 0, TrackCnt: 0, StationName: '' });
        if (t.playQueueID) {
          try {
            const q = (await plex(`/playQueues/${t.playQueueID}?own=1&window=1&center=${t.playQueueItemID}`)).MediaContainer;
            const n = Number(q.playQueueSelectedItemOffset || 0) + 1, total = Number(q.playQueueTotalCount || 0);
            Object.assign(patch, { TrackNum: n, TrackCnt: total, StationName: `Track ${n} of ${total}` });
          } catch {}
        }
      }
    }
    emit(patch);
  }

  // ---------------------------------------------------------------- playback
  async function playKeyNow(key, { shuffle = false, startKey } = {}) {
    const t0 = Date.now();
    await init();
    const uri = `server://${serverId}/com.plexapp.plugins.library${key}`;
    let qs = `type=audio&uri=${encodeURIComponent(uri)}&shuffle=${shuffle ? 1 : 0}&repeat=0&continuous=0&own=1`;
    if (startKey) qs += `&key=${encodeURIComponent(startKey)}`;
    const pq = (await plex(`/playQueues?${qs}`, 'POST')).MediaContainer;
    const t1 = Date.now();
    const first = startKey || ((pq.Metadata || [])[0] || {}).key;
    if (!first) throw new Error('empty play queue');
    const u = new URL(plexUrl);
    await amp('playback/playMedia', {
      type: 'music', providerIdentifier: 'com.plexapp.plugins.library', key: first, offset: '0', machineIdentifier: serverId,
      address: u.hostname, port: u.port || '32400', protocol: u.protocol.replace(':', ''),
      containerKey: `/playQueues/${pq.playQueueID}?own=1&window=200&includeBoundaries=1`, token,
    }, 25000);
    log(`[plex ${name}] playing ${key}${startKey ? ' from ' + startKey : ''}${shuffle ? ' shuffled' : ''} (${pq.playQueueTotalCount} items) - plex queue ${t1 - t0} ms, plexamp playMedia ${Date.now() - t1} ms`);
    emit({ PlayerState: 'playing' });
    for (const ms of [300, 900, 1800]) setTimeout(() => poll().catch(() => {}), ms);
  }
  // the menu answers Crestron Home straight away; the queue build and Plexamp's (possibly slow) reply happen in the background
  const playKey = (key, opts) => { playKeyNow(key, opts).catch(e => log(`[plex ${name}] play ${key} failed: ${e.message}`)); };
  // add to the running queue (after the current track, or at the end); with nothing playing, just start it
  async function enqueue(key, next) {
    await init(); await poll().catch(() => {});
    if (!queue) return playKeyNow(key);
    const uri = `server://${serverId}/com.plexapp.plugins.library${key}`;
    await plex(`/playQueues/${queue.id}?uri=${encodeURIComponent(uri)}&next=${next ? 1 : 0}`, 'PUT');
    await amp('playback/refreshPlayQueue', { type: 'music', playQueueID: String(queue.id) });
    log(`[plex ${name}] queued ${key} ${next ? 'next' : 'last'}`);
  }
  const enq = (key, next) => { enqueue(key, next).catch(e => log(`[plex ${name}] queue ${key} failed: ${e.message}`)); };
  const kick = () => setTimeout(() => poll().catch(() => {}), 500);
  const cmdp = a => async () => { await init(); await amp(a, { type: 'music' }); kick(); };

  async function rate(value) {
    if (!rk) return;
    await plex(`/:/rate?key=${rk}&identifier=com.plexapp.plugins.library&rating=${value}`, 'PUT');
    const m = meta.get(rk); if (m) m.rating = Math.max(0, value);
    emit({ Rating: ratingOf(Math.max(0, value)) });
  }

  let skipRun = { dir: 0, n: 0, at: 0, pos: 0 };
  async function skip(dir) {
    await init();
    const now = Date.now(), streak = dir === skipRun.dir && now - skipRun.at < skipWindowMs;
    const n = streak ? skipRun.n + 1 : 0, base = streak ? skipRun.pos : (cur.ElapsedSec || 0);   // our own position while streaking: Plexamp lags
    const max = Math.max(0, (cur.TrackSec || 0) - 1), to = Math.min(max, Math.max(0, base + dir * SKIP_STEPS[Math.min(n, SKIP_STEPS.length - 1)]));
    skipRun = { dir, n, at: now, pos: to };
    await amp('playback/seekTo', { type: 'music', offset: String(to * 1000) });
    emit({ ElapsedSec: to }); kick();
  }

  Object.assign(player, {
    play: cmdp('playback/play'), pause: cmdp('playback/pause'), stop: cmdp('playback/stop'),
    next: cmdp('playback/skipNext'), prev: cmdp('playback/skipPrevious'),
    async seek(p = {}) {
      const s = [p.sec, p.seconds, p.position, p.elapsedSec].find(Number.isFinite);
      if (s === undefined) return log(`[plex ${name}] seek: unknown params ${JSON.stringify(p)}`);
      await init(); await amp('playback/seekTo', { type: 'music', offset: String(Math.max(0, s * 1000 | 0)) }); kick();
    },
    // optimistic: apply our own change to the state straight away so rapid presses cycle in order; the next poll corrects it
    async ffwd() { await skip(1); },
    async rewind() { await skip(-1); },
    async shuffle() { const v = cur.ShuffleState ? 0 : 1; emit({ ShuffleState: v }); await init(); await amp('playback/setParameters', { type: 'music', shuffle: String(v) }); kick(); },
    async repeat() { const v = ((cur.RepeatState || 0) + 1) % 3; emit({ RepeatState: v }); await init(); await amp('playback/setParameters', { type: 'music', repeat: String(v) }); kick(); },
    // Plexamp: like = 5 stars (10), dislike = 1 star (2); pressing the active one again clears the rating.
    async thumbsUp() { await init(); await rate((meta.get(rk) || {}).rating >= 8 ? -1 : 10); },
    async thumbsDown() { await init(); const r = (meta.get(rk) || {}).rating; await rate(r > 0 && r <= 2 ? -1 : 2); },
  });

  // ---------------------------------------------------------------- browse tree
  const item = (m, extra) => ({ l1: m.title, l2: m.grandparentTitle || m.parentTitle || '', art: enc(m.thumb || m.composite || m.parentThumb || m.grandparentThumb), ...extra });
  const choose = (title, ...entries) => ({ title, items: entries.map(([l1, fn]) => ({ l1, play: fn })), functions: ['QuickList', 'Favorites', 'BackToTop'] });
  // long-press menu for one item: the extra entries, plus "Play next" / "Add to queue" (also behind the plus button)
  const choose2 = (title, key, ...entries) => {
    const node = choose(title, ...entries, ['Play next', () => enq(key, true)], ['Add to queue', () => enq(key, false)]);
    node.functions = ['QuickList', 'Favorites', 'Create', 'BackToTop']; node.create = () => enq(key, false);
    return node;
  };
  const paged = (title, path, mk, max) => ({
    title,
    count: async () => { await init(); const { total } = await page(path, 0, 0); return max ? Math.min(total, max) : total; },
    page: async (start, n) => (await page(path, start, n)).items.map(mk),
  });

  // a container whose children are tracks: album, playlist
  const trackList = (m, containerKey, childrenPath) => paged(m.title, childrenPath, t => item(t, {
    play: () => playKey(containerKey, { startKey: t.key }),
    context: () => choose2(t.title, t.key, ['Play now', () => playKey(containerKey, { startKey: t.key })], [`Play ${m.type === 'playlist' ? 'playlist' : 'album'} from start`, () => playKey(containerKey)],
      ['Shuffle', () => playKey(containerKey, { shuffle: true })]),
  }));
  const albumItem = a => item(a, { open: () => trackList(a, `/library/metadata/${a.ratingKey}`, `/library/metadata/${a.ratingKey}/children`),
    context: () => choose2(a.title, `/library/metadata/${a.ratingKey}`, ['Play album', () => playKey(`/library/metadata/${a.ratingKey}`)], ['Shuffle album', () => playKey(`/library/metadata/${a.ratingKey}`, { shuffle: true })]) });
  const artistItem = a => item(a, { open: () => paged(a.title, `/library/metadata/${a.ratingKey}/children`, albumItem),
    context: () => choose2(a.title, `/library/metadata/${a.ratingKey}`, ['Play all', () => playKey(`/library/metadata/${a.ratingKey}`)], ['Shuffle all', () => playKey(`/library/metadata/${a.ratingKey}`, { shuffle: true })]) });
  const playlistItem = p => item(p, { open: () => trackList({ ...p, type: 'playlist' }, `/playlists/${p.ratingKey}`, `/playlists/${p.ratingKey}/items`),
    context: () => choose2(p.title, `/playlists/${p.ratingKey}`, ['Play playlist', () => playKey(`/playlists/${p.ratingKey}`)], ['Shuffle playlist', () => playKey(`/playlists/${p.ratingKey}`, { shuffle: true })]) });
  const songItem = t => item(t, { play: () => playKey(`/library/metadata/${t.ratingKey}`), context: () => choose2(t.title, `/library/metadata/${t.ratingKey}`, ['Play now', () => playKey(`/library/metadata/${t.ratingKey}`)]) });

  const lib = sub => `/library/sections/${section}/${sub}`;
  const myMusic = () => ({ title: 'My Music', items: [
    { l1: 'Playlists', open: () => paged('Playlists', '/playlists?playlistType=audio', playlistItem) },
    { l1: 'Albums', open: () => paged('Albums', lib('albums?sort=titleSort'), albumItem) },
    { l1: 'Artists', open: () => paged('Artists', lib('all?type=8&sort=titleSort'), artistItem) },
    { l1: 'Recently Added', open: () => paged('Recently Added', lib('albums?sort=addedAt:desc'), albumItem, 100) },
    { l1: 'Recently Played', open: () => paged('Recently Played', lib('albums?sort=lastViewedAt:desc'), albumItem, 100) },
    { l1: 'Songs', open: () => paged('Titles', lib('all?type=10&sort=titleSort'), songItem) },
    { l1: 'Search', open: () => searchMenu() },
  ] });

  // Crestron Home has no text entry, so "search" is a first-letter jump: kind -> letter -> matching items.
  // Plex's firstCharacter index lists the letters that exist (with counts); if it is unavailable, offer # and A-Z.
  const SEARCH_KINDS = [['Artists', 8, artistItem], ['Albums', 9, albumItem], ['Songs', 10, songItem]];
  const searchMenu = () => ({ title: 'Search', items: SEARCH_KINDS.map(([l1, type, mk]) => ({ l1: `${l1} by letter`, open: () => lettersMenu(l1, type, mk) })) });
  async function lettersMenu(kind, type, mk) {
    let letters = [];
    try { letters = ((await plex(lib(`firstCharacter?type=${type}`))).MediaContainer.Directory || []).filter(d => d.key).map(d => ({ key: d.key, title: d.title || d.key.toUpperCase(), size: Number(d.size) || 0 })); }
    catch (e) { log(`[plex ${name}] firstCharacter index failed: ${e.message}`); }
    if (!letters.length) letters = [...'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(c => ({ key: c.toLowerCase(), title: c, size: 0 }));
    return { title: `${kind} by letter`, items: letters.map(l => ({
      l1: l.title, l2: l.size ? `${l.size} ${l.size === 1 ? 'item' : 'items'}` : '',
      open: () => paged(`${kind}: ${l.title}`, lib(`firstCharacter/${encodeURIComponent(l.key)}?type=${type}&sort=titleSort`), mk),
    })) };
  }

  // Favorites button: tracks rated thumbs-up (8+). QuickList button: the current play queue ("up next"), jump on select.
  const placeholder = (title, text) => ({ title, items: [{ l1: text, play: () => {} }] });
  async function favorites() {
    await init();
    const path = lib('all?type=10&userRating>>=8&sort=lastRatedAt:desc');
    // Plex ties a rating to the track's GUID, so the same recording on several albums is rated (and listed) together: show it once
    const seen = new Set(), tracks = (await page(path, 0, 300)).items.filter(tr => { const g = tr.guid || tr.ratingKey; return seen.has(g) ? false : seen.add(g); });
    return tracks.length ? { title: 'Favorites', items: tracks.map(tr => ({ ...songItem(tr), l2: [tr.grandparentTitle, tr.parentTitle].filter(Boolean).join(' - ') })) } : placeholder('Favorites', 'No liked tracks yet (use thumbs up)');
  }
  async function quickList() {
    await init();
    await poll().catch(() => {});                       // our idea of the queue can be a second stale right after a new play
    if (!queue) return placeholder('Up Next', 'Nothing playing');
    const fetchQ = () => plex(`/playQueues/${queue.id}?own=1&window=200&center=${queue.item}`).then(r => r.MediaContainer);
    let q;
    try { q = await fetchQ(); }
    catch { await new Promise(r => setTimeout(r, 800)); await poll().catch(() => {}); if (!queue) return placeholder('Up Next', 'Nothing playing'); q = await fetchQ().catch(() => null); }
    if (!q) return placeholder('Up Next', 'Queue not available yet - try again');
    const playing = String(queue.item);
    return { title: 'Up Next', items: (q.Metadata || []).map(t => item(t, {
      l2: String(t.playQueueItemID) === playing ? `Now playing - ${t.grandparentTitle || ''}` : t.grandparentTitle || '',
      play: async () => { await amp('playback/skipTo', { type: 'music', key: t.key, playQueueItemID: String(t.playQueueItemID) }); kick(); },
    })) };
  }

  return {
    providerName: 'Plex', favorites, quickList,
    async home() { await init(); return { title: 'Home Menu', items: [{ l1: 'My Music', open: myMusic }] }; },
    player,
    async art(guid) {
      const p = dec(guid); if (!p) return null;
      if (artCache.has(p)) return artCache.get(p);
      const r = await fetch(`${plexUrl}/photo/:/transcode?width=300&height=300&minSize=1&upscale=1&format=png&url=${encodeURIComponent(p)}&X-Plex-Token=${token}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const v = { type: r.headers.get('content-type') || 'image/png', body: Buffer.from(await r.arrayBuffer()) };
      artCache.set(p, v); if (artCache.size > 300) artCache.delete(artCache.keys().next().value);
      return v;
    },
    start: init,
    close() { clearInterval(timer); },
  };
}

module.exports = { createPlexBackend };
