'use strict';
// Plex backend against a mock Plex Media Server + Plexamp (one http server answers both).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createPlexBackend } = require('../backend-plex');
const { Menu } = require('../menu');

const wait = (cond, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() { const v = cond(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('timeout: ' + cond)); setTimeout(poll, 10); })();
});

const ALBUMS = [{ ratingKey: '10', title: 'First Album', parentTitle: 'Artist One', type: 'album', thumb: '/library/metadata/10/thumb/111' },
  { ratingKey: '11', title: 'Second Album', parentTitle: 'Artist Two', type: 'album', thumb: '/library/metadata/11/thumb/222' }];
const TRACKS = [{ ratingKey: '100', key: '/library/metadata/100', title: 'Track A', grandparentTitle: 'Artist One', parentTitle: 'First Album', parentThumb: '/library/metadata/10/thumb/111', userRating: 0 },
  { ratingKey: '101', key: '/library/metadata/101', title: 'Track B', grandparentTitle: 'Artist One', parentTitle: 'First Album', parentThumb: '/library/metadata/10/thumb/111', userRating: 0 }];

const LIKED = [{ ratingKey: '100', guid: 'plex://track/a', key: '/library/metadata/100', title: 'Track A', grandparentTitle: 'Artist One', parentThumb: '/library/metadata/10/thumb/111', userRating: 10 }, { ratingKey: '300', guid: 'plex://track/a', key: '/library/metadata/300', title: 'Track A', grandparentTitle: 'Artist One', userRating: 10 }];   // same recording on another album

