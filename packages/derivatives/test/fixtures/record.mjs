// Records real, READ-ONLY answers of the dYdX v4 indexer and the GMX v2 public APIs as test fixtures.
// Run: node packages/derivatives/test/fixtures/record.mjs [dydx|gmx]
// Only GET requests, one public GraphQL query and websocket subscriptions; nothing is signed or sent.
// Each HTTP fixture is { recordedAt, url, status, text } where `text` is the exact body received (kept as text so that JSON
// numbers such as GMX candle prices are never re-serialised through a JS number). Large lists are trimmed with `trimmed`.
import { mkdirSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rec(venue, name, url, o = {}) {
  const r = await fetch(url, o.init);
  let text = await r.text();
  let trimmed;
  if (o.trim && r.ok) { const t = o.trim(JSON.parse(text)); text = JSON.stringify(t.body); trimmed = t.note; }
  mkdirSync(new URL(`./${venue}/`, here), { recursive: true });
  writeFileSync(new URL(`./${venue}/${name}.json`, here), JSON.stringify({ recordedAt: new Date().toISOString(), url, status: r.status, ...(trimmed ? { trimmed } : {}), text }, null, 1) + '\n');
  console.log(venue, name, r.status, text.length);
  await sleep(250);
  return text;
}
async function recWs(venue, name, url, subs, ms, keep) {
  const out = [];
  await new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => { for (const s of subs) ws.send(JSON.stringify(s)); };
    ws.onmessage = (m) => { if (out.length < keep) out.push(JSON.parse(m.data)); };
    ws.onerror = () => resolve();
    setTimeout(() => { ws.close(); resolve(); }, ms);
  });
  writeFileSync(new URL(`./${venue}/${name}.json`, here), JSON.stringify({ recordedAt: new Date().toISOString(), url, sent: subs, messages: out }) + '\n');
  console.log(venue, name, out.length, 'messages');
}

async function dydx() {
  const M = 'https://indexer.dydx.trade/v4', T = 'https://indexer.v4testnet.dydx.exchange/v4';
  // public market data: mainnet
  await rec('dydx', 'perpetualMarkets', `${M}/perpetualMarkets`);
  await rec('dydx', 'orderbook-BTC-USD', `${M}/orderbooks/perpetualMarket/BTC-USD`);
  await rec('dydx', 'orderbook-unknown', `${M}/orderbooks/perpetualMarket/NOPE-USD`);
  await rec('dydx', 'trades-BTC-USD', `${M}/trades/perpetualMarket/BTC-USD?limit=50`);
  await rec('dydx', 'candles-BTC-USD-1HOUR', `${M}/candles/perpetualMarkets/BTC-USD?resolution=1HOUR&limit=24`);
  await rec('dydx', 'historicalFunding-BTC-USD', `${M}/historicalFunding/BTC-USD?limit=48`);
  await rec('dydx', 'height', `${M}/height`);
  // account reads on mainnet are refused from the recording location (HTTP 403 GEOBLOCKED): recorded as such, with an address
  // that cannot exist (all-zero payload) so that no third party's account is involved
  await rec('dydx', 'mainnet-account-geoblocked', `${M}/addresses/dydx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd4mhgw/subaccountNumber/0`);
  // account shapes: public testnet accounts (found in recent testnet blocks; testnet funds have no value)
  const A = 'dydx1zzz66hkkjy6apat9w2enw37484v3xhqnlducf7', B = 'dydx19ykejm094kzj054wt3lks3fk9kuwfu9h0z8hcs';
  await rec('dydx', 'testnet-perpetualMarkets', `${T}/perpetualMarkets`, { trim: (b) => ({ note: 'markets: only those referenced by the account fixtures', body: { markets: Object.fromEntries(Object.entries(b.markets).filter(([k]) => ['BTC-USD', 'ETH-USD', 'LINK-USD', 'TRX-USD', 'TAO-USD'].includes(k))) } }) });
  await rec('dydx', 'testnet-subaccount', `${T}/addresses/${A}/subaccountNumber/0`);
  await rec('dydx', 'testnet-address', `${T}/addresses/${A}`);
  await rec('dydx', 'testnet-subaccount-unknown', `${T}/addresses/dydx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd4mhgw/subaccountNumber/0`);
  await rec('dydx', 'testnet-positions', `${T}/perpetualPositions?address=${A}&subaccountNumber=0&status=OPEN`);
  await rec('dydx', 'testnet-orders-history', `${T}/orders?address=${A}&subaccountNumber=0&limit=20&returnLatestOrders=true`);
  // resting orders of testnet market makers churn every few seconds: take the first account that has some right now
  for (let i = 0; i < 12; i++) {
    const a = [B, 'dydx12laptmp99yttf5k7s0uzqer6cj44u3ynj60sx3', 'dydx1a5c5yk88zcax7s3dzt72lrrwex6efnfmweycvs', 'dydx1wcxcrcmapf7n0jq5082q5m9rk2654y2kc8dfqg'][i % 4];
    if ((await rec('dydx', 'testnet-orders-open', `${T}/orders?address=${a}&subaccountNumber=0&status=OPEN,UNTRIGGERED&limit=10`)).length > 2) break;
  }
  await rec('dydx', 'testnet-fills', `${T}/fills?address=${A}&subaccountNumber=0&limit=20`);
  await rec('dydx', 'testnet-fundingPayments', `${T}/fundingPayments?address=${A}&subaccountNumber=0&limit=20`);
  // websocket: mainnet public channels, testnet subaccount channel
  await recWs('dydx', 'ws-mainnet-public', 'wss://indexer.dydx.trade/v4/ws', [
    { type: 'subscribe', channel: 'v4_orderbook', id: 'BTC-USD' }, { type: 'subscribe', channel: 'v4_trades', id: 'BTC-USD' },
    { type: 'subscribe', channel: 'v4_markets' }, { type: 'subscribe', channel: 'v4_orderbook', id: 'NOPE-USD' }, { type: 'ping' },
  ], 20000, 160);
  await recWs('dydx', 'ws-testnet-subaccount', 'wss://indexer.v4testnet.dydx.exchange/v4/ws', [{ type: 'subscribe', channel: 'v4_subaccounts', id: `${B}/0` }], 12000, 12);
}

