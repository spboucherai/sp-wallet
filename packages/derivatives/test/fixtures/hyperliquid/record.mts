// Records real answers of the PUBLIC, READ-ONLY Hyperliquid endpoints (POST /info and websocket subscriptions) as fixtures.
// Nothing is signed, nothing is sent to /exchange. Account data is public on-chain state of an address picked from recent trades.
// Run from the repository root:  node packages/derivatives/test/fixtures/hyperliquid/record.mts
import { writeFileSync } from 'node:fs';

const API = { mainnet: 'https://api.hyperliquid.xyz', testnet: 'https://api.hyperliquid-testnet.xyz' } as const;
const WS = { mainnet: 'wss://api.hyperliquid.xyz/ws', testnet: 'wss://api.hyperliquid-testnet.xyz/ws' } as const;
type Net = keyof typeof API;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string, v: unknown) => { writeFileSync(new URL(`./${name}.json`, import.meta.url), `${JSON.stringify(v, null, 1)}\n`); console.log(`  ${name}.json`); };

async function info(network: Net, request: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API[network]}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  const text = await r.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  await sleep(250);
  return { status: r.status, body };
}
async function record(network: Net, name: string, request: Record<string, unknown>, trim?: (body: any) => unknown) {
  const { status, body } = await info(network, request);
  out(`${network}-${name}`, { recordedAt: new Date().toISOString(), network, request, status, body: trim && status === 200 ? trim(body) : body });
  return body;
}

/** an address with open orders (trigger orders if possible), positions and fills — public state, found through recent trades */
async function pickAccount(network: Net): Promise<string> {
  const users = new Set<string>();
  for (const coin of ['BTC', 'ETH', 'SOL']) for (const t of (await info(network, { type: 'recentTrades', coin })).body) for (const u of t.users) users.add(u);
  let best: { user: string; score: number } | null = null;
  for (const user of [...users].slice(0, 30)) {
    const orders = (await info(network, { type: 'frontendOpenOrders', user })).body, state = (await info(network, { type: 'clearinghouseState', user })).body;
    if (!Array.isArray(orders) || !state?.assetPositions) continue;
    const score = (orders.some((o: any) => o.isTrigger) ? 8 : 0) + (orders.some((o: any) => o.cloid) ? 2 : 0) + (orders.some((o: any) => !o.isTrigger) ? 3 : 0)
      + (state.assetPositions.length ? 3 : 0) + (state.assetPositions.some((p: any) => p.position.leverage.type === 'isolated') ? 2 : 0) + (state.assetPositions.some((p: any) => p.position.leverage.type === 'cross') ? 2 : 0)
      + (orders.length > 0 && orders.length <= 40 ? 2 : 0);
    if (!best || score > best.score) best = { user, score };
    if (score >= 20) break;
  }
  if (!best) throw new Error('no account found');
  return best.user;
}

async function recordWs(network: Net, user: string) {
  const messages: unknown[] = [], perChannel = new Map<string, number>();
  const ws = new WebSocket(WS[network]);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('websocket error')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)), n = perChannel.get(m.channel) ?? 0;
    perChannel.set(m.channel, n + 1);
    if (n >= (m.channel === 'subscriptionResponse' ? 20 : 3)) return;
    if (m.channel === 'trades' && Array.isArray(m.data)) m.data = m.data.slice(0, 12);
    if (m.channel === 'userFills' && m.data?.fills) m.data.fills = m.data.fills.slice(0, 12);
    if (m.channel === 'allMids' && m.data?.mids) m.data.mids = Object.fromEntries(Object.entries(m.data.mids).filter(([k]) => !/^[#@+]/.test(k)).slice(0, 40));
    if (m.channel === 'orderUpdates' && Array.isArray(m.data)) m.data = m.data.slice(0, 12);
    messages.push(m);
  };
  const subs = [{ type: 'l2Book', coin: 'BTC' }, { type: 'trades', coin: 'BTC' }, { type: 'activeAssetCtx', coin: 'BTC' }, { type: 'allMids' },
    { type: 'userFills', user }, { type: 'orderUpdates', user }, { type: 'userEvents', user }];
  for (const subscription of subs) ws.send(JSON.stringify({ method: 'subscribe', subscription }));
  ws.send(JSON.stringify({ method: 'ping' }));
  // answered by an `error` channel message. NOT sent here: subscribing to an unknown coin, which makes the server drop the
  // connection without a message (close 1006, observed 2026-11-10) — the adapter checks symbols before subscribing.
  ws.send('not json');
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC' } }));
  await sleep(9000);
  ws.close();
  out(`${network}-ws`, { recordedAt: new Date().toISOString(), network, subscriptions: subs, counts: Object.fromEntries(perChannel), messages });
}

for (const network of ['mainnet', 'testnet'] as Net[]) {
  console.log(network);
  const now = Date.now();
  await record(network, 'meta', { type: 'meta' }, (b) => ({ ...b, marginTables: b.marginTables?.slice(0, 2) }));
  await record(network, 'metaAndAssetCtxs', { type: 'metaAndAssetCtxs' }, (b) => [{ ...b[0], marginTables: b[0].marginTables?.slice(0, 2) }, b[1]]);
  await record(network, 'l2Book-BTC', { type: 'l2Book', coin: 'BTC' });
  await record(network, 'recentTrades-BTC', { type: 'recentTrades', coin: 'BTC' });
  await record(network, 'candleSnapshot-BTC-1h', { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1h', startTime: now - 24 * 3_600_000, endTime: now } });
  await record(network, 'fundingHistory-BTC', { type: 'fundingHistory', coin: 'BTC', startTime: now - 12 * 3_600_000 });
  await record(network, 'error-unknown-coin', { type: 'l2Book', coin: 'NOT-A-COIN' });
  await record(network, 'error-bad-type', { type: 'notAnInfoType' });
  const user = await pickAccount(network);
  console.log(`  account ${user}`);
  await record(network, 'clearinghouseState', { type: 'clearinghouseState', user });
  await record(network, 'frontendOpenOrders', { type: 'frontendOpenOrders', user }, (b) => b.slice(0, 40));
  await record(network, 'historicalOrders', { type: 'historicalOrders', user }, (b) => b.slice(0, 80));
  await record(network, 'userFills', { type: 'userFills', user }, (b) => b.slice(0, 40));
  await record(network, 'userFillsByTime', { type: 'userFillsByTime', user, startTime: now - 24 * 3_600_000 }, (b) => b.slice(0, 40));
  await record(network, 'userFunding', { type: 'userFunding', user, startTime: now - 24 * 3_600_000 }, (b) => b.slice(0, 40));
  await record(network, 'clearinghouseState-empty', { type: 'clearinghouseState', user: '0x00000000000000000000000000000000000000ff' });
  await record(network, 'error-bad-user', { type: 'clearinghouseState', user: 'not-an-address' });
  await recordWs(network, user);
}
