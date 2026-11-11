// Records a CONSISTENT set of real, READ-ONLY GMX answers for the router's price-impact proof (test/router.test.ts):
// market tickers, configuration and values, and the open positions of a few public accounts, all within a few seconds, so that
// the venue's own `closePriceImpactDeltaUsd` can be recomputed from the same open interest.
// Run: node packages/derivatives/test/fixtures/record-router.mjs
// Only public GET requests and one public GraphQL query; nothing is signed or sent. Accounts are public addresses of the trade feed.
import { mkdirSync, writeFileSync } from 'node:fs';

const API = 'https://arbitrum.gmxapi.io/v1', SQUID = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const dir = new URL('./gmx-router/', import.meta.url);
mkdirSync(dir, { recursive: true });
const save = (name, url, status, text, trimmed) => { writeFileSync(new URL(`./${name}.json`, dir), JSON.stringify({ recordedAt: new Date().toISOString(), url, status, ...(trimmed ? { trimmed } : {}), text }, null, 1) + '\n'); console.log(name, status, text.length); };
const get = async (url) => { const r = await fetch(url); return { status: r.status, text: await r.text() }; };
const ETH = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336', BTC = '0x47c031236e19d024b42f8AE6780E44A573170703';

// accounts that recently opened a position on ETH/USD [WETH-USDC] or BTC/USD [BTC-USDC]
const q = (market, isLong) => `{ tradeActions(limit: 60, orderBy: timestamp_DESC, where: { eventName_eq: "OrderExecuted", marketAddress_eq: "${market}", orderType_in: [2,3], isLong_eq: ${isLong} }) { account } }`;
const feed = async (market, isLong) => [...new Set((await (await fetch(SQUID, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q(market, isLong) }) })).json()).data.tradeActions.map((t) => t.account))];
const want = [['eth-short', ETH, false], ['eth-long', ETH, true], ['btc-long', BTC, true], ['btc-short', BTC, false]];
const picked = [];
for (const [label, market, isLong] of want) {
  for (const account of (await feed(market, isLong)).slice(0, 25)) {
    if (picked.some((p) => p.account === account)) continue;
    const r = await get(`${API}/positions?address=${account}`);
    if (r.status !== 200) continue;
    const mine = JSON.parse(r.text).filter((p) => p.marketAddress.toLowerCase() === market.toLowerCase() && p.isLong === isLong);
    if (!mine.length) continue;
    picked.push({ label, account, r, keep: mine });
    break;
  }
}
// the market state right after the positions (the API caches each for about a second)
const [tickers, config, values, markets, tokens] = await Promise.all(['markets/tickers', 'markets/config', 'markets/values', 'markets', 'tokens/info'].map((p) => get(`${API}/${p}`)));
const keep = new Set([ETH, BTC].map((a) => a.toLowerCase()));
const only = (text) => JSON.stringify(JSON.parse(text).filter((m) => keep.has(m.marketTokenAddress.toLowerCase())));
const note = 'only BTC/USD [BTC-USDC] and ETH/USD [WETH-USDC]';
save('v1-markets-tickers', `${API}/markets/tickers`, tickers.status, only(tickers.text), note);
save('v1-markets-config', `${API}/markets/config`, config.status, only(config.text), note);
save('v1-markets-values', `${API}/markets/values`, values.status, only(values.text), note);
save('v1-markets', `${API}/markets`, markets.status, only(markets.text), note);
save('v1-tokens-info', `${API}/tokens/info`, tokens.status, tokens.text);
for (const p of picked) save(`v1-positions-${p.label}`, `${API}/positions?address=${p.account}`, p.r.status, JSON.stringify(p.keep), 'only the positions of the market and side named by the file');
console.log(picked.map((p) => `${p.label}: ${p.account} (${p.keep.length})`).join('\n'));
