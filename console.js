'use strict';
// The MMS text console on TCP 5004. Crestron Home's add sequence: getlicensemessage, ipt (x3), addmaster <ipid> <host> <port>.
// addmaster tells us the IP-ID to register with and where to dial out (the processor's CIP port).

const net = require('net');

const BANNER = '\r\n\r\nMMS Emulator version: 1.0 Release (unofficial).\r\n' +
  'Independent interoperability project, not affiliated with the maker of the real MMS.\r\n\r\n' +
  "Type '?' for help or 'help <command>' for help on <command>.\r\n\r\n";

function startConsole({ port, serverId, licenseSerial, getMaster, setMaster, log }) {
  const server = net.createServer(sock => {
    const peer = sock.remoteAddress.replace(/^::ffff:/, '');
    log(`console: connection from ${peer}`);
    sock.write(`${BANNER}Server=${serverId}\n\n\r\n`);   // the real MMS ends its banner this way (228 bytes with a 12-char id)
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(buf.indexOf('\n', i) + 1);
        if (line) { log(`console: < ${line}`); sock.write(handle(line, peer) + '\r\n'); }
      }
    });
    sock.on('error', () => {});
  });

  function handle(line, peer) {
    const [cmd, ...args] = line.split(/\s+/);
    switch (cmd.toLowerCase()) {
      case 'getlicensemessage':
        return `LicenseMessage "Licensed for general PolyTune streaming use by eSeries ES.  Serial number: ${licenseSerial}"`;
      case 'ipt': {
        const m = getMaster();
        return m ? `IPID=${m.ipid.toString(16).toUpperCase()},IPAddress=${m.host}, Port=${m.port}, Status=${m.online ? 'online' : 'offline'}` : 'No Entries';
      }
      case 'addmaster': {
        const ipid = parseInt(args[0], 16), cport = parseInt(args[2], 10);   // IP-IDs are hex on the console (seen: 8, 9, B)
        if (!(ipid > 0) || !(cport > 0)) return "Error: Invalid arguments for 'addmaster'.";
        log(`console: addmaster ipid=${ipid} host=${peer} port=${cport} (name ${args[1]})`);
        const host = /^\d+\.\d+\.\d+\.\d+$/.test(args[1]) ? args[1] : peer;   // an explicit IPv4 address (Crestron Custom / manual test) wins over the connecting peer
        setMaster({ ipid, host, port: cport, name: args[1] });
        return 'Ack';
      }
      default:
        log(`console: unknown command '${line}'`);
        return `Error: Unknown command '${cmd}'.`;
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve({ close: () => server.close(), port: server.address().port }));
  });
}

module.exports = { startConsole };
