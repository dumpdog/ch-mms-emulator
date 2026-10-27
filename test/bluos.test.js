'use strict';
// BluOS backend against a mock BluOS player (just enough of API v1.7: Status long-poll, Browse, Presets, Playlist, transport).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createBluosBackend } = require('../backend-bluos');
const { Menu } = require('../menu');

const wait = (cond, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() { const v = cond(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('timeout: ' + cond)); setTimeout(poll, 10); })();
});

function mock() {
  const calls = []; let version = 1; const waiters = [];
  const st = { state: 'stop', secs: 0, title1: '', title2: '', title3: '', totlen: 0, song: 0, shuffle: 0, repeat: 2, pid: 7, actions: '' };
  const status = () => `<status etag="v${version}"><canMovePlayback>true</canMovePlayback>${st.totlen ? '<canSeek>1</canSeek>' : ''}<image>/Artwork?service=Local&amp;id=1</image>` +
    `<pid>${st.pid}</pid><prid>3</prid><repeat>${st.repeat}</repeat><shuffle>${st.shuffle}</shuffle><song>${st.song}</song><state>${st.state}</state>` +
    `<title1>${st.title1}</title1><title2>${st.title2}</title2><title3>${st.title3}</title3><totlen>${st.totlen}</totlen><secs>${st.secs}</secs>${st.actions}</status>`;
  const change = patch => { Object.assign(st, patch); version++; waiters.splice(0).forEach(w => w()); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
    calls.push(req.url);
    const send = x => res.writeHead(200, { 'Content-Type': 'text/xml' }).end(x);
    if (p === '/SyncStatus') return send('<SyncStatus name="Den" modelName="NODE" etag="1"/>');
    if (p === '/Status') {
      if (q.get('etag') === `v${version}`) { const t = setTimeout(() => send(status()), 1500); waiters.push(() => { clearTimeout(t); send(status()); }); return; }
      return send(status());
    }
    if (p === '/Browse') {
      const k = q.get('key');
      if (!k) return send('<browse sid="1" type="menu"><item browseKey="playlists" text="Playlists" type="link"/><item browseKey="LocalMusic:" text="Library" type="link"/>' +
        '<item playURL="/Play?url=Capture%3Aanalog" text="Analog Input" type="audio" inputType="analog"/></browse>');
      if (k === 'LocalMusic:') return send('<browse><item browseKey="/Albums?service=LocalMusic" text="Albums" type="link"/></browse>');
      if (k === '/Albums?service=LocalMusic') return send('<browse nextKey="/Albums?service=LocalMusic&amp;start=2"><item text="First Album" text2="Artist One" image="/Artwork?album=1" browseKey="/Songs?album=1" playURL="/Add?album=1&amp;playnow=1" contextMenuKey="ctx1" type="album"/><item text="Second Album" text2="Artist Two" type="album" browseKey="/Songs?album=2"/></browse>');
      if (k === '/Albums?service=LocalMusic&start=2') return send('<browse><category text="More"><item text="Third Album" text2="Artist Three" type="album" playURL="/Add?album=3&amp;playnow=1"/></category></browse>');
      if (k === '/Songs?album=1') return send('<browse><item text="Track A" text2="Artist One" type="track" autoplayURL="/Add?track=a&amp;playnow=1&amp;auto=1" playURL="/Add?track=a&amp;playnow=1"/></browse>');
      if (k === 'ctx1') return send('<browse type="contextMenu"><item text="Add next" type="addAll-next" actionURL="/Add?album=1&amp;playnow=-1&amp;where=nextAlbum"/><item text="Add last" type="addAll-last" actionURL="/Add?album=1&amp;playnow=-1&amp;where=last"/></browse>');
      return send('<error><message>unknown key</message></error>');
    }
    if (p === '/Presets') return send('<presets prid="3"><preset id="6" name="Serenity" url="x" image="https://img.example/6.jpg"/></presets>');
    if (p === '/Playlist') {
      if (q.get('length') === '1') return send('<playlist><length>3</length><id>7</id></playlist>');
      return send('<playlist length="3" id="7">' + [0, 1, 2].map(i => `<song id="${i}"><title>Song ${i}</title><art>Artist ${i}</art><alb>Alb</alb></song>`).join('') + '</playlist>');
    }
    if (p === '/Artwork') return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from([1, 2, 3]));
    if (['/Play', '/Pause', '/Stop', '/Skip', '/Back', '/Shuffle', '/Repeat', '/Preset', '/Add', '/Action'].includes(p)) return send('<state>play</state>');
    res.writeHead(404).end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, calls, change, close: () => { srv.closeAllConnections(); srv.close(); } })));
}