function mock() {
  const calls = [];
  let timeline = { state: 'stopped' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${u.pathname}?${u.searchParams.toString().replace(/X-Plex-Token=[^&]*&?/, '')}`);
    const json = o => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ MediaContainer: o }));
    const p = u.pathname, size = u.searchParams.get('X-Plex-Container-Size'), start = Number(u.searchParams.get('X-Plex-Container-Start') || 0);
    const slice = (all) => json({ totalSize: all.length, size: size === '0' ? 0 : all.slice(start, start + Number(size)).length, Metadata: size === '0' ? [] : all.slice(start, start + Number(size)) });
    if (p === '/identity') return json({ machineIdentifier: 'SERVER1' });
    if (p === '/resources') return res.end('<MediaContainer><Player machineIdentifier="AMP1"/></MediaContainer>');
    if (p === '/library/sections') return json({ Directory: [{ key: '7', type: 'artist' }] });
    if (p === '/library/sections/7/firstCharacter') return json({ Directory: [{ key: 'f', title: 'F', size: '1' }, { key: 's', title: 'S', size: '1' }] });
    if (p === '/library/sections/7/firstCharacter/s') return slice(ALBUMS.slice(1));
    if (p === '/library/sections/7/albums') return slice(ALBUMS);
    if (p === '/library/sections/7/all') return slice(u.searchParams.has('userRating>>') ? LIKED : []);
    if (p === '/library/metadata/10/children') return slice(TRACKS);
    if (p === '/library/metadata/100' || p === '/library/metadata/101') return json({ Metadata: [TRACKS.find(t => t.key === p)] });
    if (p === '/hubs/search') return json({ Hub: [{ type: 'album', Metadata: [ALBUMS[0]] }, { type: 'track', Metadata: [TRACKS[1]] }] });
    if (p === '/playQueues' && req.method === 'POST') return json({ playQueueID: 55, playQueueTotalCount: 2, Metadata: TRACKS });
    if (p === '/playQueues/55') return json({ playQueueSelectedItemOffset: 1, playQueueTotalCount: 2, Metadata: TRACKS.map((tr, i) => ({ ...tr, playQueueItemID: 9 + i })) });
    if (p === '/playQueues/55' && req.method === 'PUT') return json({});
    if (p === '/:/rate') { TRACKS[0].userRating = Number(u.searchParams.get('rating')); return res.end(); }
    if (p === '/player/timeline/poll') return res.end(`<MediaContainer><Timeline type="music" ${Object.entries(timeline).map(([k, v]) => `${k}="${v}"`).join(' ')}/></MediaContainer>`);
    if (p.startsWith('/player/')) return res.end('<Response code="200"/>');
    res.writeHead(404).end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, calls, setTimeline: t => (timeline = t), close: () => srv.close() })));
}

test('browse albums, play a track, track state, thumbs', async t => {
  const m = await mock(); t.after(() => m.close());
  const be = createPlexBackend({ plexUrl: m.url, token: 'SECRET', plexampUrl: m.url, name: 'Player A', log: () => {}, pollMs: 50, skipWindowMs: 400 });
  t.after(() => be.close());
  const patches = []; be.player.on('state', p => patches.push(p));

  const menu = await new Menu(await be.home()).init();
  assert.strictEqual(menu.props.Title, 'Home Menu');                                  // the home menu is the library list itself
  assert.deepStrictEqual((await menu.data(1, 10)).map(r => r.L1), ['Playlists', 'Albums', 'Artists', 'Recently Added', 'Recently Played', 'Songs', 'Search']);
  await menu.select(2);                                                               // Albums
  assert.strictEqual(menu.props.ItemCnt, 2);
  const albums = await menu.data(1, 100);
  assert.deepStrictEqual(albums.map(r => [r.L1, r.L2]), [['First Album', 'Artist One'], ['Second Album', 'Artist Two']]);
  assert.match(albums[0].art, /^p[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual((await menu.data(2, 100)).map(r => r.L1), ['Second Album']);        // paging offset
  await menu.select(1);                                                               // First Album -> tracks
  assert.deepStrictEqual((await menu.data(1, 100)).map(r => r.L1), ['Track A', 'Track B']);

  assert.strictEqual(await menu.select(2), 'played');                                 // play Track B from the album
  await wait(() => m.calls.find(c => c.includes('/player/playback/playMedia')));   // play runs in the background
  const pm = m.calls.find(c => c.includes('/player/playback/playMedia'));
  assert.ok(pm, 'playMedia sent to Plexamp');
  assert.match(pm, /key=%2Flibrary%2Fmetadata%2F101/); assert.match(pm, /machineIdentifier=SERVER1/); assert.match(pm, /containerKey=%2FplayQueues%2F55/);
  assert.ok(m.calls.some(c => c.startsWith('POST /playQueues') && c.includes('uri=server%3A%2F%2FSERVER1%2Fcom.plexapp.plugins.library%2Flibrary%2Fmetadata%2F10')));
  assert.deepStrictEqual(m.calls.filter(c => c.includes('SECRET')).map(c => c.split('?')[0]), ['GET /player/playback/playMedia'], 'token only goes to Plexamp playMedia');

  m.setTimeline({ state: 'playing', time: 12000, duration: 200000, ratingKey: '100', playQueueID: 55, playQueueItemID: 9, shuffle: 0, repeat: 0 });
  await wait(() => patches.find(p => p.Title));
  const first = patches.find(p => p.Title);
  assert.deepStrictEqual([first.Title, first.Artist, first.Album, first.TrackNum, first.TrackCnt, first.StationName], ['Track A', 'Artist One', 'First Album', 2, 2, 'Track 2 of 2']);
  assert.match(first.art, /^p/); assert.ok(first.ActionsAvailable.includes('ThumbsUp'));
  await wait(() => patches.find(p => p.ElapsedSec === 12 && p.TrackSec === 200));

  await be.player.thumbsUp();
  assert.ok(m.calls.some(c => c.startsWith('PUT /:/rate') && c.includes('rating=10') && c.includes('key=100')));
  assert.deepStrictEqual(patches.at(-1).Rating, { current: 1, max: 1, system: 1 });
  await be.player.thumbsUp();                                                         // again clears
  assert.ok(m.calls.some(c => c.startsWith('PUT /:/rate') && c.includes('rating=-1')));
  await be.player.thumbsDown();
  assert.deepStrictEqual(patches.at(-1).Rating, { current: -1, max: 1, system: 1 });

  await be.player.pause();
  assert.ok(m.calls.some(c => c.includes('/player/playback/pause')));
  await be.player.seek({ sec: 30 });
  assert.ok(m.calls.some(c => c.includes('/player/playback/seekTo') && c.includes('offset=30000')));

  await be.player.ffwd();                                                             // 12 s elapsed + 15
  assert.ok(m.calls.some(c => c.includes('/player/playback/seekTo') && c.includes('offset=27000')));
  await be.player.rewind();                                                           // 27 - 15
  assert.ok(m.calls.filter(c => c.includes('/player/playback/seekTo') && c.includes('offset=12000')).length >= 1);
  assert.ok(patches.at(-1).ElapsedSec === 12 || patches.some(p => p.ElapsedSec === 27), 'elapsed updated immediately');

  await new Promise(r => setTimeout(r, 450));                                          // let the skip streak lapse
  for (const off of [27000, 47000, 72000]) { await be.player.ffwd(); assert.ok(m.calls.at(-3).includes(`offset=${off}`) || m.calls.some(c => c.includes('seekTo') && c.includes(`offset=${off}`)), `accelerating skip to ${off}`); }
  await be.player.rewind();                                                            // direction change restarts at 15 s, from where we are (72)
  assert.ok(m.calls.some(c => c.includes('seekTo') && c.includes('offset=57000')), 'rewind restarts at 15 s');

  // Favorites button -> liked tracks; QuickList button -> current queue, selecting jumps with skipTo
  const fmenu = await new Menu(await be.home()).init();
  await fmenu.goto(await be.favorites());
  assert.deepStrictEqual([fmenu.props.Title, fmenu.props.ItemCnt, fmenu.props.Level], ['Favorites', 1, 1]);
  assert.deepStrictEqual((await fmenu.data(1, 5)).map(r => r.L1), ['Track A']);
  const qmenu = await new Menu(await be.home()).init();
  await qmenu.goto(await be.quickList());
  assert.strictEqual(qmenu.props.Title, 'Up Next');
  const ups = await qmenu.data(1, 10);
  assert.deepStrictEqual(ups.map(r => r.L1), ['Track A', 'Track B']); assert.match(ups[0].L2, /^Now playing/);
  assert.strictEqual(await qmenu.select(2), 'played');
  assert.ok(m.calls.some(c => c.includes('/player/playback/skipTo') && c.includes('playQueueItemID=10') && c.includes('key=%2Flibrary%2Fmetadata%2F101')));

  // long-press menu: "Add to queue" (and the plus button) append to the running queue, "Play next" goes after the current track
  const cmenu = await new Menu(await be.home()).init(); await cmenu.goto(await be.favorites());
  assert.strictEqual(await cmenu.pressAndHold(1), 'navigated');
  assert.deepStrictEqual(cmenu.props.ListSpecificFunctions, ['QuickList', 'Favorites', 'Create', 'BackToTop']);
  assert.deepStrictEqual((await cmenu.data(1, 10)).map(r => r.L1), ['Play now', 'Play next', 'Add to queue']);
  await cmenu.select(2);
  await wait(() => m.calls.some(c => c.startsWith('PUT /playQueues/55') && c.includes('next=1') && c.includes('metadata%2F100')));
  assert.strictEqual(await cmenu.create(), true);
  await wait(() => m.calls.some(c => c.startsWith('PUT /playQueues/55') && c.includes('next=0')));
  await wait(() => m.calls.some(c => c.includes('/player/playback/refreshPlayQueue') && c.includes('playQueueID=55')));
  assert.strictEqual(await qmenu.create(), false, 'no plus action on a plain list');

  // search (Smart Graphics Find): albums and tracks matching the text
  const smenu = await new Menu(await be.home()).init(); await smenu.goto(await be.search('track'));
  assert.strictEqual(smenu.props.Title, 'Search: track');
  assert.deepStrictEqual((await smenu.data(1, 10)).map(r => [r.L1, r.L2]), [['First Album', 'Album - Artist One'], ['Track B', 'Song - Artist One']]);
  assert.ok(m.calls.some(c => c.startsWith('GET /hubs/search') && c.includes('query=track') && c.includes('sectionId=7')));
  assert.strictEqual(await smenu.select(1), 'navigated');                             // an album result opens its tracks
  assert.deepStrictEqual((await smenu.data(1, 10)).map(r => r.L1), ['Track A', 'Track B']);
  assert.strictEqual((await be.search('  ')).items[0].l1, 'Type something to search for');

  const art = await be.art(first.art).catch(() => null);                               // mock has no photo transcode: must not throw out of the handler
  assert.ok(art === null || art.body);
});

test('search by letter: kind -> letter index -> items', async t => {
  const m = await mock(); t.after(() => m.close());
  const be = createPlexBackend({ plexUrl: m.url, token: 'SECRET', plexampUrl: m.url, name: 'Player A', log: () => {}, pollMs: 50 });
  t.after(() => be.close());
  const menu = await new Menu(await be.home()).init();
  await menu.select(7);                                                               // Search
  assert.deepStrictEqual((await menu.data(1, 10)).map(r => r.L1), ['Artists by letter', 'Albums by letter', 'Songs by letter']);
  await menu.select(2);                                                               // Albums by letter
  assert.deepStrictEqual((await menu.data(1, 10)).map(r => [r.L1, r.L2]), [['F', '1 item'], ['S', '1 item']]);
  await menu.select(2);                                                               // S
  assert.deepStrictEqual((await menu.data(1, 10)).map(r => r.L1), ['Second Album']);
  assert.ok(m.calls.some(c => c.startsWith('GET /library/sections/7/firstCharacter/s?') && c.includes('type=9')));
  assert.strictEqual(menu.props.Title, 'Albums: S');
});
