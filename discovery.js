'use strict';
// Crestron UDP autodiscovery (port 41794): answer the processor's scan so "Ethernet and Wi-Fi" lists us.
//   query : 266 bytes  14 00 00 00 01 04 00 03 00 00 + hostname/ip @10
//   reply : 394 bytes  15 00 00 00 01 84 00 00 00 00 + hostname @10 (256) + description @266 (128), unicast to the asker

const dgram = require('dgram');

function buildReply(hostname, description) {
  const b = Buffer.alloc(394);
  Buffer.from([0x15, 0, 0, 0, 0x01, 0x84, 0, 0, 0, 0]).copy(b);
  b.write(hostname, 10, 255, 'latin1');
  b.write(description, 266, 127, 'latin1');
  return b;
}

function startDiscovery({ port, hostname, description, log }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const reply = buildReply(hostname, description);
  sock.on('message', (msg, rinfo) => {
    if (msg.length !== 266 || msg[0] !== 0x14) {
      if (msg[0] !== 0x15) log(`discovery: ignored ${msg.length}-byte packet type ${msg[0]?.toString(16)} from ${rinfo.address}:${rinfo.port}`);
      return;
    }
    log(`discovery query from ${rinfo.address}:${rinfo.port} for '${msg.subarray(10).toString('latin1').split('\0')[0]}'`);
    sock.send(reply, rinfo.port, rinfo.address);
  });
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, () => { sock.setBroadcast(true); resolve({ close: () => sock.close(), port: sock.address().port }); });
  });
}

module.exports = { startDiscovery, buildReply };
