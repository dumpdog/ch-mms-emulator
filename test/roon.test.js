'use strict';
// Roon backend, the BluOS+Roon slot and the shared Roon connection, against a mock Roon (test/helpers/roon-mock.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { createRoonBackend } = require('../backend-roon');
const { createBluosRoonBackend } = require('../backend-bluos-roon');
const { createRoonCore } = require('../roon-core');
const { Menu } = require('../menu');
const { makeCore, zone } = require('./helpers/roon-mock');

const settle = (ms = 25) => new Promise(r => setTimeout(r, ms));          // menu.back() pops the Roon level in the background
const titles = async (menu, n = 50) => (await menu.data(1, n)).map(r => r.L1);
const playing = (over = {}) => zone({ state: 'playing', now_playing: { length: 200, seek_position: 10, image_key: 'img1',
  one_line: { line1: 'Come Together - The Beatles' }, three_line: { line1: 'Come Together', line2: 'The Beatles', line3: 'Abbey Road' } }, ...over });
const mk = (core, extra = {}) => createRoonBackend({ core, zoneName: 'Living Room', name: 'Player B', log: () => {}, skipWindowMs: 400, ...extra });

test('roon: state follows the zone (now playing, seek ticks, settings, removal)', async () => {
  const core = makeCore({ zones: [playing({ settings: { shuffle: true, loop: 'loop_one' } })] });
  const be = mk(core); const patches = []; be.player.on('state', p => patches.push(p));
  await be.start();
  const p = Object.assign({}, ...patches);
  assert.deepStrictEqual([p.PlayerState, p.Title, p.Artist, p.Album, p.TrackSec, p.ElapsedSec, p.ShuffleState, p.RepeatState], ['playing', 'Come Together', 'The Beatles', 'Abbey Road', 200, 10, 1, 1]);
  assert.match(p.art, /^r/); assert.ok(p.ActionsAvailable.includes('Seek') && p.ActionsAvailable.includes('NextTrack') && p.ProgressBar);

  patches.length = 0; const sets = { settings: { shuffle: true, loop: 'loop_one' } };
  core.set([playing({ ...sets, now_playing: { ...playing().now_playing, seek_position: 11 } })]);
  assert.deepStrictEqual(patches, [{ ElapsedSec: 11 }]);                            // only what changed
  patches.length = 0; core.set([playing({ ...sets, state: 'paused' })]);
  assert.strictEqual(patches[0].PlayerState, 'paused');
  patches.length = 0; core.set([]);                                                  // zone gone: stopped and cleared
  assert.deepStrictEqual([patches[0].PlayerState, patches[0].Title], ['stopped', '']);
  patches.length = 0; core.set([zone({ state: 'playing', now_playing: { image_key: 'r', one_line: { line1: 'Radio' }, three_line: { line1: 'Radio', line2: 'Station', line3: 'FM' } } })]);
  assert.deepStrictEqual([be.player.snapshot().ProgressBar, patches[0].StationName], [false, 'FM']);   // no length = a stream
});

test('roon: transport commands', async () => {
  const core = makeCore({ zones: [playing()] }); const be = mk(core); await be.start();
  const { player: pl } = be;
  await pl.play(); await pl.pause(); await pl.stop(); await pl.next(); await pl.prev();
  assert.deepStrictEqual(core.calls.map(c => c[2]), ['play', 'pause', 'stop', 'next', 'previous']);
  core.calls.length = 0;
  await pl.seek({ sec: 42 }); await pl.ffwd(); await pl.ffwd(); await pl.rewind();
  assert.deepStrictEqual(core.calls, [['seek', 'z1', 'absolute', 42], ['seek', 'z1', 'relative', 15], ['seek', 'z1', 'relative', 20], ['seek', 'z1', 'relative', -15]]);
  core.calls.length = 0;
  await pl.shuffle(); await pl.repeat(); await pl.repeat(); await pl.repeat();       // off -> one -> all -> off
  assert.deepStrictEqual(core.calls.map(c => c[2]), [{ shuffle: true }, { loop: 'loop_one' }, { loop: 'loop' }, { loop: 'disabled' }]);
  core.calls.length = 0; core.set([]);                                                // no zone: commands do nothing and do not throw
  await pl.play(); await pl.shuffle(); assert.deepStrictEqual(core.calls, []);
});

