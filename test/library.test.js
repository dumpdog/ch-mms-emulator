'use strict';
// Several Plex music libraries: the last Home Menu entry switches between them, the title names the current one, the choice is remembered.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPlexBackend } = require('../backend-plex');
const { Menu } = require('../menu');

function mock(sections) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname, size = u.searchParams.get('X-Plex-Container-Size');
    const json = o => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ MediaContainer: o }));
    if (p === '/identity') return json({ machineIdentifier: 'SERVER1' });
    if (p === '/resources') return res.end('<MediaContainer><Player machineIdentifier="AMP1"/></MediaContainer>');
    if (p === '/library/sections') return json({ Directory: sections.map(s => ({ key: s.key, type: 'artist', title: s.title })) });
    const m = /^\/library\/sections\/(\d+)\/albums$/.exec(p);
    if (m) { const albums = sections.find(s => s.key === m[1]).albums.map((t, i) => ({ ratingKey: String(i), title: t, type: 'album' })); return json({ totalSize: albums.length, size: size === '0' ? 0 : albums.length, Metadata: size === '0' ? [] : albums }); }
    if (p === '/timeline/poll' || p === '/player/timeline/poll') return res.end('<MediaContainer><Timeline type="music" state="stopped"/></MediaContainer>');
    json({ size: 0, Metadata: [] });
  });
  return new Promise(r => srv.listen(0, () => r(srv)));
}

const SECTIONS = [{ key: '3', title: 'Music', albums: ['Album One', 'Album Two'] }, { key: '5', title: 'Audiobooks', albums: ['Book One'] }];
const make = (srv, extra) => createPlexBackend({ plexUrl: `http://127.0.0.1:${srv.address().port}`, token: 'T', plexampUrl: `http://127.0.0.1:${srv.address().port}`, name: 'Player A', log: () => {}, pollMs: 60000, ...extra });
const rows = async menu => (await menu.data(1, 100)).map(r => r.L1);

test('library switch: last home entry, title, rebuilt home, remembered', async () => {
  const srv = await mock(SECTIONS), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')), libraryFile = path.join(dir, 'library-a.json');
  try {
    const be = make(srv, { library: 'Music', libraryFile });
    const menu = await new Menu(await be.home()).init();
    assert.strictEqual(menu.props.Title, 'Home Menu: Music');
    const home = await menu.data(1, 100);
    assert.strictEqual(home[home.length - 1].L1, 'Library: Music');
    assert.strictEqual(home[home.length - 1].L2, 'Select to switch to Audiobooks');
    await menu.select(2);                                                    // Albums
    assert.deepStrictEqual(await rows(menu), ['Album One', 'Album Two']);
    menu.back();

    assert.strictEqual(await menu.select(home.length), 'refreshed');        // the switch entry
    assert.strictEqual(menu.stack.length, 1, 'back at the home list');
    assert.strictEqual(menu.props.Title, 'Home Menu: Audiobooks');
    const home2 = await menu.data(1, 100);
    assert.strictEqual(home2[home2.length - 1].L1, 'Library: Audiobooks');
    assert.strictEqual(home2[home2.length - 1].L2, 'Select to switch to Music');
    await menu.select(2);
    assert.deepStrictEqual(await rows(menu), ['Book One']);                  // browsing follows the library
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(libraryFile, 'utf8')), { library: 'Audiobooks' });

    const again = await new Menu(await make(srv, { library: 'Music', libraryFile }).home()).init();   // a restart keeps the last pick over the setting
    assert.strictEqual(again.props.Title, 'Home Menu: Audiobooks');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('library switch: a single music library shows no switch entry and a plain title', async () => {
  const srv = await mock([SECTIONS[0]]);
  try {
    const menu = await new Menu(await make(srv, {}).home()).init();
    assert.strictEqual(menu.props.Title, 'Home Menu');
    assert.ok(!(await rows(menu)).some(r => r.startsWith('Library:')));
  } finally { srv.close(); }
});
