#!/usr/bin/env python3
"""Replace one RoonDeviceModule instance in a SIMPL Windows program (.smw) with the PlexampZone SIMPL+ symbol.

Every join the Roon zone had connected is carried over to the matching join of the SIMPL+ symbol, so nothing else in the program needs rewiring.
The mapping module join -> SIMPL+ join comes from the module file (RoonDeviceModule ... .umc): its cue names -> its signals -> the inner devicemodule.usp symbol.

  python swap_roon_zone.py "Demo House Sonos RMC3.smw" "RoonDeviceModule v1.0 Build 10.umc" "Music 2" PlexampZone.usp "Demo House Sonos RMC3 Plexamp.smw"

The last argument is a new file; the original program is never changed. Open it in SIMPL Windows and compile (F12).
The SIMPL+ symbol must declare the same signals, in the same order, as the original devicemodule.usp, followed by one extra digital output
(Offline_fb, after IsMuted_fb) and one extra serial output (DirectConnectInfo_fb, last).
"""
import re
import sys


def read(path):
    s = open(path, encoding='latin1', newline='').read()
    return s, ('\r\n' if '\r\n' in s else '\n'), s.replace('\r\n', '\n')


def blocks(text):
    return [dict(line.split('=', 1) for line in b.split('\n') if '=' in line) for b in re.findall(r'\[\n(.*?)\n\]', text, re.S)]


def module_maps(umc_text):
    """module join -> SIMPL+ join of the original devicemodule.usp, for inputs and outputs"""
    objs = blocks(umc_text)
    sym = next(o for o in objs if o.get('ObjTp') == 'Symbol')
    inner = next(o for o in objs if o.get('ObjTp') == 'Sm' and o.get('Nm', '').lower().endswith('.usp'))
    sg_by_name = {}
    for o in objs:
        if o.get('ObjTp') == 'Sg' and 'Nm' in o:
            sg_by_name.setdefault(o['Nm'], o['H'])
    by_handle_in = {v: int(k[1:]) for k, v in inner.items() if re.fullmatch(r'I\d+', k)}
    by_handle_out = {v: int(k[1:]) for k, v in inner.items() if re.fullmatch(r'O\d+', k)}
    in_map, out_map = {}, {}
    for j in range(1, int(sym['NumFixedInputs']) + 1):
        h = sg_by_name.get(sym.get(f'InputCue{j}'))
        if h in by_handle_in:
            in_map[j] = by_handle_in[h]
    for j in range(1, int(sym['NumFixedOutputs']) + 1):
        h = sg_by_name.get(sym.get(f'OutputCue{j}'))
        if h in by_handle_out:
            out_map[j] = by_handle_out[h]
    return in_map, out_map


def shift_out(k):
    """original usp output join -> PlexampZone output join (Offline_fb is inserted as digital 21, DirectConnectInfo_fb is appended)"""
    return k if k <= 20 else k + 1


def main(smw, umc, zone_p1, usp_name, out_path):
    _, nl, text = read(smw)
    _, _, umc_text = read(umc)
    in_map, out_map = module_maps(umc_text)
    assert len(set(in_map.values())) == 29 and len(set(out_map.values())) == 40, (len(in_map), len(out_map))

    objs = blocks(text)
    reserved = {o['Nm']: o['H'] for o in objs if o.get('ObjTp') == 'Sg' and 'reserved' in o.get('Nm', '')}
    dig, ana, ser = reserved['//__digital_reserved__'], reserved['//__analog_reserved__'], reserved['//__serial_reserved__']

    def fix(m):
        b = m.group(1)
        d = dict(line.split('=', 1) for line in b.split('\n') if '=' in line)
        if not (d.get('ObjTp') == 'Sm' and d.get('Nm', '').startswith('RoonDeviceModule') and d.get('P1') == zone_p1):
            return m.group(0)
        ins, outs = {}, {}
        for k, v in d.items():
            if re.fullmatch(r'I\d+', k) and int(k[1:]) in in_map:
                ins[in_map[int(k[1:])]] = v
            if re.fullmatch(r'O\d+', k) and int(k[1:]) in out_map:
                outs[shift_out(out_map[int(k[1:])])] = v
        for k in range(1, 30):
            ins.setdefault(k, dig if k <= 24 else ana if k <= 28 else ser)
        for k in range(1, 43):
            outs.setdefault(k, dig if k <= 20 else (dig if k == 21 else ana if k <= 28 else ser))
        lines = ['ObjTp=Sm', f"H={d['H']}", 'SmC=103', f'Nm={usp_name}', 'ObjVer=1', f"PrH={d['PrH']}", 'CF=2', 'n1I=24', 'n2I=5', 'n1O=21', 'mI=29']
        lines += [f'I{k}={ins[k]}' for k in sorted(ins)]
        lines += ['mO=42', 'tO=42'] + [f'O{k}={outs[k]}' for k in sorted(outs)]
        lines += ['mP=1', f"P1={zone_p1.replace(' ', '')}"]
        print(f"replaced {d['Nm']} H={d['H']} ('{zone_p1}'): {sum(1 for k in ins if ins[k] not in (dig, ana, ser))} inputs and "
              f"{sum(1 for k in outs if outs[k] not in (dig, ana, ser))} outputs carried over")
        return '[\n' + '\n'.join(lines) + '\n]\n'

    out, n = re.subn(r'\[\n(.*?)\n\]\n', fix, text, flags=re.S)
    assert out != text, f'no RoonDeviceModule with P1={zone_p1!r} found'
    open(out_path, 'w', encoding='latin1', newline='').write(out.replace('\n', nl))


if __name__ == '__main__':
    if len(sys.argv) != 6:
        sys.exit(__doc__)
    main(*sys.argv[1:])