test('roon: browse, play and keep Roon\'s stack in step with the menu', async () => {
  const core = makeCore(); const be = mk(core); await be.start();
  const menu = await new Menu(await be.home()).init(), srv = core.srv;
  assert.deepStrictEqual(await titles(menu), ['Search', 'Library', 'Playlists']);
  assert.deepStrictEqual(menu.props.ListSpecificFunctions, ['QuickList', 'BackToTop']);
  assert.strictEqual(await menu.select(2), 'navigated');                              // Library
  assert.deepStrictEqual(await titles(menu), ['Artists', 'Albums', 'Tracks']);
  await menu.select(1);                                                              // Artists
  assert.strictEqual((await titles(menu))[5], 'Beatles');
  await menu.select(6); await menu.select(1);                                        // Beatles > Abbey Road
  assert.strictEqual(menu.props.Title, 'Abbey Road'); assert.strictEqual(srv.depth('browse'), menu.stack.length);
  assert.strictEqual(await menu.select(1), 'played');                                // a track: Play Now
  assert.deepStrictEqual(srv.actions, [{ title: 'Play Now', zone: 'z1' }]);
  assert.strictEqual(srv.depth('browse'), menu.stack.length);                        // the action list was popped again
  assert.strictEqual(await menu.pressAndHold(2), 'navigated');                       // its action list
  assert.deepStrictEqual(await titles(menu), ['Play Now', 'Add Next', 'Queue']);
  assert.strictEqual(srv.depth('browse'), menu.stack.length);
  assert.strictEqual(await menu.select(2), 'played'); assert.strictEqual(srv.actions[1].title, 'Add Next');
  menu.back(); await settle(); assert.strictEqual(srv.depth('browse'), menu.stack.length);
  await menu.backToTop(); await settle(); assert.strictEqual(srv.depth('browse'), 1); assert.strictEqual(menu.stack.length, 1);
  assert.strictEqual(await menu.select(3), 'navigated');                              // still works after the unwind (no InvalidItemKey)
  assert.deepStrictEqual(await titles(menu), ['Road Trip']);
  assert.strictEqual(await menu.select(1), 'played'); assert.strictEqual(srv.actions[2].title, 'Play Now');
});

test('roon: free-text search (Find), repeated searches keep one level', async () => {
  const core = makeCore(); const be = mk(core); await be.start();
  const menu = await new Menu(await be.home()).init(), srv = core.srv;
  await menu.goto(await be.search('abbey'));
  assert.strictEqual(menu.props.Title, 'Results for abbey');
  assert.deepStrictEqual(await titles(menu), ['Artists', 'Come Together (Search)', 'Something (Search)']);
  assert.strictEqual(await menu.select(2), 'played'); assert.strictEqual(srv.actions[0].zone, 'z1');
  await menu.goto(await be.search('beatles')); await settle();                        // the old node's pop must not eat the new level
  assert.strictEqual(menu.props.Title, 'Results for beatles'); assert.strictEqual(srv.depth('search'), 2);
  await menu.select(1); assert.strictEqual(menu.props.Title, 'Artists'); assert.strictEqual(srv.depth('search'), 3);
  menu.back(); await settle(); assert.strictEqual(srv.depth('search'), 2);
  assert.strictEqual((await be.search('  ')).items[0].l1, 'Type something to search for');
});

