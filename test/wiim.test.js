'use strict';
// WiiM backend against a mock LinkPlay player (httpapi.asp over plain HTTP: getStatusEx, getPlayerStatus, getMetaInfo, getPresetInfo, setPlayerCmd).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createWiimBackend } = require('../backend-wiim');
const { Menu } = require('../menu');

const wait = (cond, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() { const v = cond(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('timeout: ' + cond)); setTimeout(poll, 10); })();
});
const hex = s => Buffer.from(s).toString('hex');

function mock() {
  const calls = [];
  const st = { status: 'none', curpos: 0, totlen: 0, loop: 4, mode: -1, Title: 'Unknown', Artist: 'Unknown', Album: 'Unknown', plicurr: 0, plicount: 0, vol: 30,
    meta: { title: 'Unknown', artist: 'unknow', album: 'unknow', subtitle: '', albumArtURI: '' }, presets: [] };
  const srv = http.createServer((req, res) => {
    const c = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('command') || '');
    calls.push(c || req.url);
    if (c === 'getStatusEx') return res.end(JSON.stringify({ DeviceName: 'Den', project: 'WiiM_Ultra' }));
    if (c === 'getPlayerStatus') return res.end(JSON.stringify({ status: st.status, curpos: String(st.curpos), totlen: String(st.totlen), loop: String(st.loop), mode: String(st.mode),
      Title: hex(st.Title), Artist: hex(st.Artist), Album: hex(st.Album), plicurr: String(st.plicurr), plicount: String(st.plicount), vol: String(st.vol), mute: '0' }));
    if (c === 'getMetaInfo') return st.meta.title === 'Unknown' ? res.end('Failed') : res.end(JSON.stringify({ metaData: { ...st.meta, 'albumArtURI ': st.meta.albumArtURI } }));
    if (c === 'getPresetInfo') return res.end(JSON.stringify({ preset_num: st.presets.length, preset_list: st.presets }));
    if (req.url.startsWith('/art.jpg')) return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from([1, 2, 3]));
    res.end('OK');
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, port: srv.address().port, calls, st, close: () => { srv.closeAllConnections(); srv.close(); } })));
}

