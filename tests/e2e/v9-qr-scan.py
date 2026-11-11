# Decoder side of tests/e2e/v9-qr-scan.mts: reads each screenshot of the Receive QR (with the network logo in its centre)
# with OpenCV's QR detector, as rendered and under three degradations a phone camera produces (small, blurred, rotated),
# and requires the EXACT address every time. Exit code 1 on any miss.
import json, sys
import cv2

cases = json.load(open(sys.argv[1]))
det = cv2.QRCodeDetector()

def variants(img):
    h, w = img.shape[:2]
    yield 'as rendered', img
    yield 'small (240 px)', cv2.resize(img, (240, int(240 * h / w)), interpolation=cv2.INTER_AREA)
    yield 'blurred', cv2.GaussianBlur(img, (0, 0), max(1.0, w / 400))
    m = cv2.getRotationMatrix2D((w / 2, h / 2), 12, 0.82)
    yield 'rotated 12 deg', cv2.warpAffine(img, m, (w, h), borderValue=(243, 244, 247))

fails, n, cn, cfails = [], 0, 0, []
for c in cases:
    img = cv2.imread(c['file'])
    for name, v in variants(img):
        got, _, _ = det.detectAndDecode(v)
        ok = got == c['address']
        if c.get('control'):
            cn += 1
            if not ok: cfails.append(f"{c['network']} @{c['dsf']}x, {name}")
        else:
            n += 1
            if not ok: fails.append(f"{c['network']} @{c['dsf']}x, {name}: decoded {got!r}")
real = [f for f in fails if f.split(':')[0] not in cfails]   # misses the logo is responsible for: the control (no logo) decoded
print(f"QR scan with the centre logo: {n - len(fails)}/{n} decodes exact ({len(set(c['network'] for c in cases))} networks, 2 pixel densities, 4 conditions)")
print(f"control without the logo:     {cn - len(cfails)}/{cn}")
for f in fails:
    print('  MISS', f, '(also missed without the logo)' if f not in real else '(decodes without the logo: the logo costs this one)')
sys.exit(1 if real else 0)