test('roon: Search by letter for Crestron Home (no text entry)', async () => {
  const core = makeCore(); const be = mk(core); await be.start();
  const menu = await new Menu(await be.home()).init(), srv = core.srv;
  assert.strictEqual(await menu.select(1), 'navigated');                              // Search
  assert.deepStrictEqual(await titles(menu), ['Artists by letter', 'Albums by letter', 'Tracks by letter']);
  assert.strictEqual(await menu.select(1), 'navigated');                              // opens Library > Artists on Roon's side
  assert.strictEqual(srv.depth('browse'), 3);
  const letters = await titles(menu, 30); assert.deepStrictEqual([letters.length, letters[0], letters[1], letters[26]], [27, '#', 'A', 'Z']);
  await menu.select(3);                                                              // B
  assert.deepStrictEqual(await titles(menu), ['Bach', 'Beatles', 'Beck']); assert.strictEqual(menu.props.ItemCnt, 3);
  assert.strictEqual(await menu.select(2), 'navigated');                              // Beatles: a real Roon level on top
  assert.strictEqual(srv.depth('browse'), 4);
  menu.back(); await settle(); assert.strictEqual(srv.depth('browse'), 3);
  menu.back();                                                                       // letters
  for (const [i, want] of [[1, ['!!!', '2Pac']], [2, ['ABBA', 'Adele']], [27, ['Zappa']]]) { await menu.select(i); assert.deepStrictEqual(await titles(menu), want); menu.back(); }
  await menu.select(6);                                                              // E: nothing
  assert.strictEqual((await titles(menu))[0], 'Nothing under this letter'); menu.back();
  menu.back(); await settle();                                                       // leave the letters: both Roon levels pop
  assert.strictEqual(srv.depth('browse'), 1); assert.strictEqual(menu.stack.length, 2);
  await menu.select(3);                                                              // Tracks by letter works too
  assert.strictEqual(srv.depth('browse'), 3); assert.strictEqual((await titles(menu, 30))[0], '#');
});

test('roon: waiting for pairing, missing zone, recovery', async () => {
  const core = makeCore({ zones: [], ready: false }); const be = mk(core); await be.start();
  const menu = await new Menu(await be.home()).init();
  assert.deepStrictEqual((await menu.data(1, 5))[0].L1, 'Waiting for Roon');
  assert.strictEqual((await be.search('x')).items[0].l1, 'Waiting for Roon');
  core.pair(true);                                                                   // paired, but no zone of that name yet
  await menu.backToTop(); assert.match((await titles(menu))[0], /zone "Living Room" not found/);
  core.set([zone()]);                                                                // the zone appears
  await menu.backToTop(); assert.deepStrictEqual(await titles(menu), ['Search', 'Library', 'Playlists']);
});

test('roon: up next (queue) and artwork', async () => {
  const core = makeCore({ zones: [playing()] }); const be = mk(core); await be.start();
  const menu = await new Menu(await be.home()).init();
  await menu.goto(await be.quickList());
  const rows = await menu.data(1, 5); assert.deepStrictEqual([rows[0].L1, rows[0].L2], ['Next Song', 'Someone']);
  await menu.select(1); await settle(); assert.deepStrictEqual(core.calls.find(c => c[0] === 'playFromHere'), ['playFromHere', 'z1', 7]);
  const art = await be.art(rows[0].art); assert.deepStrictEqual([art.type, art.body.toString()], ['image/jpeg', 'q']);
  assert.deepStrictEqual(core.calls.find(c => c[0] === 'image')[2], { scale: 'fit', width: 500, height: 500, format: 'image/jpeg' });
  assert.strictEqual(await be.art('bnotroon'), null);
});

// ------------------------------------------------------------------ BluOS + Roon in one slot
function fakeBluos(over = {}) {
  const player = new EventEmitter(), cur = {}, calls = [];
  player.snapshot = () => ({ ...cur }); player.play = async () => calls.push('bluos play'); player.pause = async () => calls.push('bluos pause');
  player.emitState = p => { Object.assign(cur, p); player.emit('state', p); };
  return { calls, providerName: 'BluOS', player, favorites: async () => ({ title: 'Favorites', items: [] }), quickList: async () => ({ title: 'Up Next', items: [] }),
    home: async () => ({ title: 'Home Menu', count: async () => 2, page: async (s, n) => [{ l1: 'Inputs' }, { l1: 'Presets' }].slice(s, s + n) }),
    art: async g => ({ type: 'image/x-bluos', body: Buffer.from(g) }), start: async () => {}, close() {}, ...over };
}
function hybrid(core, bluos) {
  const roon = createRoonBackend({ core, zoneName: 'Living Room', name: 'Player B', log: () => {}, title: 'Roon' });
  return createBluosRoonBackend({ bluos, roon, zoneName: 'Living Room', name: 'Player B', log: () => {} });
}

