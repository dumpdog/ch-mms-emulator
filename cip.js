'use strict';
// CIP framing + join helpers and the CRPC serial chunk codec, as seen in the MMS captures (see mms-research/).
//   frame   = type(1) len(2 BE) payload
//   serial  = 0x12, payload 00 00 00 <len+4 as u32> 34 <join-1 u16 BE> 03 <text>
//   digital = 0x05, payload 00 00 03 00 <join-1 lo> <join-1 hi | 0x80 when low>
//   crpc    = serial text '2F' + ('Fc' more | 'Fe' last) + 4 hex chars of chunk length + chunk

const T = { REGISTER: 0x01, ACK: 0x02, DATA: 0x05, SERIAL: 0x12, LOGIN: 0x13, JSON: 0x14, PING: 0x0d, PONG: 0x0e, READY: 0x0f };

const frame = (type, payload) => {
  const h = Buffer.alloc(3);
  h[0] = type; h.writeUInt16BE(payload.length, 1);
  return Buffer.concat([h, payload]);
};

class Deframer {
  constructor(onFrame) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; }
  push(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + len) break;
      const type = this.buf[0], payload = this.buf.subarray(3, 3 + len);
      this.buf = this.buf.subarray(3 + len);
      this.onFrame(type, payload);
    }
  }
}

function serialFrame(join, text) {
  // Crestron reads these strings one byte per character, so text that fits Latin-1 goes out that way (UTF-8 shows as "â" etc.)
  const t = Buffer.from(text, /^[\x00-\xff]*$/.test(text) ? 'latin1' : 'utf8');
  const p = Buffer.alloc(8 + t.length);
  p.writeUInt32BE(t.length + 4, 0); p[4] = 0x34; p.writeUInt16BE(join - 1, 5); p[7] = 0x03;
  t.copy(p, 8);
  return frame(T.SERIAL, p);
}
const parseSerial = p => (p.length >= 8 && p[4] === 0x34 ? { join: p.readUInt16BE(5) + 1, text: p.subarray(8).toString('utf8') } : null);

function digitalFrame(join, value) {
  const j = join - 1;
  return frame(T.DATA, Buffer.from([0, 0, 3, 0, j & 0xff, ((j >> 8) & 0x7f) | (value ? 0 : 0x80)]));
}
function parseDigital(p) {
  if (p.length !== 6 || p[2] !== 3) return null;
  return { join: (p[4] | ((p[5] & 0x7f) << 8)) + 1, value: !(p[5] & 0x80) };
}

// ---- CRPC chunking over a serial join
const CHUNK = 192;
function chunkJson(text) {
  const out = [];
  for (let i = 0; i < text.length || i === 0; i += CHUNK) {
    const part = text.slice(i, i + CHUNK), last = i + CHUNK >= text.length;
    out.push(`2F${last ? 'Fe' : 'Fc'}${part.length.toString(16).padStart(4, '0')}${part}`);
  }
  return out;
}
class ChunkReader {
  constructor(onMessage) { this.acc = ''; this.onMessage = onMessage; }
  push(s) {
    const m = /^2F(Fc|Fe)([0-9A-Fa-f]{4})/.exec(s);
    if (!m) return false;
    this.acc += s.slice(8, 8 + parseInt(m[2], 16));
    if (m[1] === 'Fe') { const msg = this.acc; this.acc = ''; this.onMessage(msg); }
    return true;
  }
}

module.exports = { T, frame, Deframer, serialFrame, parseSerial, digitalFrame, parseDigital, chunkJson, ChunkReader };
