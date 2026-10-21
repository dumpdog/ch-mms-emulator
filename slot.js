'use strict';
// One MMS player slot: the CRPC (JSON-RPC 2.0) "direct connect" server Crestron Home dials after the crpc/config handshake.
// Exposes MirageMediaPlayerN (IMediaPlayer) and MirageMediaMenuN (IMenu) and relays backend state as StateChanged events.

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const { T, frame, Deframer } = require('./cip');
const { Menu } = require('./menu');

const uuidFor = s => { const h = crypto.createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const NIL_GUID = '00000000-0000-0000-0000-000000000000';
const ACTIONS = ['Ffwd', 'NextTrack', 'Pause', 'Play', 'PlayAll', 'PreviousTrack', 'Seek', 'Stop'];
const SUPPORTED = ['Ffwd', 'NextTrack', 'Pause', 'Play', 'PlayAll', 'PreviousTrack', 'Repeat', 'Rewind', 'Seek', 'Shuffle', 'Star', 'Stop', 'ThumbsDown', 'ThumbsUp'];
const PLAYER_METHODS = {
  Play: 'play', Pause: 'pause', Stop: 'stop', NextTrack: 'next', PreviousTrack: 'prev', Seek: 'seek',
  Ffwd: 'ffwd', Rewind: 'rewind', Shuffle: 'shuffle', Repeat: 'repeat', PlayAll: 'playAll', ThumbsUp: 'thumbsUp', ThumbsDown: 'thumbsDown', Star: 'star',
};
const QUIET = /\.(GetProperty|RegisterEvent)$/;   // chatty calls left out of the trace

class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }

class Slot extends EventEmitter {
  // index: 1-based slot number; name: 'Player A'; backend: { home(), player, art?(guid) }; advertise(): { ip, httpHost }
  constructor({ index, name, backend, port, advertise, log }) {
    super();
    Object.assign(this, { index, name, backend, port, advertise, log });
    this.svc = `MirageCrpcService${index}`;
    this.pid = `MirageMediaPlayer${index}`;
    this.mid = `MirageMediaMenu${index}`;
    this.handles = new Map();          // 'Object|Event' -> handle
    this.conns = new Set();
    this.menu = null;
    this.p = this._initialProps();
    backend.player.on('state', patch => this._onPlayerState(patch));
  }

  _initialProps() {
    return {
      Version: 1, Instance: this.index, Language: 'English', MediaType: 'audio',
      ActionsAvailable: ACTIONS, ActionsSupported: SUPPORTED, Album: '', AlbumArtUrl: this.artUrl(NIL_GUID, true),
      Artist: '', Band: null, Busy: { on: false, timeoutSec: 0 }, Composer: null, ElapsedSec: 0, FfwdSpeed: 1, Genre: '',
      MediaReady: true, NextTitle: null, PlayerIcon: 0, PlayerIconURL: '', PlayerName: this.name, PlayerState: '',
      ProgressBar: false,
      PropertiesSupported: ['ActionsAvailable', 'ActionsSupported', 'AlbumArtUrl', 'Busy', 'Composer', 'ElapsedSec', 'FfwdSpeed', 'Instance', 'Language', 'MediaReady', 'MediaType', 'PlayerIconURL', 'PlayerName', 'PlayerState', 'ProgressBar', 'PropertiesSupported', 'ProviderName', 'Rating', 'RepeatState', 'RewindSpeed', 'ShuffleState', 'StationName', 'StatusMsg', 'StreamState', 'TextLines', 'Title', 'TrackCnt', 'TrackNum', 'TrackSec', 'Version'],
      ProviderName: this.backend.providerName || 'Local Music', Rating: { current: 0, max: 1, system: 1 }, RepeatState: 0, RewindSpeed: 1,
      ShuffleState: 0, StationName: '', StatusMsg: null, StreamState: '', TextLines: ['', '', '', ''], Title: '', TrackCnt: 0, TrackNum: 0, TrackSec: 0,
      StatusMsgMenu: null,
    };
  }

  artUrl(guid, player = false) {
    const { httpHost } = this.advertise();
    const ticks = (BigInt(Date.now()) * 10000n + 621355968000000000n).toString();
    const inst = player ? '' : `&instance=${this.name.replace(' ', '_')}`;
    return `http://${httpHost}/getart?guid=${player ? `{${guid}}` : guid}${inst}&h=210&w=210&c=1&fmt=png${player ? '' : '&nolabel=1'}&ticks=${ticks}&ext=${player ? '.png' : '.jpg'}`;
  }

