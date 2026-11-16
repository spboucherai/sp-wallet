// Builds the compact tape fixture of the market-making simulator from a raw recording of Hyperliquid's PUBLIC websocket.
//
// Recording (read-only, no key, no account, nothing sent but subscriptions and pings): `record-tape.mjs` next to this file —
//   wss://api.hyperliquid.xyz/ws, subscriptions { type: "bbo", coin: "BTC" }, { type: "trades", coin: "BTC" }, { type: "l2Book", coin: "BTC" }.
// Usage: node build-tape.mjs <raw.jsonl> <out.json.gz>
// Output: { provenance, coin, t0, b: [[dt, bid, bidSz, ask, askSz], …], t: [[dt, 1 = buyer aggressor | 0 = seller aggressor, px, sz], …] }
//   dt = venue time − t0 (ms). The top of book is thinned to one state per 200 ms (the last one of each slice); every trade is kept.
//   Trader addresses and hashes of the public trade feed are dropped.
import fs from 'node:fs';
import zlib from 'node:zlib';

const [raw, out] = process.argv.slice(2);
const canon = (x) => (x.includes('.') ? x.replace(/0+$/, '').replace(/\.$/, '') : x);
const rows = fs.readFileSync(raw, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });   // a line still being written is skipped
const bbo = [], trades = [], seen = new Set();
let gaps = 0;
for (const r of rows) {
  if (r.channel === 'gap') { gaps += 1; continue; }
  if (r.channel === 'bbo') { const [b, a] = r.data.bbo; if (b && a) bbo.push([r.data.time, canon(b.px), canon(b.sz), canon(a.px), canon(a.sz)]); }
  if (r.channel === 'trades') for (const t of r.data) { const k = `${t.time}-${t.tid}`; if (seen.has(k)) continue; seen.add(k); trades.push([t.time, t.side === 'B' ? 1 : 0, canon(t.px), canon(t.sz)]); }
}
bbo.sort((x, y) => x[0] - y[0]); trades.sort((x, y) => x[0] - y[0]);
const t0 = bbo[0][0], thin = [];
for (const e of bbo) { const slice = Math.floor((e[0] - t0) / 200); if (thin.length && thin[thin.length - 1].slice === slice) thin[thin.length - 1].e = e; else thin.push({ slice, e }); }
const b = thin.map(({ e }) => [e[0] - t0, e[1], e[2], e[3], e[4]]);
const t = trades.filter((x) => x[0] >= t0).map((x) => [x[0] - t0, x[1], x[2], x[3]]);
const last = Math.max(b[b.length - 1][0], t.length ? t[t.length - 1][0] : 0);
const doc = {
  provenance: { source: 'wss://api.hyperliquid.xyz/ws (public, read-only): channels bbo + trades, coin BTC', recordedFrom: new Date(t0).toISOString(), recordedTo: new Date(t0 + last).toISOString(), minutes: Math.round(last / 6000) / 10,
    rawBboMessages: bbo.length, bookStates: b.length, trades: t.length, reconnectGaps: gaps, thinning: 'top of book: last state of each 200 ms slice; trades: all', builder: 'services/api/test/fixtures/mm/build-tape.mjs' },
  coin: 'BTC', t0, b, t,
};
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
console.log(JSON.stringify(doc.provenance), fs.statSync(out).size, 'bytes');