test('bluos+roon: Roon entry on the home menu, source switching, routing', async () => {
  const core = makeCore({ zones: [zone()] }), blu = fakeBluos(), be = hybrid(core, blu), patches = [];
  be.player.on('state', p => patches.push(p)); await be.start();
  const menu = await new Menu(await be.home()).init();
  assert.deepStrictEqual(await titles(menu), ['Roon', 'Inputs', 'Presets']);
  assert.deepStrictEqual((await menu.data(2, 1)).map(r => r.L1), ['Inputs']);       // paging across the added row
  assert.deepStrictEqual((await menu.data(1, 1)).map(r => r.L1), ['Roon']);
  assert.strictEqual(await menu.select(1), 'navigated');                              // Roon's tree, titled "Roon"
  assert.strictEqual(menu.props.Title, 'Roon'); assert.deepStrictEqual(await titles(menu), ['Search', 'Library', 'Playlists']);

  blu.player.emitState({ PlayerState: 'playing', Title: 'BluOS Song', Artist: 'A' });   // BluOS plays on its own: BluOS is followed
  assert.strictEqual(patches.at(-1).Title, 'BluOS Song');
  await be.player.play(); assert.deepStrictEqual(blu.calls, ['bluos play']);

  patches.length = 0; core.set([playing()]);                                          // Roon starts: Roon is followed, BluOS text cleared
  assert.deepStrictEqual([patches[0].Title, patches[0].Artist, patches[0].PlayerState], ['Come Together', 'The Beatles', 'playing']);
  core.calls.length = 0; await be.player.pause();
  assert.deepStrictEqual(core.calls, [['control', 'z1', 'pause']]); assert.deepStrictEqual(blu.calls, ['bluos play']);   // routed to Roon only
  patches.length = 0; blu.player.emitState({ Title: 'BluOS chatter' });               // ignored while Roon is active
  assert.deepStrictEqual(patches, []);

  core.set([zone({ state: 'stopped' })]);                                             // Roon stops: back to BluOS
  assert.strictEqual(patches.at(-1).Title, 'BluOS chatter');
  await be.player.pause(); assert.deepStrictEqual(blu.calls, ['bluos play', 'bluos pause']);

  assert.strictEqual((await be.art('r' + Buffer.from('abc').toString('base64url'))).body.toString(), 'abc'); assert.strictEqual((await be.art('babc')).type, 'image/x-bluos');
  assert.ok(be.search && be.favorites);
});

test('bluos+roon: a BluOS player that is down still offers Roon', async () => {
  const core = makeCore(), be = hybrid(core, fakeBluos({ home: async () => { throw new Error('connect EHOSTUNREACH'); } }));
  const menu = await new Menu(await be.home()).init();
  assert.deepStrictEqual(await titles(menu), ['Roon']);
  assert.strictEqual(await menu.select(1), 'navigated'); assert.deepStrictEqual(await titles(menu), ['Search', 'Library', 'Playlists']);
});

