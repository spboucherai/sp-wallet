#!/usr/bin/env python3
"""Make the review screenshots of docs/next/screens/web small: each PNG is reduced to an adaptive palette of 256 colours
(flat interface colours: no visible loss) and written back optimised.   python3 tests/e2e/next-shots-shrink.py [dir]"""
import sys, glob, os
from PIL import Image

d = sys.argv[1] if len(sys.argv) > 1 else 'docs/next/screens/web'
before = after = 0
for f in sorted(glob.glob(os.path.join(d, '*.png'))):
    before += os.path.getsize(f)
    im = Image.open(f)
    if im.mode != 'P':
        im.convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)
    after += os.path.getsize(f)
print(f'{len(glob.glob(os.path.join(d, "*.png")))} files: {before // 1024} kB -> {after // 1024} kB')
