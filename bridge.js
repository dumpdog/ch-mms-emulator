'use strict';
// Processor bridge: one TCP port per slot for a SIMPL+ module (processor/PlexampDeviceModule.usp) that stands in for a RoonDeviceModule zone.
// The module keeps the same joins, so the rest of the program (Media Object Router, Smart Object) is untouched.
//   module -> us   CRPC request strings from the module's CRPC input (chunked: '2F' 'Fc'|'Fe' <4 hex length> <text>), and 'CMD <name> [arg]\r\n' for the button joins
//   us -> module   CRPC reply chunks back to back, and 'FB <name> <value>\r\n' for the feedback joins
// The Crpc.Register reply points the Smart Object at the slot's normal direct-connect port, same as for an MMS symbol.

const net = require('net');
const { chunkJson, ChunkReader } = require('./cip');

const HEAD = /^2F(Fc|Fe)([0-9A-Fa-f]{4})/;
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(x).padStart(2, '0')}`; };

// feedback joins derived from the slot's properties
function feedback(p, direct = '') {
  const st = p.PlayerState, len = p.TrackSec || 0, pos = p.ElapsedSec || 0;
  const [a, t, al] = [p.Artist || '', p.Title || '', p.Album || ''];
  return {
    Available: 1, Name: p.PlayerName || '',
    Playing: st === 'playing' ? 1 : 0, Paused: st === 'paused' ? 1 : 0, Loading: 0, Stopped: st !== 'playing' && st !== 'paused' ? 1 : 0,
    NextAllowed: 1, PreviousAllowed: 1, PauseAllowed: st === 'playing' ? 1 : 0, PlayAllowed: st === 'playing' ? 0 : 1, SeekAllowed: len ? 1 : 0,
    ShowSeek: len ? 1 : 0, ShowLength: len ? 1 : 0, Shuffle: p.ShuffleState ? 1 : 0, Loop: p.RepeatState === 2 ? 1 : 0, LoopOne: p.RepeatState === 1 ? 1 : 0,
    AutoRadio: 0, Muted: 0, VolumeFixed: 1,
    LengthSeconds: len, PositionSeconds: pos, PositionNormalized: len ? Math.min(65535, Math.round(pos / len * 65535)) : 0,
    LengthSerial: fmt(len), PositionSerial: fmt(pos),
    OneLine: [a, t].filter(Boolean).join(' - '), Title: t, Artist: a, Album: al,
    Art: p.AlbumArtUrl || '', Error: '', VolumeType: 'Fixed', DirectInfo: direct,
  };
}

function startBridge({ slots, base, log, onConnect }) {
  const servers = slots.map((slot, n) => {
    const srv = net.createServer(sock => {
      sock.setEncoding('utf8'); sock.setNoDelay(true);
      log(`bridge[${slot.name}]: module connected from ${sock.remoteAddress}`);
      if (onConnect) onConnect(n, sock.localAddress.replace(/^::ffff:/, ''));
      const send = s => sock.destroyed || sock.write(s);
      const reader = new ChunkReader(async msg => {
        let req; try { req = JSON.parse(msg); } catch { return; }
        const res = await slot._dispatch(req);
        if (res) for (const ch of chunkJson(JSON.stringify(res))) send(ch);
      });
      let last = {}, lastDiag = '';
      const push = (all, force) => {
        const now = feedback(all, JSON.stringify({ ip: [`${slot.advertise().ip}:${slot.port}`] }));   // same text the MMS published on its DirectConnectInfo join
        for (const k of Object.keys(now)) if (force || now[k] !== last[k]) send(`FB ${k} ${now[k]}\r\n`);
        last = now;
      };
      const onState = (_patch, all) => push(all);
      slot.on('state', onState);
      const command = (name, arg) => {
        const pl = slot.backend.player, p = slot.p;
        const run = fn => Promise.resolve(fn && fn.call(pl)).catch(e => log(`bridge[${slot.name}]: ${name} failed: ${e.message}`));
        const want = (v, cur, fn) => { if (!!v !== !!cur) run(fn); };
        switch (name) {
          case 'Play': return run(pl.play); case 'Pause': return run(pl.pause); case 'Stop': return run(pl.stop);
          case 'PlayPause': return run(p.PlayerState === 'playing' ? pl.pause : pl.play);
          case 'Next': return run(pl.next); case 'Previous': return run(pl.prev);
          case 'ShuffleOn': return want(1, p.ShuffleState, pl.shuffle); case 'ShuffleOff': return want(0, p.ShuffleState, pl.shuffle);
          case 'ToggleShuffle': return run(pl.shuffle);
          case 'Loop': case 'LoopOne': case 'LoopOff': case 'ToggleLoop': {
            const target = name === 'Loop' ? 2 : name === 'LoopOne' ? 1 : name === 'LoopOff' ? 0 : ((p.RepeatState || 0) + 2) % 3;   // toggle order: queue > track > none
            let cur = p.RepeatState || 0;
            return (async () => { for (let i = 0; i < 3 && cur !== target; i++) { await run(pl.repeat); cur = (cur + 1) % 3; } })();
          }
          case 'Seek': return pl.seek && run(function () { return pl.seek({ sec: Number(arg) }); });
          case 'SeekNorm': return pl.seek && p.TrackSec && run(function () { return pl.seek({ sec: Math.round(Number(arg) / 65535 * p.TrackSec) }); });
          case 'Refresh': return push(p, true);
          case 'Diag': if (arg !== lastDiag) log(`bridge[${slot.name}]: module ${arg}`); lastDiag = arg; return;
          default: log(`bridge[${slot.name}]: ignored command ${name}`);
        }
      };
      let buf = '';
      sock.on('data', d => {
        if (process.env.MMS_CIP_TRACE) log(`bridge[${slot.name}]: rx ${d.length} chars: ${JSON.stringify(d.slice(0, 240))}`);
        buf += d;
        for (;;) {
          if (buf.startsWith('2F')) {   // a CRPC chunk: header says how much follows
            const m = HEAD.exec(buf); if (!m) { if (buf.length >= 8) buf = buf.slice(2); else break; continue; }
            const total = 8 + parseInt(m[2], 16);
            if (buf.length < total) break;
            reader.push(buf.slice(0, total)); buf = buf.slice(total);
          } else {
            const i = buf.search(/[\r\n]/); if (i < 0) { if (buf.length > 4096) { log(`bridge[${slot.name}]: dropped ${buf.length} chars with no line end: ${JSON.stringify(buf.slice(0, 80))}`); buf = ''; } break; }
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            const m = /^CMD (\S+)(?: (.*))?$/.exec(line);
            if (m) command(m[1], m[2]); else if (line) log(`bridge[${slot.name}]: ignored '${line.slice(0, 60)}'`);
          }
        }
      });
      push(slot.p, true);
      sock.on('close', () => slot.off('state', onState));
      sock.on('error', () => {});
    });
    return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(base ? base + n : 0, () => resolve(srv)); });
  });
  return Promise.all(servers).then(list => ({ ports: list.map(s => s.address().port), close() { list.forEach(s => s.close()); } }));
}

module.exports = { startBridge, feedback };
