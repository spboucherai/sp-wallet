// Records trimmed REAL answers of the edgeX public endpoints (no key, no account, GET + public websocket only).
// Run: node packages/derivatives/test/fixtures/edgex/record.mjs
// Every fixture keeps the exact text the venue sent, except where `trimmed` says what was cut (lists shortened to the
// contracts the tests use). Nothing is edited inside an object.
import { writeFileSync } from 'node:fs';

const REST = 'https://edgex-prod-v2.edgex.exchange/api/v2/public';
const WS = 'wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws';
// one crypto, one equity, one ETF, one commodity, one FX, the pre-IPO contract, one hidden contract
const KEEP = ['BTCUSDC', 'AAPLUSDC', 'SPYUSDC', 'XAUUSDC', 'USDJPYUSDC', 'ANTHROPICUSDC', 'JPYUSDC'];
const out = (name, o) => { writeFileSync(new URL(`./${name}.json`, import.meta.url), JSON.stringify(o, null, 1) + '\n'); console.log(`${name}: ${o.status ?? ''} ${(o.text ?? '').length || (o.messages?.length ?? '')}`); };
const get = async (url) => { const r = await fetch(url, { redirect: 'manual' }); return { recordedAt: new Date().toISOString(), url, status: r.status, text: await r.text() }; };
const save = async (name, url, trim) => {
  const f = await get(url);
  if (trim) { const j = JSON.parse(f.text); f.trimmed = trim(j); f.text = JSON.stringify(j); }
  out(name, f); return f;
};

const meta = await save('metaData', `${REST}/meta/getMetaData`, (j) => {
  const total = j.data.contractList.length, coins = j.data.coinList.length;
  j.data.contractList = j.data.contractList.filter((c) => KEEP.includes(c.contractName));
  const ids = new Set(j.data.contractList.flatMap((c) => [c.baseCoinId, c.quoteCoinId]));
  j.data.coinList = j.data.coinList.filter((c) => ids.has(c.coinId));
  j.data.multiChain = { chainList: j.data.multiChain.chainList.slice(0, 1) }; j.data.campaign = {};
  return `contractList cut from ${total} to ${j.data.contractList.length} (${KEEP.join(', ')}), coinList from ${coins} to ${j.data.coinList.length}, multiChain.chainList to its first entry, campaign emptied`;
});
const id = Object.fromEntries(JSON.parse(meta.text).data.contractList.map((c) => [c.contractName, c.contractId]));
const keepIds = new Set(Object.values(id));
await save('contract-labels', `${REST}/contract-labels`, (j) => {
  const n = j.data.length;
  j.data = j.data.filter((l) => l.productCategory === 'PrepV2' && ['tabs.pre-ipo', 'tabs.commodities', 'tabs.forex', 'tabs.stocks', 'tabs.etf'].includes(l.multiLanguageKey));
  for (const l of j.data) if (l.multiLanguageKey !== 'tabs.pre-ipo') l.contracts = l.contracts.filter((c) => keepIds.has(c.contractId));
  return `labels cut from ${n} to the PrepV2 pre-ipo / commodities / forex / stocks / etf tabs; their contract lists cut to the recorded contracts (the pre-IPO list is complete)`;
});
for (const n of KEEP) await save(`ticker-${n}`, `${REST}/quote/getTicker?contractId=${id[n]}`);
await save('ticker-no-contract', `${REST}/quote/getTicker`);
const A = id.ANTHROPICUSDC;
await save('depth-ANTHROPICUSDC-15', `${REST}/quote/getDepth?contractId=${A}&level=15`);
await save('depth-ANTHROPICUSDC-200', `${REST}/quote/getDepth?contractId=${A}&level=200`);
await save('depth-bad-level', `${REST}/quote/getDepth?contractId=${A}&level=50`);
const k1 = await save('kline-ANTHROPICUSDC-HOUR_1-p1', `${REST}/quote/getKline?contractId=${A}&klineType=HOUR_1&priceType=LAST_PRICE&size=5`);
const off = JSON.parse(k1.text).data.nextPageOffsetData;
await save('kline-ANTHROPICUSDC-HOUR_1-p2', `${REST}/quote/getKline?contractId=${A}&klineType=HOUR_1&priceType=LAST_PRICE&size=5&offsetData=${off}`);
await save('kline-bad-enum', `${REST}/quote/getKline?contractId=${A}&klineType=NOPE&priceType=LAST_PRICE&size=5`);
await save('kline-too-large', `${REST}/quote/getKline?contractId=${A}&klineType=HOUR_1&priceType=LAST_PRICE&size=1001`);
const f1 = await save('funding-ANTHROPICUSDC-p1', `${REST}/funding/getFundingRatePage?contractId=${A}&size=5&filterSettlementFundingRate=true`);
await save('funding-ANTHROPICUSDC-p2', `${REST}/funding/getFundingRatePage?contractId=${A}&size=5&filterSettlementFundingRate=true&offsetData=${JSON.parse(f1.text).data.nextPageOffsetData}`);
{ const f = await get('https://pro.edgex.exchange/api/v1/public/meta/getMetaData'); f.trimmed = `HTML body cut from ${f.text.length} to 600 characters`; f.text = f.text.slice(0, 600); out('old-host-html', f); }

// public websocket: 20 s of real frames on the ANTHROPIC channels and on ticker.all.1s
const ws = new WebSocket(WS), sent = [], messages = [];
const send = (m) => { sent.push(m); ws.send(JSON.stringify(m)); };
ws.onopen = () => { for (const c of [`ticker.${A}`, `depth.${A}.15`, `trades.${A}`, 'ticker.all.1s', `trades.${id.BTCUSDC}`, 'bogus.channel']) send({ type: 'subscribe', channel: c }); };
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); messages.push(m); if (m.type === 'ping') send({ type: 'pong', time: m.time }); };
setTimeout(() => send({ type: 'unsubscribe', channel: `trades.${id.BTCUSDC}` }), 15_000);
await new Promise((r) => setTimeout(r, 20_000));
ws.close();
let all = 0, btc = 0;
const kept = messages.filter((m) => {
  if (m.channel === 'ticker.all.1s' && m.type === 'quote-event') { all += 1; if (all > 3) return false; m.content.data = m.content.data.filter((t) => keepIds.has(t.contractId)); }
  if (m.channel === `trades.${id.BTCUSDC}` && m.type === 'quote-event' && m.content.dataType !== 'Snapshot') { btc += 1; if (btc > 3) return false; }
  return true;
});
out('ws-public', { recordedAt: new Date().toISOString(), url: WS, sent, trimmed: `ticker.all.1s: first 3 of ${all} frames kept, each cut from every contract to the recorded ones; BTC trade increments: first 3 of ${btc} kept; every other frame is complete and in order`, messages: kept });
process.exit(0);