test('bluos: browse, play, state, transport, favorites, queue', async t => {
  const m = await mock(); t.after(() => m.close());
  const be = createBluosBackend({ playerUrl: m.url, name: 'Player B', log: () => {}, pollMs: 50, skipWindowMs: 400 });
  t.after(() => be.close());
  const patches = []; be.player.on('state', p => patches.push(p));

  const menu = await new Menu(await be.home()).init();
  assert.strictEqual(menu.props.Title, 'Home Menu');
  assert.deepStrictEqual((await menu.data(1, 10)).map(r => r.L1), ['Playlists', 'Library', 'Analog Input']);
  await menu.select(2);                                                               // Library
  await menu.select(1);                                                               // Albums (follows nextKey, flattens categories)
  const albums = await menu.data(1, 10);
  assert.deepStrictEqual(albums.map(r => [r.L1, r.L2]), [['First Album', 'Artist One'], ['Second Album', 'Artist Two'], ['Third Album', 'Artist Three']]);
  assert.match(albums[0].art, /^b[A-Za-z0-9_-]+$/); assert.strictEqual(albums[1].art, '');
  assert.strictEqual(await menu.select(3), 'played');                                 // playable leaf
  assert.ok(m.calls.some(c => c.startsWith('/Add?album=3&playnow=1')));

  assert.strictEqual(await menu.pressAndHold(1), 'navigated');                        // context: Play now + the player's own actions
  assert.deepStrictEqual((await menu.data(1, 10)).map(r => r.L1), ['Play now', 'Add next', 'Add last']);
  assert.deepStrictEqual(menu.props.ListSpecificFunctions, ['QuickList', 'Favorites', 'Create', 'BackToTop']);
  assert.strictEqual(await menu.create(), true);                                      // plus button = add last
  assert.ok(m.calls.some(c => c.startsWith('/Add?album=1&playnow=-1&where=last')));
  assert.strictEqual(await menu.select(2), 'played');
  assert.ok(m.calls.some(c => c.startsWith('/Add?album=1&playnow=-1')));
  menu.back(); await menu.select(1);                                                  // First Album -> tracks
  assert.strictEqual(await menu.select(1), 'played');
  assert.ok(m.calls.some(c => c.includes('track=a') && c.includes('auto=1')), 'tracks use autoplayURL');

  // state from the long-poll
  m.change({ state: 'play', title1: 'Perfect', title2: 'Ed Sheeran', title3: 'Divide', totlen: 200, secs: 12, song: 1,
    actions: '<actions><action name="love" url="/Action?love=1"/><action name="ban" url="/Action?ban=1"/></actions>' });
  await wait(() => patches.find(p => p.Title === 'Perfect'));
  const f = patches.find(p => p.Title === 'Perfect');
  assert.deepStrictEqual([f.Artist, f.Album, f.TrackNum, f.TrackCnt, f.StationName, f.PlayerState], ['Ed Sheeran', 'Divide', 2, 3, 'Track 2 of 3', 'playing']);
  assert.ok(f.ActionsAvailable.includes('ThumbsUp') && f.ActionsAvailable.includes('Rewind')); assert.match(f.art, /^b/);
  await wait(() => patches.some(p => p.ElapsedSec >= 12) && patches.some(p => p.TrackSec === 200));
  assert.strictEqual((await be.art(f.art)).type, 'image/jpeg');

  await be.player.pause(); assert.ok(m.calls.includes('/Pause'));
  await be.player.next(); assert.ok(m.calls.includes('/Skip'));
  await be.player.prev(); assert.ok(m.calls.includes('/Back'));
  await be.player.seek({ sec: 30 }); assert.ok(m.calls.includes('/Play?seek=30'));
  await be.player.ffwd(); assert.ok(m.calls.some(c => /^\/Play\?seek=(2[7-9]|3\d|4\d)$/.test(c)), 'ffwd skips forward ~15 s');
  await be.player.shuffle(); assert.ok(m.calls.includes('/Shuffle?state=1'));
  await be.player.repeat(); assert.ok(m.calls.includes('/Repeat?state=1'), 'off -> one');
  await be.player.repeat(); assert.ok(m.calls.includes('/Repeat?state=0'), 'one -> all');
  await be.player.thumbsUp(); assert.ok(m.calls.includes('/Action?love=1')); assert.deepStrictEqual(patches.at(-1).Rating, { current: 1, max: 1, system: 1 });

  // Favorites = presets, QuickList = queue with the playing song marked
  const fm = await new Menu(await be.home()).init(); await fm.goto(await be.favorites());
  assert.deepStrictEqual([fm.props.Title, fm.props.ItemCnt], ['Favorites', 1]);
  assert.strictEqual(await fm.select(1), 'played'); assert.ok(m.calls.includes('/Preset?id=6'));
  const qm = await new Menu(await be.home()).init(); await qm.goto(await be.quickList());
  const ups = await qm.data(1, 10);
  assert.deepStrictEqual(ups.map(r => r.L1), ['Song 0', 'Song 1', 'Song 2']); assert.match(ups[1].L2, /^Now playing/);
  await qm.select(3); assert.ok(m.calls.includes('/Play?seek=0&id=2'));

  m.change({ state: 'stop', title1: '', title2: '', title3: '', totlen: 0 });
  await wait(() => patches.at(-1).Title === '' && patches.at(-1).PlayerState === 'stopped');
});