  async start() {
    this.menu = await new Menu(await this.backend.home()).init();
    this.server = net.createServer(sock => this._onConnection(sock));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => resolve(this.server.address().port));
    });
  }
  stop() { this.server.close(); for (const c of this.conns) c.destroy(); }

  // ------------------------------------------------------------------ transport
  _onConnection(sock) {
    this.conns.add(sock);
    this.log(`${this.svc}: processor connected from ${sock.remoteAddress}`);
    const send = obj => (process.env.MMS_CIP_TRACE && this.log(`${this.svc}: > ${JSON.stringify(obj).slice(0, 300)}`), sock.destroyed || sock.write(frame(T.JSON, Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(obj))]))));
    sock._send = send;
    const df = new Deframer(async (type, payload) => {
      if (type === T.LOGIN) sock.write(frame(T.ACK, Buffer.from([0x00, 0x01, 0x00, 0x7f])));
      else if (type === T.PING) sock.write(frame(T.PONG, payload));
      else if (type === T.JSON) {
        sock._chunks = (sock._chunks || '') + payload.subarray(1).toString('utf8');   // first byte: 0 = more chunks follow (Smart Graphics panels split big requests), 1 = last
        if (payload[0] === 0) return;
        let req;
        try { req = JSON.parse(sock._chunks); } catch { return; } finally { sock._chunks = ''; }
        const res = await this._dispatch(req, send);
        if (res) send(res);
      }
    });
    sock.on('data', d => { if (process.env.MMS_CIP_TRACE) this.log(`${this.svc}: rx ${d.length}B ${d.subarray(0, 96).toString('hex')}`); df.push(d); });
    sock.on('close', () => { this.conns.delete(sock); this.handles.clear(); });
    sock.on('error', () => {});
  }

  _event(obj, ev, parameters) {
    const handle = this.handles.get(`${obj}|${ev}`);
    if (!handle) return;
    for (const c of this.conns) c._send({ jsonrpc: '2.0', method: `${obj}.Event`, params: { ev, handle, parameters }, id: 1 });
  }
  _busy(on) { this._event(this.mid, 'BusyChanged', { on, timeoutSec: on ? 4 : 0 }); }

  // ------------------------------------------------------------------ JSON-RPC
  async _dispatch(req, send) {
    const { method, params, id } = req;
    if (!QUIET.test(method)) this.log(`${this.svc}: < ${method} ${JSON.stringify(params ?? null).slice(0, 160)}`);
    try {
      const result = await this._call(method, params || {}, send);
      return { jsonrpc: '2.0', result, error: null, id };
    } catch (e) {
      if (!(e instanceof RpcError)) this.log(`${this.svc}: ${method} failed: ${e.stack}`);
      return { jsonrpc: '2.0', result: null, error: { code: e.code || -32603, message: e.message, data: null }, id };
    }
  }

  async _call(method, params, send) {
    const dot = method.indexOf('.');
    const obj = method.slice(0, dot), m = method.slice(dot + 1);
    if (m === 'RegisterEvent') { this.handles.set(`${obj}|${params.ev}`, params.handle); return {}; }
    if (obj === 'Crpc') return this._crpc(m, params);
    if (obj === this.pid) return this._player(m, params);
    if (obj === this.mid) return this._menu(m, params);
    throw new RpcError(-32601, `The requested object ${obj} was not found`);
  }

  _crpc(m, params) {
    const { ip } = this.advertise();
    if (m === 'Register') {
      if (/Smart Graphics/i.test(params.name || '')) this.sg = true;   // Crestron Custom touchpanels also read Subtitle/TransactionId/IsMenuAvailable
      return {
        ver: '1.0', name: this.svc, uuid: uuidFor(this.svc),
        connections: { 'cip-direct/json-rpc': { ip, port: String(this.port) }, 'symbol/json-rpc': { ip: '0.0.0.0', port: '0' } },
        maxPacketSize: 65536, encoding: 'UTF-8', format: 'JSON',
      };
    }
    if (m === 'GetObjects') {
      return { objects: { object: [
        { '@category': ['Media Player', 'Residential'], name: 'MediaPlayer', instanceName: this.pid, interfaces: ['IMediaPlayer'], uuid: uuidFor(this.pid) },
        { '@category': ['Browse Context', 'Residential'], name: 'Menu', instanceName: this.mid, interfaces: ['IMenu'], uuid: uuidFor(this.mid) },
      ] } };
    }
    throw new RpcError(-32601, `The requested method Crpc.${m} was not found`);
  }

  _prop(bag, name) {
    if (name == null) return bag;
    if (!(name in bag)) throw new RpcError(-32001, `The requested property ${name} was not found`);
    return { [name]: bag[name] };
  }

  async _player(m, params) {
    if (m === 'GetProperty') return this._prop(this.p, params.propName);
    if (m === 'GetMenu') return { instanceName: this.mid };
    const fn = PLAYER_METHODS[m];
    const pl = this.backend.player;
    if (fn && typeof pl[fn] === 'function') { await pl[fn](params); return true; }
    if (fn) { this.log(`${this.svc}: ${m} not implemented by backend (ignored)`); return true; }
    throw new RpcError(-32601, `The requested method ${m} was not found`);
  }

  _menuProps() {
    return { MaxReqItems: 100, StatusMsgMenu: null, Title: this.menu.props.Title, ItemCnt: this.menu.props.ItemCnt,
      ListItemIcons: false, ...(this.sg ? { Subtitle: this.menu.props.Title, TransactionId: this.txn || 0, IsMenuAvailable: true } : {}), ListSpecificFunctions: this.menu.props.ListSpecificFunctions, Level: this.menu.props.Level };
  }

  async _menu(m, params) {
    const menu = this.menu;
    switch (m) {
      case 'GetProperty': return this._prop(this._menuProps(), params.propName);
      case 'GetData': {
        this._busy(true);
        const rows = (await menu.data(params.item, params.count)).map(r => ({ L1: r.L1, L2: r.L2, URL: r.art ? this.artUrl(r.art) : '' }));
        setImmediate(() => this._busy(false));
        return rows;
      }
      case 'Select': case 'PressAndHold': {
        this._busy(true);
        const how = m === 'Select' ? await menu.select(params.item) : await menu.pressAndHold(params.item);
        this._busy(false);
        if (how === 'navigated') setTimeout(() => this._announceMenu(), 20);
        return how !== null;
      }
      case 'Favorites': case 'QuickList': {
        const fn = this.backend[m === 'Favorites' ? 'favorites' : 'quickList'];
        if (!fn) { this.log(`${this.svc}: ${m} not implemented by backend`); return false; }
        this._busy(true);
        await menu.goto(await fn.call(this.backend));
        this._busy(false);
        setTimeout(() => this._announceMenu(), 20);
        return true;
      }
      case 'Create': if (!menu.top.node.create) { this.log(`${this.svc}: menu Create here has nothing to do`); return false; } return menu.create();
      case 'Advanced': case 'PlayAll': this.log(`${this.svc}: menu ${m} not implemented`); return false;
      case 'Back': { const ok = menu.back(); if (ok) setTimeout(() => this._announceMenu(), 20); return ok; }
      case 'BackToTop': await menu.backToTop(); setTimeout(() => this._announceMenu(), 20); return true;
      default: throw new RpcError(-32601, `The requested method ${m} was not found`);
    }
  }

  _announceMenu() {
    this.txn = (this.txn || 0) + 1;   // Smart Graphics panels reload the list when this changes
    const { Title, ItemCnt, Level } = this.menu.props;
    this._busy(true); this._busy(false);
    this._event(this.mid, 'ClearChanged', {});
    this._event(this.mid, 'StateChanged', { Title, ItemCnt, Level });
    this._event(this.mid, 'ListChanged', { item: 1, count: Math.max(1, Math.min(ItemCnt, 100)) });   // only Smart Graphics panels register this one
  }

  // ------------------------------------------------------------------ backend -> processor
  _onPlayerState(patch) {
    const out = { ...patch };
    const textChanged = ['Title', 'Artist', 'Album', 'StationName'].some(k => k in patch);
    if (typeof patch.art === 'string') { out.AlbumArtUrl = this.artUrl(patch.art, true); delete out.art; }
    Object.assign(this.p, out);
    if (textChanged) {
      // Crestron Home draws the full view as: line3 (grey, top), line1 (bold), line2, line4; the mini bar shows line2 in bold.
      // Default 'artist-title' puts the song title in the mini bar without repeating it in the full view.
      // MMS_NOWPLAYING=title-artist restores the plain order (title bold in the full view, artist in the mini bar).
      const l = process.env.MMS_NOWPLAYING === 'title-artist'
        ? [this.p.Title, this.p.Artist, this.p.Album, this.p.StationName]
        : [this.p.Artist, this.p.Title, this.p.Album, this.p.StationName];
      this.p.TextLines = out.TextLines = process.env.MMS_TEXTLINES_DEBUG ? l.map((t, i) => `LINE${i + 1} ${t}`) : l;   // debug: label each line to see where the app shows it
    }
    this._event(this.pid, 'StateChanged', out);
    this.emit('state', out, this.p);
  }
}

module.exports = { Slot };