test('wiim: presets as browse + favorites, state, transport', async t => {
  const m = await mock(); t.after(() => m.close());
  m.st.presets = [{ number: 1, name: 'Jazz', url: 'u', source: 'Plex', picurl: `${m.url}/art.jpg` }, { number: 2, name: '', url: '' },
    { number: 3, name: 'The Peak', url: 'unknow', source: 'newTuneIn', picurl: '' }];
  const be = createWiimBackend({ playerUrl: m.url, name: 'Player A', log: () => {}, pollMs: 50, skipWindowMs: 400 });
  t.after(() => be.close());
  const patches = []; be.player.on('state', p => patches.push(p));

  // browse: the home menu is the preset list (empty slots skipped), Favorites is the same list
  const menu = await new Menu(await be.home()).init();
  assert.strictEqual(menu.props.Title, 'Home Menu');
  assert.deepStrictEqual(menu.props.ListSpecificFunctions, ['Favorites', 'BackToTop']);
  const rows = await menu.data(1, 10);
  assert.deepStrictEqual(rows.map(r => [r.L1, r.L2]), [['Jazz', 'Plex'], ['The Peak', 'newTuneIn']]);
  assert.match(rows[0].art, /^b/); assert.strictEqual(rows[1].art, '');
  assert.strictEqual((await be.art(rows[0].art)).type, 'image/jpeg');
  assert.strictEqual(await menu.select(2), 'played'); assert.ok(m.calls.includes('MCUKeyShortClick:3'));
  const fm = await new Menu(await be.home()).init(); await fm.goto(await be.favorites());
  assert.deepStrictEqual([fm.props.Title, fm.props.ItemCnt], ['Favorites', 2]);

  // idle: "Unknown" titles and a failing getMetaInfo are harmless
  await be.start();
  assert.strictEqual(patches[0].PlayerState, 'stopped'); assert.ok(!patches[0].Title);

  // a Plex playlist: queue position, seek/repeat/shuffle actions, art from getMetaInfo
  Object.assign(m.st, { status: 'play', curpos: 12000, totlen: 200000, mode: 10, Title: 'Lavender Haze', Artist: 'Taylor Swift', Album: 'Midnights', plicurr: 1, plicount: 21,
    meta: { title: 'Lavender Haze', artist: 'Taylor Swift', album: 'Midnights', subtitle: '', albumArtURI: `${m.url}/art.jpg` } });
  const f = await wait(() => patches.find(p => p.Title === 'Lavender Haze'));
  assert.deepStrictEqual([f.Artist, f.Album, f.TrackNum, f.TrackCnt, f.StationName, f.PlayerState, f.TrackSec], ['Taylor Swift', 'Midnights', 1, 21, 'Track 1 of 21', 'playing', 200]);
  assert.ok(f.ActionsAvailable.includes('Seek') && f.ActionsAvailable.includes('Repeat')); assert.match(f.art, /^b/);
  assert.strictEqual((await be.art(f.art)).type, 'image/jpeg');
  await wait(() => patches.some(p => p.ElapsedSec >= 12));

  await be.player.pause(); assert.ok(m.calls.includes('setPlayerCmd:pause'));
  await be.player.play(); assert.ok(m.calls.includes('setPlayerCmd:resume'));
  await be.player.next(); assert.ok(m.calls.includes('setPlayerCmd:next'));
  await be.player.prev(); assert.ok(m.calls.includes('setPlayerCmd:prev'));
  await be.player.stop(); assert.ok(m.calls.includes('setPlayerCmd:stop'));
  await be.player.seek({ sec: 30 }); assert.ok(m.calls.includes('setPlayerCmd:seek:30'));
  await be.player.ffwd(); assert.ok(m.calls.some(c => /^setPlayerCmd:seek:(2[7-9]|3\d|4\d)$/.test(c)), 'ffwd skips forward ~15 s');
  await be.player.shuffle(); assert.ok(m.calls.includes('setPlayerCmd:loopmode:3'), 'shuffle, no repeat');
  await be.player.repeat(); assert.ok(m.calls.includes('setPlayerCmd:loopmode:1'), 'off -> one');
  await be.player.repeat(); assert.ok(m.calls.includes('setPlayerCmd:loopmode:2'), 'one -> all, shuffle kept');

  // state from loopmode (3 = shuffle, no repeat; repeat all -> off is the change; shuffle stays 1 so it is not re-sent)
  const from = patches.length; m.st.loop = 3;
  await wait(() => patches.slice(from).some(p => p.RepeatState === 0));

  // radio: no totlen -> no seek/repeat/shuffle, the station name stands in for artist/album
  Object.assign(m.st, { totlen: 0, curpos: 5000, plicount: 0, plicurr: 0, loop: 4, Title: 'Alternative Vancouver', Artist: 'Unknown', Album: 'unknown',
    meta: { title: 'Alternative Vancouver', artist: 'unknow', album: 'unknow', subtitle: '102.7 The Peak', albumArtURI: '' } });
  const r = await wait(() => patches.find(p => p.Title === 'Alternative Vancouver'));
  assert.deepStrictEqual([r.Artist, r.Album, r.StationName, r.ProgressBar], ['102.7 The Peak', '102.7 The Peak', '102.7 The Peak', false]);
  assert.ok(!r.ActionsAvailable.includes('Seek') && !r.ActionsAvailable.includes('Shuffle'));

  Object.assign(m.st, { status: 'none', Title: 'Unknown', Artist: 'Unknown', Album: 'Unknown', meta: { title: 'Unknown', artist: 'unknow', album: 'unknow', subtitle: '', albumArtURI: '' } });
  await wait(() => patches.at(-1).Title === '' && patches.at(-1).PlayerState === 'stopped');
});