// ------------------------------------------------------------------ the shared connection
test('roon core: pairing, zone tracking, requests, queue, direct connect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roon-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  class FakeApi { constructor(o) { this.o = o; FakeApi.last = this; } init_services(s) { this.services = s; } start_discovery() { this.discovering = true; } ws_connect(o) { this.ws = o; } }
  const modules = { RoonApi: FakeApi, RoonApiTransport: {}, RoonApiBrowse: {}, RoonApiImage: {} };
  const core = createRoonCore({ modules, log: () => {}, statePath: path.join(dir, 'roon-state.json') });
  core.start(); const api = FakeApi.last;
  assert.ok(api.discovering); assert.strictEqual(api.o.display_name, 'MMS Emulator'); assert.strictEqual(api.services.required_services.length, 3);
  api.o.set_persisted_state({ tokens: { c1: 't' } }); assert.deepStrictEqual(api.o.get_persisted_state(), { tokens: { c1: 't' } });   // the pairing survives a restart

  let zoneCb, queueCb, unsubscribed = 0; const calls = [];
  const transport = { subscribe_zones: cb => { zoneCb = cb; }, subscribe_queue: (id, max, cb) => { queueCb = cb; return { unsubscribe: () => { unsubscribed++; } }; },
    control: (id, how, cb) => { calls.push([id, how]); cb(how === 'bad' ? 'InvalidRequest' : false); } };
  const browse = { browse: (o, cb) => cb(false, { action: 'list', echo: o }), load: (o, cb) => cb('NetworkError') };
  const image = { get_image: (k, o, cb) => cb(false, 'image/png', Buffer.from(k)) };
  assert.strictEqual(core.ready(), false); await assert.rejects(core.control('z1', 'play'), /not connected/);
  const zonesSeen = []; core.events.on('zones', e => zonesSeen.push(e));
  api.o.core_paired({ display_name: 'Den Core', services: { RoonApiTransport: transport, RoonApiBrowse: browse, RoonApiImage: image } });
  assert.ok(core.ready());
  zoneCb('Subscribed', { zones: [{ zone_id: 'z1', display_name: 'Kitchen', outputs: [{ display_name: 'Kitchen Amp' }], now_playing: { seek_position: 1 } }] });
  assert.strictEqual(core.zoneByName(' kitchen ').zone_id, 'z1'); assert.strictEqual(core.zoneByName('Kitchen Amp').zone_id, 'z1'); assert.strictEqual(core.zoneByName('Nope'), null);
  zoneCb('Changed', { zones_seek_changed: [{ zone_id: 'z1', seek_position: 5, queue_time_remaining: 9 }] });
  assert.strictEqual(core.zoneByName('Kitchen').now_playing.seek_position, 5); assert.strictEqual(zonesSeen.at(-1).changed[0].zone_id, 'z1');
  zoneCb('Changed', { zones_changed: [{ zone_id: 'z1', display_name: 'Kitchen 2', outputs: [] }] }); assert.strictEqual(core.zoneByName('Kitchen'), null);
  zoneCb('Changed', { zones_removed: ['z1'] }); assert.strictEqual(core.zones().length, 0); assert.strictEqual(zonesSeen.at(-1).removed[0].zone_id, 'z1');

  await core.control('z1', 'play'); assert.deepStrictEqual(calls, [['z1', 'play']]);
  await assert.rejects(core.control('z1', 'bad'), /Roon request failed|InvalidRequest/);
  assert.strictEqual((await core.browse({ hierarchy: 'browse' })).echo.hierarchy, 'browse'); await assert.rejects(core.load({}), /NetworkError|failed/);
  assert.strictEqual((await core.image('k1', {})).body.toString(), 'k1');

  const q = core.queue('z1', 10, 500); queueCb('Subscribed', { items: [{ queue_item_id: 1 }] });                // the event name arrives in the error slot
  assert.deepStrictEqual(await q, [{ queue_item_id: 1 }]); assert.strictEqual(unsubscribed, 1);
  const q2 = core.queue('z1', 10, 500); queueCb('InvalidRequest'); await assert.rejects(q2, /failed|InvalidRequest/);

  const lost = []; core.events.on('unpaired', () => lost.push(1)); api.o.core_unpaired({ display_name: 'Den Core' });
  assert.deepStrictEqual([core.ready(), lost.length], [false, 1]);

  const direct = createRoonCore({ modules, log: () => {}, statePath: path.join(dir, 's2.json'), host: '192.168.1.9:9100' });
  direct.start(); assert.deepStrictEqual([FakeApi.last.ws.host, FakeApi.last.ws.port], ['192.168.1.9', 9100]); direct.close();
  const dflt = createRoonCore({ modules, log: () => {}, statePath: path.join(dir, 's3.json'), host: '192.168.1.9' });
  dflt.start(); assert.strictEqual(FakeApi.last.ws.port, 9330); dflt.close();
});

test('roon core: a missing node-roon-api package says what to do', t => {
  try { require.resolve('node-roon-api'); return t.skip('node-roon-api is installed here'); } catch { /* not installed: the case under test */ }
  assert.throws(() => createRoonCore({ log: () => {}, statePath: 'x' }), /run \.\/install\.sh/);
});
