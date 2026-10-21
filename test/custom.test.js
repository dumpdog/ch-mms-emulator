'use strict';
// Crestron Custom: static masters. Two mock processors (different IP-IDs); slots Main+A go to the first, Player B to the second, the rest nowhere.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { startEmulator } = require('../emulator');
const { createDemoBackend } = require('../backend-demo');
const { parseMasters, parseMaster } = require('../masters');
const { T, frame, Deframer, parseSerial } = require('../cip');

const wait = (cond, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() { const v = cond(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('timeout: ' + cond)); setTimeout(poll, 10); })();
});

function mockProcessor() {
  const got = { register: null, serials: new Map() }, socks = new Set();
  const srv = net.createServer(sock => {
    socks.add(sock);
    sock.write(frame(T.READY, Buffer.from([2])));
    const df = new Deframer((type, p) => {
      if (type === T.REGISTER) { got.register = p; sock.write(frame(T.ACK, Buffer.from([0, 0, 0, 0x1b]))); }
      else if (type === T.SERIAL) { const s = parseSerial(p); if (s) got.serials.set(s.join, s.text); }
    });
    sock.on('data', d => df.push(d));
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ got, port: srv.address().port, close: () => { for (const k of socks) k.destroy(); srv.close(); } })));
}

test('masters: parsing, per-slot override, shared processor+IP-ID, errors', () => {
  const keys = ['MAIN', 'A', 'B', 'C', 'D', 'USB'];
  assert.deepStrictEqual(parseMaster('192.168.4.5@0a', 'x'), { host: '192.168.4.5', port: 41794, ipid: 10 });
  assert.deepStrictEqual(parseMaster('10.0.0.2:41795@1F', 'x'), { host: '10.0.0.2', port: 41795, ipid: 31 });
  const m = parseMasters({ MMS_MASTER: '192.168.4.5@0A', MMS_B_MASTER: '192.168.4.6@0B', MMS_USB_MASTER: '192.168.4.5@0A' }, keys);
  assert.deepStrictEqual(m.map(x => [x.host, x.ipid, x.slots]), [['192.168.4.5', 10, [0, 1, 3, 4, 5]], ['192.168.4.6', 11, [2]]]);
  assert.throws(() => parseMasters({}, keys), /needs MMS_MASTER/);
  assert.throws(() => parseMaster('192.168.4.5', 'MMS_MASTER'), /expected <processor ip>/);
  assert.throws(() => parseMaster('192.168.4.5@FF', 'MMS_MASTER'), /outside 03..FE/);
});

test('custom: one CIP client per processor/IP-ID, only its own slots published, no console or discovery', async t => {
  const p1 = await mockProcessor(), p2 = await mockProcessor();
  t.after(() => { p1.close(); p2.close(); });
  const emu = await startEmulator({
    hostname: 'test-custom', model: '5A', advertiseIp: '127.0.0.1', directBase: 0, httpPort: 0,
    masters: [{ host: '127.0.0.1', port: p1.port, ipid: 10, slots: [0, 1] }, { host: '127.0.0.1', port: p2.port, ipid: 11, slots: [2] }],
    createBackend: () => createDemoBackend(), log: () => {},
  });
  t.after(() => emu.close());
  assert.strictEqual(emu.ports.console, null); assert.strictEqual(emu.ports.discovery, null);

  await wait(() => p1.got.register && p2.got.register && p1.got.serials.has(41) && p2.got.serials.has(42));
  assert.strictEqual(p1.got.register.readUInt16BE(4), 10); assert.strictEqual(p2.got.register.readUInt16BE(4), 11);
  const port = n => emu.slots[n].port;
  assert.deepStrictEqual(JSON.parse(p1.got.serials.get(40)), { ip: [`127.0.0.1:${port(0)}`] });   // Main
  assert.deepStrictEqual(JSON.parse(p1.got.serials.get(41)), { ip: [`127.0.0.1:${port(1)}`] });   // Player A
  assert.deepStrictEqual(JSON.parse(p2.got.serials.get(42)), { ip: [`127.0.0.1:${port(2)}`] });   // Player B
  assert.ok(!p1.got.serials.has(42) && !p2.got.serials.has(40) && !p2.got.serials.has(41), 'slots stay with their own processor');
  assert.ok(![43, 44, 45].some(j => p1.got.serials.has(j) || p2.got.serials.has(j)), 'slots with no master are not published');
});

test('smart graphics: Find is offered, searches and lands on a results list', async t => {
  const { Slot } = require('../slot');
  const slot = new Slot({ index: 1, name: 'Main', backend: createDemoBackend(), port: 0, advertise: () => ({ ip: '127.0.0.1', httpHost: '127.0.0.1' }), log: () => {} });
  await slot.start(); t.after(() => slot.stop());
  const call = async (method, params = {}) => (await slot._dispatch({ method, params, id: 1 })).result;
  const prop = async n => (await call('MirageMediaMenu1.GetProperty', { propName: n }))[n];

  assert.ok(!(await prop('ListSpecificFunctions')).includes('Find'), 'Crestron Home clients never see Find');
  await call('Crpc.Register', { name: 'Smart Graphics=abc' });
  assert.deepStrictEqual((await prop('ListSpecificFunctions'))[0], 'Find');
  assert.deepStrictEqual([await prop('FindAvailable'), await prop('FindSupported')], [true, ['Text']]);

  assert.strictEqual(await call('MirageMediaMenu1.Find', { query: 'piano' }), 1);
  assert.strictEqual(await prop('Title'), 'Search: piano');
  assert.strictEqual(await prop('FindDesired'), 'piano');
  assert.deepStrictEqual((await call('MirageMediaMenu1.GetData', { item: 1, count: 5 })).map(r => r.L1), ['Quiet Piano']);
  assert.strictEqual(await call('MirageMediaMenu1.Search'), true);
});
