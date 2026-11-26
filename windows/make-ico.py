# Packs PNG icons (from mac/make-icon.swift) into a Windows .ico file. Usage: make-ico.py icons-folder out.ico
import struct
import sys
from pathlib import Path

folder, out = Path(sys.argv[1]), Path(sys.argv[2])
sizes = [(16, 'icon_16x16.png'), (32, 'icon_32x32.png'), (48, 'icon_32x32@2x.png'), (256, 'icon_256x256.png')]
entries = [(s, (folder / name).read_bytes()) for s, name in sizes if (folder / name).exists()]
header = struct.pack('<HHH', 0, 1, len(entries))
offset = 6 + 16 * len(entries)
table, data = b'', b''
for size, png in entries:
    dim = 0 if size >= 256 else size
    table += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
    data += png
out.write_bytes(header + table + data)