async function gmx() {
  const V1 = 'https://arbitrum.gmxapi.io/v1', OR = 'https://arbitrum-api.gmxinfra.io';
  const KEEP = /^(BTC|ETH|SOL|LINK|LTC|DOGE)\/USD |^SWAP-ONLY \[USDC-USDT\]/;
  const bySym = (key) => (b) => ({ note: `only markets whose ${key} matches ${KEEP}`, body: b.filter((m) => KEEP.test(m[key])) });
  const markets = JSON.parse(await rec('gmx', 'v1-markets', `${V1}/markets`));
  await rec('gmx', 'v1-markets-tickers', `${V1}/markets/tickers`, { trim: bySym('symbol') });
  await rec('gmx', 'v1-markets-config', `${V1}/markets/config`, { trim: bySym('name') });
  await rec('gmx', 'v1-tokens-info', `${V1}/tokens/info`);
  await rec('gmx', 'v1-pairs', `${V1}/pairs`);
  await rec('gmx', 'v1-ohlcv-BTC-1h', `${V1}/prices/ohlcv?symbol=BTC&timeframe=1h&limit=24`);
  await rec('gmx', 'v1-ohlcv-unknown', `${V1}/prices/ohlcv?symbol=NOPE&timeframe=1h&limit=2`);
  const btc = markets.find((m) => m.symbol === 'BTC/USD [BTC-USDC]').marketTokenAddress;
  await rec('gmx', 'v1-rates-BTC-7d', `${V1}/rates?period=7d&address=${btc}`);
  await rec('gmx', 'oracle-prices-tickers', `${OR}/prices/tickers`);
  await rec('gmx', 'oracle-tokens', `${OR}/tokens`);
  await rec('gmx', 'oracle-markets-info', `${OR}/markets/info`, { trim: (b) => ({ note: `only markets whose name matches ${KEEP}`, body: { markets: b.markets.filter((m) => KEEP.test(m.name)) } }) });
  await rec('gmx', 'oracle-candles-BTC-1h', `${OR}/prices/candles?tokenSymbol=BTC&period=1h&limit=24`);
  // public trade feed: Subsquid GraphQL (documented at https://docs.gmx.io/docs/api/graphql)
  const q = `{ tradeActions(limit: 30, orderBy: timestamp_DESC, where: { eventName_eq: "OrderExecuted", marketAddress_eq: "${btc}", orderType_in: [2,3,4,5,6,7,8] }) { id eventName orderType orderKey marketAddress isLong sizeDeltaUsd sizeDeltaInTokens executionPrice timestamp transactionHash } }`;
  await rec('gmx', 'graphql-tradeActions-BTC', 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql', { init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) } });
  // account reads: a public Arbitrum address seen placing orders in the public trade feed on the recording day
  const acct = process.env.GMX_FIXTURE_ACCOUNT ?? '0x46a3BA57e146A4906bc68759Fb7ad1E74d3B66f6';
  await rec('gmx', 'v1-positions', `${V1}/positions?address=${acct}`);
  await rec('gmx', 'v1-orders', `${V1}/orders?address=${acct}`);
  await rec('gmx', 'v1-trades', `${V1}/trades?address=${acct}&limit=60`);
  await rec('gmx', 'v1-positions-empty', `${V1}/positions?address=0x1111111111111111111111111111111111111111`);
  await rec('gmx', 'v1-positions-bad-address', `${V1}/positions?address=0x123`);
}

const which = process.argv[2];
if (!which || which === 'dydx') await dydx();
if (!which || which === 'gmx') await gmx();
