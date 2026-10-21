'use strict';
// Crestron Custom: which processor (and IP-ID) each slot reports to.
//   MMS_MASTER=192.168.4.5@0A        default for every slot (IP-IDs are hex, as in SIMPL; an optional :port overrides CIP's 41794)
//   MMS_<SLOT>_MASTER=192.168.4.6@0B per-slot override, SLOT = MAIN, A, B, C, D or USB
// Slots with the same processor and IP-ID share one connection (one MMS symbol in the program); a slot with no master is not served.

function parseMaster(text, what) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?@([0-9a-f]{1,2})$/i.exec(String(text).trim());
  if (!m) throw new Error(`${what}: expected <processor ip>[:port]@<IP-ID hex>, got '${text}'`);
  const ipid = parseInt(m[3], 16);
  if (!(ipid >= 3 && ipid <= 0xfe)) throw new Error(`${what}: IP-ID ${m[3]} is outside 03..FE`);
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 41794, ipid };
}

// keys: slot keys in model order (MAIN, A, B, C, D, USB) -> [{ host, port, ipid, slots: [slot indexes] }]
function parseMasters(env, keys) {
  const groups = new Map();
  keys.forEach((k, n) => {
    const raw = env[`MMS_${k}_MASTER`] || env.MMS_MASTER;
    if (!raw) return;
    const m = parseMaster(raw, env[`MMS_${k}_MASTER`] ? `MMS_${k}_MASTER` : 'MMS_MASTER');
    const id = `${m.host}:${m.port}:${m.ipid}`;
    if (!groups.has(id)) groups.set(id, { ...m, slots: [] });
    groups.get(id).slots.push(n);
  });
  if (!groups.size) throw new Error('MMS_SYSTEM=custom needs MMS_MASTER=<processor ip>@<IP-ID> (or MMS_<SLOT>_MASTER per slot)');
  return [...groups.values()];
}

module.exports = { parseMaster, parseMasters };
