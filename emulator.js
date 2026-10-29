'use strict';
// MMS emulator: discovery (UDP 41794) + console (TCP 5004) + outbound CIP client + per-slot CRPC servers.
// Flow: processor scans -> we answer -> processor runs `addmaster <ipid> <host> <port>` on the console
// -> we dial out to the processor's CIP port, register as that IP-ID, publish direct-connect addresses and config strings
// -> the processor connects to our per-slot CRPC ports and browses.

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { T, frame, Deframer, serialFrame, parseSerial, digitalFrame, parseDigital, chunkJson, ChunkReader } = require('./cip');
const { startDiscovery } = require('./discovery');
const { startConsole } = require('./console');
const { Slot } = require('./slot');

const MODELS = { '3E': ['Main', 'Player A', 'Player B'], '5A': ['Main', 'Player A', 'Player B', 'Player C', 'Player D', 'USB'] };
const NIL_GUID = '00000000-0000-0000-0000-000000000000';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const J = { CRPC: 1, CONFIG: parseInt(process.env.MMS_CONFIG_BASE || '11', 10), DIRECT: parseInt(process.env.MMS_DIRECT_BASE || '40', 10), ART: 130, PLAY: 101 };   // base joins; per-slot offsets: +n, +n, +n, +100n, +100n

// processor -> MMS button joins, offset from 101+100n: play, pause, (stopped fb only), rewind, ff, track+, track-
const DIGITAL_INPUTS = { 0: 'play', 1: 'pause', 5: 'next', 6: 'prev' };

const localIp = () => {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
};

// Crestron shows "<output label> <provider description>" on its Services screen. It drops a provider with an empty description and,
// once trimmed, an empty name falls back to "Dynamic Media Source ID #n", so the default is U+00AD (soft hyphen): a Latin-1 character that Crestron
// does not trim and a font draws as nothing (U+0080 showed as a square on the touch panel); needs the one-byte Latin-1 encoding in cip.js. MMS_PROVIDER_LABEL overrides it with visible text.
const providerLabel = v => ((v ?? '').trim() && (v ?? '').trim().toLowerCase() !== 'none' ? v.trim() : '­');

