'use strict';
// Mock-processor test: replays the add/browse sequence observed in the real MMS captures against the emulator.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const dgram = require('dgram');
const { T, frame, Deframer, serialFrame, parseSerial, digitalFrame, parseDigital, chunkJson, ChunkReader } = require('../cip');
const { startEmulator } = require('../emulator');
const { createDemoBackend } = require('../backend-demo');

const BANNER_END = '\n\n\r\n';   // the real MMS console banner ends with this
const wait = (cond, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() { const v = cond(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('timeout waiting: ' + cond)); setTimeout(poll, 10); })();
});

test('discover, add, register, config, browse, play', async t => {
  const emu = await startEmulator({
    hostname: 'test-mms', model: '5A', advertiseIp: '127.0.0.1', discoveryPort: 0, consolePort: 0, directBase: 0, httpPort: 0,
    createBackend: () => createDemoBackend(), log: () => {},
  });
  t.after(() => emu.close());

  // ---- 1. UDP discovery
  const u = dgram.createSocket('udp4');
  const reply = await new Promise((res, rej) => {
    u.once('message', res); setTimeout(() => rej(new Error('no discovery reply')), 2000);
    const q = Buffer.alloc(266); Buffer.from([0x14, 0, 0, 0, 1, 4, 0, 3, 0, 0]).copy(q); q.write('192.168.1.7', 10);
    u.send(q, emu.ports.discovery, '127.0.0.1');
  });
  u.close();
  assert.strictEqual(reply.length, 394);
  assert.deepStrictEqual([...reply.subarray(0, 10)], [0x15, 0, 0, 0, 1, 0x84, 0, 0, 0, 0]);
  assert.strictEqual(reply.subarray(10).toString('latin1').split('\0')[0], 'test-mms');
  assert.match(reply.subarray(266).toString('latin1').split('\0')[0], /^AUTONOMIC-MMS-5A \[v6\.8\.20260224\.2 \(Feb 25 2026\), \*01000000[0-9A-F]{12}\]$/);

  // ---- 2. mock processor CIP listener
  const serials = new Map();      // join -> [texts]
  const digitals = new Map();     // join -> last value
  let register = null, cipConn = null;
  const crpcOut = [0, 1, 2, 3, 4, 5].map(() => []);
  const readers = crpcOut.map(a => new ChunkReader(m => a.push(JSON.parse(m))));
  const cipSrv = net.createServer(sock => {
    cipConn = sock;
    sock.write(frame(T.READY, Buffer.from([2])));
    const df = new Deframer((type, p) => {
      if (type === T.REGISTER) { register = p; sock.write(frame(T.ACK, Buffer.from([0, 0, 0, 0x1b]))); }
      else if (type === T.SERIAL) {
        const s = parseSerial(p);
        if (s.join >= 1 && s.join <= 6) readers[s.join - 1].push(s.text);
        else { if (!serials.has(s.join)) serials.set(s.join, []); serials.get(s.join).push(s.text); }
      } else if (type === T.DATA) { const d = parseDigital(p); if (d) digitals.set(d.join, d.value); }
      else if (type === T.PING) sock.write(frame(T.PONG, p));
    });
    sock.on('data', d => df.push(d));
    sock.on('error', () => {});
  });
  await new Promise(r => cipSrv.listen(0, '127.0.0.1', r));
  t.after(() => { cipSrv.close(); cipConn && cipConn.destroy(); });

  // ---- 3. console add sequence
  const con = net.connect(emu.ports.console, '127.0.0.1');
  let out = ''; con.on('data', d => (out += d));
  await wait(() => out.includes('Server=') && out.endsWith(BANNER_END));
  assert.strictEqual(out.length, 228);                       // same length as the real MMS banner (12-char server id)
  assert.match(out, /Autonomic Controls Media Control Server version 6\.8\.20260224\.2 Release\./);
  const cmd = async c => { const n = out.length; con.write(c + '\r\n'); await wait(() => out.length > n && out.endsWith('\r\n')); return out.slice(n).trim(); };
  assert.match(await cmd('getlicensemessage'), /^LicenseMessage "Licensed for general PolyTune streaming use by eSeries ES\.  Serial number: [0-9a-f-]{36}"$/);
  assert.strictEqual(await cmd('ipt'), 'No Entries');
  assert.strictEqual(await cmd(`addmaster B MC4-R-TEST ${cipSrv.address().port}`), 'Ack');
  con.destroy();

  // ---- 4. CIP registration + published state
  await wait(() => register);
  assert.strictEqual(register.length, 11);
  assert.deepStrictEqual([...register.subarray(0, 4)], [127, 0, 0, 1]);
  assert.strictEqual(register.readUInt16BE(4), 0xB);               // console IP-IDs are hex
  await wait(() => [40, 41, 42, 43, 44, 45].every(j => serials.has(j)));
  const direct = [40, 41, 42, 43, 44, 45].map(j => JSON.parse(serials.get(j)[0]).ip[0]);
  direct.forEach((a, i) => assert.strictEqual(a, `127.0.0.1:${emu.slots[i].port}`));
  await wait(() => serials.get(12) && serials.get(12).includes('Ready'));
  assert.ok(serials.get(11).includes('[CurrentProvider||None,0]'));
  assert.strictEqual(digitals.get(203), true);                      // Player A stopped feedback

  // ---- 5. config strings
  const lastOn = (j, pred) => wait(() => (serials.get(j) || []).find(pred));
  cipConn.write(serialFrame(12, 'Global:ProvidersList'));
  assert.match(await lastOn(12, s => s.startsWith('[Providers,')), /^\[Providers,1\|\|My Music,MyMusic,http:\/\/127\.0\.0\.1:\d+\/getart\?guid=0{8}-0{4}-0{4}-0{4}-0{12}&h=500&w=500&c=1&fmt=png&ext=\.png,1\]$/);
  cipConn.write(serialFrame(12, 'Global:AccountsList'));
  await lastOn(12, s => s === '[Accounts,0||]');
  cipConn.write(serialFrame(12, 'Select:MyMusic'));
  await lastOn(12, s => s === '[CurrentProvider||MyMusic,11]'); await lastOn(12, s => s === '[CurrentProvider||MyMusic,1]');

  // ---- 6. crpc probe over the serial join (chunked)
  const big = JSON.stringify({ jsonrpc: '2.0', method: 'Crpc.Register', params: { ver: '1.0', name: 'TestClient', uuid: 'x'.repeat(300), supportedFormats: ['JSON'] }, id: 1 });
  for (const c of chunkJson(big)) cipConn.write(serialFrame(2, c));
  const probe = await wait(() => crpcOut[1][0]);
  assert.strictEqual(probe.result.name, 'MirageCrpcService2');
  assert.strictEqual(probe.result.connections['cip-direct/json-rpc'].port, String(emu.slots[1].port));

  // ---- 7. direct connection: browse and play on Player A
  const dc = net.connect(emu.slots[1].port, '127.0.0.1');
  const msgs = []; let ack = false;
  const ddf = new Deframer((type, p) => { if (type === T.ACK) ack = true; if (type === T.JSON) msgs.push(JSON.parse(p.subarray(1).toString())); });
  dc.on('data', d => ddf.push(d)); t.after(() => dc.destroy());
  dc.write(frame(T.LOGIN, Buffer.from('0000a3474402ffff000164756d6d79', 'hex')));
  await wait(() => ack);
  let id = 0;
  const rpc = async (method, params) => {
    const mine = ++id; dc.write(frame(T.JSON, Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params, id: mine }))])));
    return wait(() => msgs.find(m => m.id === mine && ('result' in m)));
  };
  const events = (obj, ev) => msgs.filter(m => m.method === `${obj}.Event` && m.params.ev === ev);

  assert.strictEqual((await rpc('Crpc.Register', { ver: '1.0', name: 'CrestronHome', type: 'cip-direct/json-rpc' })).result.name, 'MirageCrpcService2');
  const objs = (await rpc('Crpc.GetObjects', null)).result.objects.object;
  assert.deepStrictEqual(objs.map(o => o.instanceName), ['MirageMediaPlayer2', 'MirageMediaMenu2']);
  await rpc('Crpc.RegisterEvent', { ev: 'ObjectDirectoryChanged', handle: 'h0' });
  for (const [o, e] of [['MirageMediaPlayer2', 'BusyChanged'], ['MirageMediaPlayer2', 'StateChanged'], ['MirageMediaMenu2', 'BusyChanged'], ['MirageMediaMenu2', 'StateChanged'], ['MirageMediaMenu2', 'ClearChanged']])
    await rpc(`${o}.RegisterEvent`, { ev: e, handle: `h-${o}-${e}` });
  const props = (await rpc('MirageMediaPlayer2.GetProperty', { propName: null })).result;
  assert.strictEqual(props.PlayerName, 'Player A'); assert.strictEqual(props.Instance, 2);
  assert.deepStrictEqual((await rpc('MirageMediaPlayer2.GetMenu', { uuid: '00000000-0000-0000-0000-000000000000' })).result, { instanceName: 'MirageMediaMenu2' });

  assert.strictEqual((await rpc('MirageMediaMenu2.GetProperty', { propName: 'Title' })).result.Title, 'Home Menu');
  assert.strictEqual((await rpc('MirageMediaMenu2.GetProperty', { propName: 'ItemCnt' })).result.ItemCnt, 1);
  const missing = await rpc('MirageMediaMenu2.GetProperty', { propName: 'Subtitle' });
  assert.strictEqual(missing.error.code, -32001);
  assert.deepStrictEqual((await rpc('MirageMediaMenu2.GetData', { item: 1, count: 1 })).result, [{ L1: 'My Music', L2: '', URL: '' }]);

  assert.strictEqual((await rpc('MirageMediaMenu2.Select', { item: 1 })).result, true);          // My Music
  await wait(() => events('MirageMediaMenu2', 'StateChanged').length === 1);
  assert.deepStrictEqual(events('MirageMediaMenu2', 'StateChanged')[0].params.parameters, { Title: 'My Music', ItemCnt: 3, Level: 1 });
  assert.deepStrictEqual((await rpc('MirageMediaMenu2.GetData', { item: 1, count: 3 })).result.map(r => r.L1), ['Albums', 'Artists', 'Songs']);
  await rpc('MirageMediaMenu2.Select', { item: 3 });                                                // Songs
  await wait(() => events('MirageMediaMenu2', 'StateChanged').length === 2);
  assert.deepStrictEqual(events('MirageMediaMenu2', 'StateChanged')[1].params.parameters, { Title: 'Titles', ItemCnt: 3, Level: 2 });
  const songs = (await rpc('MirageMediaMenu2.GetData', { item: 1, count: 3 })).result;
  assert.deepStrictEqual(songs.map(r => r.L1), ['Highway Blues', 'Symphony No. 9 (Scherzo)', 'Quiet Piano']);

  assert.strictEqual((await rpc('MirageMediaMenu2.Select', { item: 2 })).result, true);            // play a track
  await wait(() => events('MirageMediaPlayer2', 'StateChanged').some(e => e.params.parameters.PlayerState === 'playing'));
  const titled = events('MirageMediaPlayer2', 'StateChanged').find(e => e.params.parameters.Title);
  assert.strictEqual(titled.params.parameters.Title, 'Symphony No. 9 (Scherzo)');
  assert.deepStrictEqual(titled.params.parameters.TextLines.slice(0, 2), ['Various Artists', 'Symphony No. 9 (Scherzo)']);
  await wait(() => digitals.get(201) === true && digitals.get(203) === false);                      // playing feedback on the CIP side
  assert.ok((serials.get(231) || []).includes('Various Artists') || (serials.get(232) || []).includes('Various Artists'));

  assert.strictEqual((await rpc('MirageMediaMenu2.PressAndHold', { item: 3 })).result, true);       // context menu
  await wait(() => events('MirageMediaMenu2', 'StateChanged').length === 3);
  assert.deepStrictEqual(events('MirageMediaMenu2', 'StateChanged')[2].params.parameters, { Title: 'Quiet Piano', ItemCnt: 2, Level: 2 });
  assert.deepStrictEqual((await rpc('MirageMediaMenu2.GetData', { item: 1, count: 2 })).result.map(r => r.L1), ['Play now', 'Play next']);
  assert.deepStrictEqual((await rpc('MirageMediaMenu2.GetProperty', { propName: 'ListSpecificFunctions' })).result.ListSpecificFunctions, ['QuickList', 'Favorites', 'BackToTop']);

  assert.strictEqual((await rpc('MirageMediaPlayer2.Pause', null)).result, true);
  await wait(() => digitals.get(202) === true);
  assert.strictEqual((await rpc('MirageMediaPlayer2.Stop', null)).result, true);

  cipConn.write(digitalFrame(201, true));                                                           // processor presses Player A "play"
  await wait(() => digitals.get(201) === true && digitals.get(203) === false);

  const bad = await rpc('MirageMediaPlayer2.Bogus', null);
  assert.strictEqual(bad.error.code, -32601);
});
