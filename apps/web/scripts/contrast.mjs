// WCAG contrast ratios of the v9 tokens (text and essential icons on the surfaces they sit on)
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const mix = (fg, bg, a) => fg.map((c, k) => Math.round(c * a + bg[k] * (1 - a)));
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const T = {
  light: { bg: '#f3f4f7', surface: '#ffffff', elev: '#eceef3', ink: '#0a0d14', mute: '#596273', emerald: '#087a55', blue: '#2257e0', warn: '#9a5b06', danger: '#c22a40', primary: '#0a0d14', onprimary: '#ffffff', ondanger: '#ffffff' },
  dark: { bg: '#06080c', surface: '#0f131b', elev: '#1a202c', ink: '#f4f6fa', mute: '#98a2b6', emerald: '#35e7ac', blue: '#7ea6ff', warn: '#f4b65b', danger: '#ff7d88', primary: '#35e7ac', onprimary: '#04130d', ondanger: '#2a0508' },
};
for (const [name, t] of Object.entries(T)) {
  const rows = [];
  for (const fg of ['ink', 'mute', 'emerald', 'blue', 'warn', 'danger']) for (const bg of ['surface', 'bg', 'elev']) rows.push([`${fg} on ${bg}`, ratio(hex(t[fg]), hex(t[bg]))]);
  rows.push(['onprimary on primary', ratio(hex(t.onprimary), hex(t.primary))], ['ondanger on danger', ratio(hex(t.ondanger), hex(t.danger))]);
  // tinted notices / pills: the tone's text on a 9-12 % wash of itself over the surface
  for (const fg of ['emerald', 'blue', 'warn', 'danger']) rows.push([`${fg} on its 10 % wash`, ratio(hex(t[fg]), mix(hex(t[fg]), hex(t.surface), 0.1))]);
  rows.push(['hero text (white 70 %) on hero base #0a0e19', ratio(mix([255, 255, 255], hex('#0a0e19'), 0.7), hex('#0a0e19'))]);
  console.log(name); for (const [k, v] of rows) console.log(`  ${v < 4.5 ? (v < 3 ? 'FAIL' : 'AA-large only') : 'AA'}  ${v.toFixed(2)}  ${k}`);
}
// v10 futures-live — the mode bands (styles.css `.mode-band`, `.mode-tag`). TESTNET and RÉEL use FIXED colours, the same in
// both themes: white text on each stripe of the testnet pattern and on the real-money red. SIMULATION is the theme's blue on
// its own 8 % wash (dotted ground: the dots are 11 % blue over that wash — the worst case under a letter).
{
  const white = [255, 255, 255], rows = [
    ['band TESTNET: white on stripe #5b34c9', ratio(white, hex('#5b34c9'))], ['band TESTNET: white on stripe #6f49dc', ratio(white, hex('#6f49dc'))],
    ['band RÉEL: white on #b3122b', ratio(white, hex('#b3122b'))],
  ];
  for (const [name, t] of Object.entries(T)) { const wash = mix(hex(t.blue), hex(t.surface), 0.08);
    rows.push([`band SIMULATION (${name}): blue on its 8 % wash`, ratio(hex(t.blue), wash)], [`band SIMULATION (${name}): blue on a dot of the ground`, ratio(hex(t.blue), mix(hex(t.blue), wash, 0.11))]); }
  console.log('mode bands (fixed colours)'); for (const [k, v] of rows) console.log(`  ${v < 4.5 ? (v < 3 ? 'FAIL' : 'AA-large only') : 'AA'}  ${v.toFixed(2)}  ${k}`);
  if (rows.some(([k, v]) => v < 4.5)) { console.error('a mode band is below 4.5 : 1'); process.exitCode = 1; }
}