async function startEmulator(cfg) {
  const log = cfg.log || (() => {});
  const names = MODELS[cfg.model];
  if (!names) throw new Error(`unsupported model ${cfg.model}`);
  const hostname = cfg.hostname;
  const serverId = cfg.serverId || crypto.createHash('sha1').update(hostname).digest('hex').slice(0, 12).toUpperCase();
  const description = `MMS-EMULATOR-${cfg.model} [v1.0, *01000000${serverId}]`;
  const licenseSerial = cfg.licenseSerial || crypto.createHash('sha1').update('lic' + hostname).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');

  let master = null, advertisedIp = cfg.advertiseIp || null;
  const slotIp = {};   // slot index -> our local address toward the processor that owns it (Custom can have several processors on different subnets)
  let httpPort = cfg.httpPort;
  const advertiseFor = n => {
    const ip = cfg.advertiseIp || slotIp[n] || advertisedIp || localIp();
    return { ip, httpHost: httpPort === 80 ? ip : `${ip}:${httpPort}` };
  };
  const advertise = () => advertiseFor(-1);

  // ---- slots
  const slots = [];
  for (let n = 0; n < names.length; n++) {
    const backend = cfg.createBackend(names[n], n);
    const slot = new Slot({ index: n + 1, name: names[n], backend, port: cfg.directBase ? cfg.directBase + n : 0, advertise: () => advertiseFor(n), log });
    await slot.start();
    slot.port = slot.server.address().port;
    slot.cur = { name: 'None', idx: 0 };
    if (backend.start) backend.start().catch(() => {});   // begin polling the player right away; errors are logged by the backend
    slot.on('state', (patch, all) => pushSlotState(n, patch, all));
    slots.push(slot);
  }

  // ---- HTTP art
  const httpd = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/getart') { res.writeHead(404).end(); return; }
    const guid = (u.searchParams.get('guid') || '').replace(/[{}]/g, '');
    let img = null;
    for (const s of slots) { if (s.backend.art) { try { img = await s.backend.art(guid); } catch {} if (img) break; } }
    const body = img ? (img.body || img) : PNG_1PX;
    res.writeHead(200, { 'Content-Type': (img && img.type) || 'image/png', 'Cache-Control': 'max-age=3600' }).end(body);
  });
  await new Promise((resolve, reject) => { httpd.once('error', reject); httpd.listen(httpPort, () => resolve()); });
  httpPort = httpd.address().port;

  // ---- CIP clients (outbound to the processor). Crestron Home: one master, learned from the console `addmaster`.
  // Crestron Custom: static masters from cfg.masters ({ host, port, ipid, slots: [slot indexes] }), one client per distinct (processor, IP-ID).
  const clients = new Map();   // "host:port:ipid" -> { m, slots, sock, retry, readers }
  const send = (c, buf) => c.sock && !c.sock.destroyed && c.sock.write(buf);
  const ser = (c, join, text) => send(c, serialFrame(join, text));
  const dig = (c, join, v) => send(c, digitalFrame(join, v));

  const label = providerLabel(cfg.providerLabel);
  const providers = () => `[Providers,1||${label},MyMusic,http://${advertise().httpHost}/getart?guid=${NIL_GUID}&h=500&w=500&c=1&fmt=png&ext=.png,1]`;
  const currentProvider = s => `[CurrentProvider||${s.cur.name},${s.cur.idx}]`;

  function publishAll(c) {
    c.slots.forEach(n => {
      const s = slots[n], { ip } = advertiseFor(n);
      ser(c, J.DIRECT + n, JSON.stringify({ ip: [`${ip}:${s.port}`] }));
      if (n === 0 && process.env.MMS_DIRECT_SPRAY) for (let j = 36; j <= 50; j++) ser(c, j, JSON.stringify({ ip: [`${ip}:${s.port}`] }));   // test only: which join is Main's DirectConnectInfo in a Custom program
      ser(c, J.CONFIG + n, currentProvider(s));
      ser(c, J.ART + 100 * n, s.p.AlbumArtUrl);
      ser(c, J.CONFIG + n, 'Ready');
      dig(c, J.PLAY + 100 * n, false); dig(c, J.PLAY + 100 * n + 1, false); dig(c, J.PLAY + 100 * n + 2, true);
    });
  }

  function pushSlotState(n, patch, all) {
    for (const c of clients.values()) {
      if (!c.slots.includes(n)) continue;
      if ('PlayerState' in patch) {
        dig(c, J.PLAY + 100 * n, all.PlayerState === 'playing'); dig(c, J.PLAY + 100 * n + 1, all.PlayerState === 'paused'); dig(c, J.PLAY + 100 * n + 2, all.PlayerState !== 'playing' && all.PlayerState !== 'paused');
      }
      if (patch.TextLines) patch.TextLines.forEach((t, i) => ser(c, J.ART + 100 * n + 1 + i, t));
      if (patch.AlbumArtUrl) ser(c, J.ART + 100 * n, patch.AlbumArtUrl);
    }
  }

  function onConfig(c, n, text) {
    const s = slots[n], [cmd, arg] = [text.split(':')[0] + ':', text.split(':').slice(1).join(':')];
    const reply = t => ser(c, J.CONFIG + n, t);
    if (text === 'Global:ProvidersList') reply(providers());
    else if (text === 'Global:AccountsList') reply('[Accounts,0||]');
    else if (text === 'Global:CurrentProvider') reply(currentProvider(s));
    else if (cmd === 'Select:') {
      s.cur = { name: arg, idx: 1 };
      s.menu.backToTop();
      reply(`[CurrentProvider||${arg},11]`); reply(`[CurrentProvider||${arg},1]`);
    } else log(`config[${n}]: ${text}`);
  }

  function connectCip(c) {
    clearTimeout(c.retry);
    if (c.sock) c.sock.destroy();
    const m = c.m;
    const sock = c.sock = net.connect(m.port, m.host);
    let ping = null, lastRx = Date.now();
    sock.on('connect', () => {
      log(`cip: connected to ${m.host}:${m.port} as IP-ID ${m.ipid.toString(16).toUpperCase()}`);
      const local = sock.localAddress.replace(/^::ffff:/, '');
      for (const n of c.slots) slotIp[n] = local;
      if (!cfg.advertiseIp) advertisedIp = local;
    });
    const df = new Deframer((type, payload) => {
      lastRx = Date.now();
      if (process.env.MMS_CIP_TRACE) log(`cip: rx type=${type.toString(16)} ${payload.toString('hex').slice(0, 160)}`);
      if (type === T.READY) {
        const reg = Buffer.alloc(11);
        Buffer.from(m.host.split('.').map(Number)).copy(reg, 0);
        reg.writeUInt16BE(m.ipid, 4); Buffer.from([0x40, 0, 0, 0x71, 0x01]).copy(reg, 6);
        sock.write(frame(T.REGISTER, reg));
      } else if (type === T.ACK) {
        if (!m.online) { m.online = true; log('cip: registered'); }
        sock.write(frame(T.DATA, Buffer.from([0, 0, 2, 3, 0])));
        publishAll(c);
        ping = setInterval(() => { if (Date.now() - lastRx > 10000) sock.destroy(); else sock.write(frame(T.PING, Buffer.from([0, 0]))); }, 1000);
      } else if (type === T.PING) sock.write(frame(T.PONG, payload));
      else if (type === T.SERIAL) {
        const p = parseSerial(payload); if (!p) return;
        const crpcN = p.join - J.CRPC, cfgN = p.join - J.CONFIG;
        if (c.readers.has(crpcN)) c.readers.get(crpcN).push(p.text);
        else if (c.slots.includes(cfgN)) onConfig(c, cfgN, p.text);
        else log(`cip: serial ${p.join}: ${p.text}`);
      } else if (type === T.DATA) {
        if (payload.length === 5 && payload[2] === 2 && payload[3] === 3 && payload[4] === 0) { log('cip: update request, republishing'); publishAll(c); return; }   // processor asks for all joins (Custom ignores what we sent before it asked)
        const d = parseDigital(payload);
        if (d) {
          log(`cip: digital ${d.join}=${d.value}`);
          const n = Math.floor((d.join - J.PLAY) / 100), fn = DIGITAL_INPUTS[(d.join - J.PLAY) % 100];
          if (d.value && fn && c.slots.includes(n)) Promise.resolve(slots[n].backend.player[fn]()).catch(e => log(`cip: ${fn} failed: ${e.message}`));
        }
      }
    });
    sock.on('data', d => df.push(d));
    sock.on('error', e => log(`cip: ${e.code || e.message}`));
    sock.on('close', () => {
      clearInterval(ping); if (m.online) log('cip: disconnected'); m.online = false;
      if (clients.get(c.key) === c && c.sock === sock) c.retry = setTimeout(() => connectCip(c), 5000);
    });
  }

  function addClient(m, slotIdxs) {
    const key = `${m.host}:${m.port}:${m.ipid}`;
    const c = { key, m: { ...m, online: false }, slots: slotIdxs, sock: null, retry: null, readers: new Map() };
    for (const n of slotIdxs) c.readers.set(n, new ChunkReader(async msg => {
      let req; try { req = JSON.parse(msg); } catch { return; }
      const res = await slots[n]._dispatch(req);
      if (res) for (const ch of chunkJson(JSON.stringify(res))) ser(c, J.CRPC + n, ch);
    }));
    clients.set(key, c);
    connectCip(c);
    return c;
  }
  function closeClients() { for (const c of clients.values()) { clearTimeout(c.retry); if (c.sock) c.sock.destroy(); } clients.clear(); }

  const allSlots = slots.map((_, n) => n);
  function setMaster(m) {   // Crestron Home: the console's addmaster
    if (cfg.stateFile) fs.writeFileSync(cfg.stateFile, JSON.stringify({ ipid: m.ipid, host: m.host, port: m.port, name: m.name }));
    closeClients();
    master = addClient(m, allSlots).m;
  }

  let consoleSrv = null, disc = null;
  if (cfg.masters && cfg.masters.length) {   // Crestron Custom: the processors are configured, there is nothing to discover or add
    for (const m of cfg.masters) addClient({ host: m.host, port: m.port || 41794, ipid: m.ipid }, m.slots || allSlots);
  } else {
    if (cfg.stateFile && fs.existsSync(cfg.stateFile)) { try { master = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch {} }
    consoleSrv = await startConsole({ port: cfg.consolePort, serverId, licenseSerial, getMaster: () => master, setMaster, log });
    disc = await startDiscovery({ port: cfg.discoveryPort, hostname, description, log });
    if (master) master = addClient(master, allSlots).m;
  }
  log(`MMS-${cfg.model} '${hostname}' up: ${disc ? `discovery udp/${disc.port}, console tcp/${consoleSrv.port}` : `${clients.size} configured master(s)`}, http ${httpPort}, slots ${slots.map(s => `${s.name}:${s.port}`).join(' ')}`);

  return {
    slots, ports: { discovery: disc && disc.port, console: consoleSrv && consoleSrv.port, http: httpPort }, description,
    close() { closeClients(); master = null; if (disc) disc.close(); if (consoleSrv) consoleSrv.close(); httpd.close(); slots.forEach(s => s.stop()); },
  };
}

module.exports = { startEmulator, MODELS, providerLabel };
