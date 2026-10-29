'use strict';
// Processor bridge: a SIMPL+ module stands in for a RoonDeviceModule zone. Mock module = a TCP client speaking the chunk/line protocol.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const EventEmitter = require('events');
const { startEmulator } = require('../emulator');
const { chunkJson } = require('../cip');

const wait = (cond, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() { const v = cond(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('timeout: ' + cond)); setTimeout(poll, 10); })();
});

function backend() {
  const player = new EventEmitter(), calls = [];
  for (const m of ['play', 'pause', 'stop', 'next', 'prev']) player[m] = async () => { calls.push(m); };
  player.seek = async p => { calls.push(`seek ${p.sec}`); };
  player.shuffle = async () => { calls.push('shuffle'); };
  player.repeat = async () => { calls.push('repeat'); };
  return { providerName: 'Plex', player, calls, home: () => ({ title: 'Home Menu', items: [{ l1: 'Albums', play() {} }] }) };
}

test('bridge: CRPC handshake over the module link, feedback joins, button commands', async t => {
  const be = backend();
  const emu = await startEmulator({
    hostname: 'test-bridge', model: '3E', advertiseIp: '127.0.0.1', directBase: 0, bridgeBase: 0, httpPort: 0,
    createBackend: name => (name === 'Main' ? be : backend()), log: () => {},
  });
  t.after(() => emu.close());
  const sock = net.connect(emu.ports.bridge[0], '127.0.0.1'); sock.setEncoding('utf8');
  t.after(() => sock.destroy());
  let rx = ''; sock.on('data', d => { rx += d; });
  await wait(() => /FB Available 1\r\n/.test(rx));   // initial full feedback on connect
  assert.match(rx, /FB Name Main\r\n/);
  assert.match(rx, /FB Stopped 1\r\n/);

  // Crpc.Register in two chunks, as the Smart Object would split it; the reply points at the slot's direct port
  const req = JSON.stringify({ jsonrpc: '2.0', method: 'Crpc.Register', params: { name: 'Smart Object', padding: 'x'.repeat(300) }, id: 7 });
  const chunks = chunkJson(req); assert.ok(chunks.length > 1);
  for (const c of chunks) sock.write(c);
  const replies = () => {   // reassemble chunked CRPC replies from the rx stream (feedback lines are skipped)
    const out = []; let acc = '', i = 0;
    while (i < rx.length) {
      const m = /^2F(Fc|Fe)([0-9A-Fa-f]{4})/.exec(rx.slice(i));
      if (!m) { const j = rx.indexOf('\n', i); if (j < 0) break; i = j + 1; continue; }
      const n = parseInt(m[2], 16); if (rx.length < i + 8 + n) break;
      acc += rx.slice(i + 8, i + 8 + n); i += 8 + n;
      if (m[1] === 'Fe') { out.push(JSON.parse(acc)); acc = ''; }
    }
    return out;
  };
  await wait(() => replies().length);
  const reply = replies()[0];
  assert.strictEqual(reply.id, 7);
  assert.strictEqual(reply.result.connections['cip-direct/json-rpc'].ip, '127.0.0.1');
  assert.strictEqual(reply.result.connections['cip-direct/json-rpc'].port, String(emu.slots[0].port));

  // state from the player becomes feedback lines
  be.player.emit('state', { PlayerState: 'playing', Title: 'Song', Artist: 'Band', Album: 'LP', TrackSec: 200, ElapsedSec: 50, ShuffleState: 1, RepeatState: 2 });
  await wait(() => /FB Playing 1\r\n/.test(rx) && /FB LoopOne 0\r\n/.test(rx) && /FB PositionNormalized 16384\r\n/.test(rx));
  for (const l of ['FB Stopped 0', 'FB Shuffle 1', 'FB Loop 1', 'FB OneLine Band - Song', 'FB LengthSerial 3:20', 'FB PositionSerial 0:50']) assert.ok(rx.includes(l + '\r\n'), l);

  // buttons
  sock.write('CMD Play\r\nCMD Next\r\nCMD ShuffleOff\r\nCMD Seek 30\r\nCMD SeekNorm 32768\r\nCMD LoopOff\r\n');
  await wait(() => be.calls.length >= 6);
  assert.deepStrictEqual(be.calls, ['play', 'next', 'shuffle', 'seek 30', 'seek 100', 'repeat']);
});
