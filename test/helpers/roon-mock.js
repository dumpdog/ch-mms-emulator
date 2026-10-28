'use strict';
// A stand-in for roon-core.js with a small Roon-like browse server. Like Roon it keeps one stack of levels per session and rejects
// an item key unless it came from the deepest level, so a backend that lets its own stack drift from the server's fails its test.
const EventEmitter = require('events');

const tracksOf = album => ['Come Together', 'Something'].map(t => ({ title: `${t} (${album})`, subtitle: 'The Beatles', hint: 'action_list',
  child: { title: t, items: ['Play Now', 'Add Next', 'Queue'].map(a => ({ title: a, hint: 'action' })) } }));
const artist = name => ({ title: name, hint: 'list', child: { title: name, items: [{ title: 'Abbey Road', hint: 'list', child: { title: 'Abbey Road', items: tracksOf('Abbey Road') } }] } });
const ARTISTS = ['!!!', '2Pac', 'ABBA', 'Adele', 'Bach', 'Beatles', 'Beck', 'Cher', 'Daft Punk', 'Zappa'];
const library = () => ({
  browse: { title: 'Explore', items: [
    { title: 'Library', hint: 'list', child: { title: 'Library', items: [
      { title: 'Artists', hint: 'list', child: { title: 'Artists', items: ARTISTS.map(artist) } },
      { title: 'Albums', hint: 'list', child: { title: 'Albums', items: [{ title: 'Abbey Road', hint: 'list', child: { title: 'Abbey Road', items: tracksOf('Abbey Road') } }] } },
      { title: 'Tracks', hint: 'list', child: { title: 'Tracks', items: tracksOf('Tracks') } },
    ] } },
    { title: 'Playlists', hint: 'list', child: { title: 'Playlists', items: [{ title: 'Road Trip', hint: 'action_list', child: { title: 'Road Trip', items: [{ title: 'Play Now', hint: 'action' }] } }] } },
  ] },
  search: { title: 'Search', items: [{ title: 'Search', input_prompt: { prompt: 'Search' }, child: input => ({ title: `Results for ${input}`,
    items: [{ title: 'Artists', hint: 'list', child: { title: 'Artists', items: [artist('Beatles')] } }, ...tracksOf('Search')] }) }] },
});

function server(roots) {
  const sessions = {}; let serial = 0;
  const sess = o => (sessions[`${o.hierarchy}|${o.multi_session_key || ''}`] ||= { stack: [], ids: [] });
  const push = (s, node) => { s.stack.push(node); s.ids.push(++serial); };
  const listOf = s => ({ action: 'list', list: { title: s.stack[s.stack.length - 1].title, count: s.stack[s.stack.length - 1].items.length, level: s.stack.length - 1 } });
  return {
    sessions, actions: [],
    browse(o) {
      const s = sess(o);
      if (o.pop_all || !s.stack.length) { s.stack = [roots[o.hierarchy]]; s.ids = [++serial]; if (o.pop_all) return listOf(s); }
      if (o.pop_levels) { s.stack.length = Math.max(1, s.stack.length - o.pop_levels); s.ids.length = s.stack.length; return listOf(s); }
      if (!o.item_key) return listOf(s);
      const [lvl, idx, id] = o.item_key.split(':').map(Number), top = s.stack.length - 1;
      if (lvl !== top || id !== s.ids[top]) throw new Error('InvalidItemKey');
      const it = s.stack[top].items[idx];
      if (it.hint === 'action') { this.actions.push({ title: it.title, zone: o.zone_or_output_id }); return { action: 'none' }; }
      const child = typeof it.child === 'function' ? it.child(o.input) : it.child;
      if (!child) return { action: 'message', message: 'Nothing here', is_error: false };
      push(s, child); return listOf(s);
    },
    load(o) {
      const s = sess(o), level = o.level ?? s.stack.length - 1, node = s.stack[level];
      if (!node) throw new Error('InvalidLevel');
      const items = node.items.slice(o.offset || 0, (o.offset || 0) + (o.count || 100)).map((it, i) => ({ title: it.title, subtitle: it.subtitle, hint: it.hint, image_key: it.image_key,
        input_prompt: it.input_prompt, item_key: `${level}:${(o.offset || 0) + i}:${s.ids[level]}` }));
      return { items, offset: o.offset || 0, list: { title: node.title, count: node.items.length, level } };
    },
    depth: h => (Object.entries(sessions).find(([k]) => k.startsWith(`${h}|`)) || [0, { stack: [] }])[1].stack.length,
  };
}

function zone(over = {}) {
  return { zone_id: 'z1', display_name: 'Living Room', state: 'stopped', is_next_allowed: true, is_previous_allowed: true, is_seek_allowed: true,
    settings: { shuffle: false, loop: 'disabled' }, outputs: [{ display_name: 'Living Room' }], ...over };
}

function makeCore({ zones = [zone()], ready = true } = {}) {
  const events = new EventEmitter(), srv = server(library()), st = { zones, ready }, calls = [];
  const rec = name => async (...a) => { calls.push([name, ...a]); };
  return {
    events, calls, srv,
    ready: () => st.ready,
    zoneByName: n => st.zones.find(z => z.display_name.toLowerCase() === String(n).toLowerCase()) || null,
    control: rec('control'), seek: rec('seek'), settings: rec('settings'), playFromHere: rec('playFromHere'),
    browse: async o => srv.browse(o), load: async o => srv.load(o),
    image: async (key, opts) => { calls.push(['image', key, opts]); return { type: 'image/jpeg', body: Buffer.from(key) }; },
    queue: async () => [{ queue_item_id: 7, image_key: 'q', three_line: { line1: 'Next Song', line2: 'Someone' } }],
    set(zs) { st.zones = zs; events.emit('zones', { changed: zs, removed: [] }); },
    pair(on) { st.ready = on; events.emit(on ? 'paired' : 'unpaired'); },
  };
}

module.exports = { makeCore, zone };
