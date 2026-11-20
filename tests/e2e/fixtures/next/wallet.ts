// NEXT web — fixtures that make a throwaway (empty) test wallet look like a wallet in use, for screenshots and for the specs of
// the populated screens. Nothing here is a balance of a real wallet: the figures are invented, and laid over the answers of the
// REAL local stack with `page.route` (the session, the networks, the registry, the settings stay real).
//
//   populate(page, { … })   routes /portfolio, /portfolio/history, /activity, /dashboard/activity, /security/overview,
//                           /security/logins, /contacts and — because that route is NOT on this branch — /analytics.
//
// The summary is computed here the way the server computes it: integer arithmetic, two decimals, shares as ratios.
import type { Page, Route } from '@playwright/test';

export interface Holding { network: string; symbol: string; native?: boolean; display: string; usd: number; cad: number; change24h: number }
export const HOLDINGS: Holding[] = [
  { network: 'base', symbol: 'USDC', display: '4250.75', usd: 1.0001, cad: 1.4012, change24h: 0.01 },
  { network: 'ethereum', symbol: 'ETH', native: true, display: '1.84210934', usd: 3412.55, cad: 4781.2, change24h: 2.31 },
  { network: 'bitcoin', symbol: 'BTC', native: true, display: '0.08412345', usd: 97250.1, cad: 136255.4, change24h: -1.12 },
  { network: 'solana', symbol: 'SOL', native: true, display: '42.5', usd: 188.42, cad: 263.98, change24h: 4.75 },
  { network: 'arbitrum', symbol: 'USDC', display: '1200', usd: 1.0001, cad: 1.4012, change24h: 0.01 },
  { network: 'base', symbol: 'ETH', native: true, display: '0.3215', usd: 3412.55, cad: 4781.2, change24h: 2.31 },
  { network: 'polygon', symbol: 'POL', native: true, display: '850', usd: 0.4123, cad: 0.5777, change24h: -3.4 },
];
const DAY = 86_400_000;
type J = Record<string, any>;
const cents = (display: string, price: number): bigint => { const [i, f = ''] = display.split('.'); const amt = BigInt(i + f.padEnd(8, '0').slice(0, 8)), p = BigInt(Math.round(price * 1e6)); return (amt * p) / 10n ** 12n; };   // amount(1e8) × price(1e6) → cents
const money = (c: bigint): string => { const neg = c < 0n, s = (neg ? -c : c).toString().padStart(3, '0'); return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`; };
const share = (v: bigint, total: bigint): number => (total > 0n ? Number((v * 1_000_000n) / total) / 1_000_000 : 0);
const spark = (seed: number, drift: number): number[] => Array.from({ length: 42 }, (_, k) => 100 + drift * k * 0.12 + Math.sin((k + seed) / 3.1) * 2.2 + Math.cos((k * seed) / 7.3) * 1.1);
const units = (display: string, decimals: number): string => { const [i, f = ''] = display.split('.'); return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals)).toString(); };

export interface PopulateOpts { currency?: 'CAD' | 'USD'; /** a network whose balances could not be read: the total is partial */ missing?: string | null; /** credential ids known to one side only */ mismatch?: boolean; analytics?: boolean; halted?: boolean }

/** the portfolio of the real stack, with the fixture's holdings, prices and summary laid over it */
export function patchPortfolio(j: J, o: PopulateOpts = {}): J {
  if (!Array.isArray(j?.balances)) return j;   // not a portfolio (a refusal of the rate limiter): left as it is
  const cur = o.currency ?? 'CAD', ck = cur === 'USD' ? 'usd' : 'cad';
  const prices: J = { ...(j.prices ?? {}) };
  HOLDINGS.forEach((h, k) => { prices[h.symbol] = { source: 'coingecko', usd: h.usd, cad: h.cad, change24h: h.change24h, change7d: h.change24h * 1.8, marketCap: 1e9 * (20 - k), volume24h: 5e7 * (9 - k), high24h: h.usd * 1.02, low24h: h.usd * 0.98, ath: h.usd * 1.4, rank: k + 1, spark: spark(k + 2, h.change24h), priceAt: new Date(Date.now() - 90_000).toISOString(), stale: false }; });
  const byNet = new Map<string, bigint>(), bySym = new Map<string, bigint>(); let total = 0n, prev = 0n, priced = 0;
  for (const b of j.balances as J[]) {
    const h = HOLDINGS.find((x) => x.network === b.network && x.symbol === b.symbol && (x.native ? b.asset === 'native' : b.asset !== 'native') && !(b.name ?? '').toLowerCase().includes('bridged'));
    if (o.missing && b.network === o.missing) { b.amount = null; b.display = null; b.error = 'unavailable'; b.reason = 'network_unavailable'; b.agreed = false; continue; }
    if (!h || (bySym.has(`${h.network}:${h.symbol}`))) { if (b.amount !== null) { b.amount = '0'; b.display = '0'; } continue; }
    bySym.set(`${h.network}:${h.symbol}`, 0n);
    b.amount = units(h.display, b.decimals); b.display = h.display; b.error = null; b.agreed = true; b.stale = false; b.sources = 2; b.sourcesAsked = 2; b.readAt = new Date().toISOString();
    const v = cents(h.display, h[ck]); total += v; priced += 1; prev += (v * 1_000_000n) / (1_000_000n + BigInt(Math.round(h.change24h * 10_000)));
    byNet.set(h.network, (byNet.get(h.network) ?? 0n) + v);
  }
  const sym = new Map<string, bigint>(); for (const h of HOLDINGS) if (!(o.missing && h.network === o.missing) && bySym.has(`${h.network}:${h.symbol}`)) sym.set(h.symbol, (sym.get(h.symbol) ?? 0n) + cents(h.display, h[ck]));
  const sorted = (m: Map<string, bigint>) => [...m].sort((a, b) => (a[1] > b[1] ? -1 : 1));
  const missing = o.missing ? [{ network: o.missing, reason: 'network_unavailable' }] : [];
  j.prices = prices; j.pricesAsOf = new Date(Date.now() - 90_000).toISOString(); j.pricesStale = false; j.asOf = new Date().toISOString();
  j.summary = { currency: cur, total: money(total), complete: missing.length === 0, missing, uncertain: [], priced, unpriced: [], stalePrices: [], pricesStale: false,
    change24h: { abs: money(total - prev), pct: Number(((total - prev) * 1_000_000n) / prev) / 10_000, basis: 'price_change_24h_of_current_holdings' },
    byNetwork: sorted(byNet).map(([network, v]) => ({ network, value: money(v), share: share(v, total) })), byAsset: sorted(sym).map(([symbol, v]) => ({ symbol, value: money(v), share: share(v, total) })) };
  if (o.halted) j.halted = true;
  j.pending = (j.pending ?? []).concat(PENDING());
  return j;
}
export const fixtureTotal = (currency: 'CAD' | 'USD' = 'CAD'): string => money(HOLDINGS.reduce((s, h) => s + cents(h.display, h[currency === 'USD' ? 'usd' : 'cad']), 0n));

// ------------------------------------------------------------------------------------------------------------------ history
const RANGE_DAYS: Record<string, number> = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365, ALL: 520 };
/** a deterministic walk that ends at the fixture's total; the 1W range has a hole (a network was unreadable for 16 hours) */
export function history(range: string, currency: 'CAD' | 'USD' = 'CAD', now = Date.now()): J {
  const days = RANGE_DAYS[range] ?? 7, n = range === '1D' ? 144 : 240, end = Number(fixtureTotal(currency)), start = end * (1 - Math.min(0.42, days / 900) - 0.03);
  const deposit = range === '1D' ? 0 : end * 0.11, tDep = now - days * DAY * 0.38;
  const pts: { t: string; total: string }[] = []; let omitted = 0;
  for (let k = 0; k < n; k++) {
    const t = now - days * DAY + (k / (n - 1)) * days * DAY, x = k / (n - 1);
    if (range === '1W' && x > 0.52 && x < 0.615) { omitted += 1; continue; }
    const wave = Math.sin(x * 9.2 + days) * 0.012 + Math.sin(x * 23.7) * 0.006 + Math.cos(x * 3.1 + days / 7) * 0.02;
    const v = (start + (end - deposit - start) * x) * (1 + wave * (1 - x * 0.35)) + (t >= tDep ? deposit : 0);
    pts.push({ t: new Date(t).toISOString(), total: (k === n - 1 ? end : v).toFixed(2) });
  }
  const first = pts[0]!, last = pts[pts.length - 1]!, abs = Number(last.total) - Number(first.total), out = range === '1D' ? 0 : 310.4;
  const net = deposit - out;
  return { range, currency, asOf: new Date(now).toISOString(), points: pts, first, last, valueChange: { abs: abs.toFixed(2), pct: Number(((abs / Number(first.total)) * 100).toFixed(4)) },
    flows: { from: first.t, to: last.t, external: { in: deposit.toFixed(2), out: out.toFixed(2), net: net.toFixed(2) }, ownAccounts: { in: '0.00', out: '0.00', net: '0.00' }, net: net.toFixed(2), valued: deposit ? 2 : 0, unvalued: [], complete: true },
    estimatedMarketChange: { abs: (abs - net).toFixed(2), pct: Number((((abs - net) / Number(first.total)) * 100).toFixed(4)), method: 'value_change_minus_net_flows', estimate: true, complete: true },
    omitted: { incomplete: omitted }, retention: { everyPointDays: 7, hourlyDays: 90, snapshotEveryMinutes: 10 } };
}

// ------------------------------------------------------------------------------------------------------------------ movements
export const ADDR = { rent: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', friend: '0x2f318C334780961FB129D2a6c30D0763d9a5C970', exchange: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', me: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1',
  sol: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', btc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' };
export const IDS = { rent: '11111111-1111-4111-8111-111111111111', swap: '22222222-2222-4222-8222-222222222222', dropped: '33333333-3333-4333-8333-333333333333', confirming: '44444444-4444-4444-8444-444444444444',
  replaced: '55555555-5555-4555-8555-555555555555', failed: '66666666-6666-4666-8666-666666666666', pending: '77777777-7777-4777-8777-777777777777' };
const hash = (c: string): string => `0x${c.repeat(64).slice(0, 64)}`;
const NET_NAME: Record<string, string> = { base: 'Base', ethereum: 'Ethereum', bitcoin: 'Bitcoin', solana: 'Solana', arbitrum: 'Arbitrum One', polygon: 'Polygon' };
function proposal(o: { id: string; kind?: string; network: string; symbol: string; decimals: number; asset?: string; display: string; to: string; ago: number; lifecycle: string; state: string; fee?: string; feePaid?: string | null; feeSymbol: string; txid?: string | null; confirmations?: number; errorCode?: string | null; error?: string | null; watched?: boolean; relay?: boolean; note?: string; swap?: J | null }, now: number): J {
  const at = new Date(now - o.ago).toISOString(), plus = (ms: number) => new Date(now - o.ago + ms).toISOString();
  return { id: o.id, kind: o.kind ?? 'send', rawKind: o.kind === 'swap' ? 'swap' : 'transfer', at, state: o.state, lifecycle: o.lifecycle, finalized: o.lifecycle === 'confirmed', watched: !!o.watched, network: o.network, networkName: NET_NAME[o.network] ?? o.network,
    asset: o.asset ?? 'native', symbol: o.symbol, decimals: o.decimals, amount: units(o.display, o.decimals), amountDisplay: o.display, from: o.network === 'solana' ? ADDR.sol : o.network === 'bitcoin' ? ADDR.btc : ADDR.me, to: o.to, note: o.note ?? '', memo: null,
    feeDisplay: o.fee ?? null, maxFeeDisplay: o.fee ? (Number(o.fee) * 1.6).toFixed(9).replace(/0+$/, '') : null, feeSymbol: o.feeSymbol, feePaid: o.feePaid ? units(o.feePaid, 18) : null, feePaidDisplay: o.feePaid ?? null,
    warnings: [], intentHash: hash('9'), txid: o.txid ?? null, explorer: o.txid ? `https://basescan.org/tx/${o.txid}` : null, confirmations: o.confirmations ?? 0, error: o.error ?? null, errorCode: o.errorCode ?? null, errorParams: null,
    createdAt: at, updatedAt: plus(95_000), expiresAt: plus(180_000), relayAttemptedAt: o.relay ? plus(9000) : null, broadcastAt: o.txid ? plus(11_000) : null, finalizedAt: o.lifecycle === 'confirmed' ? plus(74_000) : null, swap: o.swap ?? null };
}
/** the transfers in flight shown on the dashboard's « in progress » card */
export const PENDING = (now = Date.now()): J[] => [proposal({ id: IDS.confirming, network: 'bitcoin', symbol: 'BTC', decimals: 8, display: '0.0125', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', ago: 14 * 60_000, lifecycle: 'confirming', state: 'confirming', fee: '0.00002140', feeSymbol: 'BTC', txid: 'a'.repeat(64), confirmations: 2, relay: true }, now)];
export function movements(now = Date.now()): J[] {
  const usdcBase = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const dep = (id: string, o: { network: string; symbol: string; asset?: string; decimals: number; display: string; from: string; ago: number; final?: boolean; depositKind?: string; origin?: string | null; proposalId?: string | null }): J => ({
    kind: 'receive', at: new Date(now - o.ago).toISOString(), id, network: o.network, networkName: NET_NAME[o.network] ?? o.network, asset: o.asset ?? 'native', symbol: o.symbol, decimals: o.decimals, amount: units(o.display, o.decimals), amountDisplay: o.display,
    from: o.from, txid: hash(id.slice(-1)), explorer: `https://basescan.org/tx/${hash(id.slice(-1))}`, state: o.final === false ? 'confirming' : 'finalized', depositKind: o.depositKind ?? 'external', origin: o.origin ?? null, proposalId: o.proposalId ?? null, detection: 'log', txidIsBlock: false, blockHash: null, block: 21_000_000 });
  return [
    ...PENDING(now),
    proposal({ id: IDS.dropped, network: 'solana', symbol: 'SOL', decimals: 9, display: '3.5', to: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', ago: 3 * 3600_000, lifecycle: 'dropped', state: 'failed', fee: '0.000005', feeSymbol: 'SOL', txid: '5'.repeat(64), errorCode: 'dropped', error: 'the network no longer knows this transaction', watched: true, relay: true }, now),
    proposal({ id: IDS.rent, network: 'base', symbol: 'USDC', asset: usdcBase, decimals: 6, display: '1250', to: ADDR.rent, ago: 9 * 3600_000, lifecycle: 'confirmed', state: 'finalized', fee: '0.0000021', feePaid: '0.00000184', feeSymbol: 'ETH', txid: hash('b'), confirmations: 64, relay: true, note: 'Loyer de novembre' }, now),
    dep('base:0xcc:0', { network: 'base', symbol: 'USDC', asset: usdcBase, decimals: 6, display: '812.403311', from: ADDR.me, ago: 26 * 3600_000 - 40_000, depositKind: 'internal', origin: 'swap', proposalId: IDS.swap }),
    proposal({ id: IDS.swap, kind: 'swap', network: 'base', symbol: 'ETH', decimals: 18, display: '0.17', to: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', ago: 26 * 3600_000, lifecycle: 'confirmed', state: 'finalized', fee: '0.0000094', feePaid: '0.0000081', feeSymbol: 'ETH', txid: hash('c'), confirmations: 120, relay: true,
      swap: { provider: 'kyberswap', toSymbol: 'USDC', receivedDisplay: '812.403311', minOutDisplay: '808.1', expectedOutDisplay: '812.9', slippageBps: 50, needsApproval: false, simulated: true } }, now),
    dep('ethereum:0xdd:0', { network: 'ethereum', symbol: 'ETH', decimals: 18, display: '0.5', from: ADDR.friend, ago: 2 * DAY + 3600_000 }),
    proposal({ id: IDS.replaced, network: 'arbitrum', symbol: 'USDC', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, display: '75.5', to: ADDR.exchange, ago: 3 * DAY, lifecycle: 'replaced', state: 'replaced', fee: '0.0000012', feeSymbol: 'ETH', txid: hash('e'), errorCode: 'replaced_onchain', error: 'another transaction used the same nonce', watched: true, relay: true }, now),
    dep('base:0xff:0', { network: 'base', symbol: 'USDC', asset: usdcBase, decimals: 6, display: '300', from: '0x5FbDB2315678afecb367f032d93F642f64180aa3', ago: 4 * DAY, depositKind: 'internal', origin: 'agent_withdrawal' }),
    proposal({ id: IDS.failed, network: 'ethereum', symbol: 'ETH', decimals: 18, display: '0.02', to: ADDR.friend, ago: 6 * DAY, lifecycle: 'failed', state: 'failed', fee: '0.00042', feeSymbol: 'ETH', txid: hash('f'), errorCode: 'simulation_failed', error: 'simulation failed', relay: true }, now),
    dep('bitcoin:aa:0', { network: 'bitcoin', symbol: 'BTC', decimals: 8, display: '0.05', from: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', ago: 9 * DAY }),
  ];
}
const KIND: Record<string, string> = { send: 'transfer', receive: 'receive', swap: 'swap', bridge: 'bridge' };
/** the same movements as the unified timeline answers them (dashboard/activity.ts `walletItem`) */
export function timeline(now = Date.now()): J {
  const items = movements(now).map((w) => ({ id: `w:${w.id}`, kind: KIND[w.kind] ?? 'transfer', source: 'wallet', at: w.at, mode: 'live', venue: null, network: w.network, principal: { kind: 'owner', id: 'owner' }, code: `wallet.${w.kind}`,
    params: { symbol: w.symbol }, status: w.state, instrument: w.symbol, side: null, amount: { value: w.amountDisplay, symbol: w.symbol }, received: null, ref: { type: w.kind === 'receive' ? 'deposit' : 'proposal', id: String(w.id) }, txid: w.txid, explorer: w.explorer, wallet: w }));
  return { items, nextCursor: null, errors: [], audit: { intact: true, brokenAt: null, total: 412, checkedAt: now - 60_000 }, bounds: { perSource: 500, plans: 100 }, ts: now };
}
export const CONTACTS = (): J[] => [
  { id: 'c0000000-0000-4000-8000-000000000001', network: 'base', address: ADDR.rent, label: 'Loyer — Gestion Lafontaine', note: 'Le 1er de chaque mois', favorite: true, created_at: '2026-09-02T12:00:00Z', updatedAt: null },
  { id: 'c0000000-0000-4000-8000-000000000002', network: 'ethereum', address: ADDR.friend, label: 'Mathieu', note: '', favorite: false, created_at: '2026-10-11T12:00:00Z', updatedAt: null },
  { id: 'c0000000-0000-4000-8000-000000000003', network: 'arbitrum', address: ADDR.exchange, label: 'Plateforme (dépôt USDC)', note: 'Vérifier le réseau avant chaque envoi', favorite: false, created_at: '2026-10-20T12:00:00Z', updatedAt: null },
];
/** the security overview of the real stack with a second passkey, two more sessions and — optionally — a credential mismatch */
export function patchSecurity(j: J, o: PopulateOpts = {}, now = Date.now()): J {
  const second = 'Zm9vYmFyYmF6cXV4LXNlY29uZC1wYXNza2V5LWlk';
  j.devices = [...j.devices.map((d: J) => ({ ...d, revocable: true })), { id: second.slice(0, 12), label: 'iPhone de Simon', deviceType: 'multiDevice', backedUp: true, createdAt: new Date(now - 40 * DAY).toISOString(), lastUsedAt: new Date(now - 2 * DAY).toISOString(), enrolledOnSigner: true, credentialId: second, inCooldown: false, revocable: true }];
  if (Array.isArray(j.signerCredentials)) j.signerCredentials = [...j.signerCredentials.map((c: J) => ({ ...c, revocable: true })), { id: second, createdAt: new Date(now - 40 * DAY).toISOString(), lastUsedAt: new Date(now - 2 * DAY).toISOString(), inCooldown: false, cooldownUntil: null, known: true, label: 'iPhone de Simon', revocable: true },
    ...(o.mismatch ? [{ id: 'dW5rbm93bi1jcmVkZW50aWFsLW9uLXNpZ25lcg', createdAt: new Date(now - 3600_000).toISOString(), lastUsedAt: null, inCooldown: true, cooldownUntil: new Date(now + 20 * 3600_000).toISOString(), known: false, label: null, revocable: true }] : [])];
  j.mismatch = o.mismatch ? [{ side: 'signer', id: 'dW5rbm93bi1jcmVkZW50aWFsLW9uLXNpZ25lcg' }] : [];
  j.sessions = [...j.sessions, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current: false, created_at: new Date(now - 5 * 3600_000).toISOString(), last_seen: new Date(now - 40 * 60_000).toISOString(), ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', ip: '142.170.25.2', device: 'Safari · iPhone', credential: second.slice(0, 12) },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', current: false, created_at: new Date(now - 2 * DAY).toISOString(), last_seen: new Date(now - 26 * 3600_000).toISOString(), ua: 'SPWallet/1.0 (macOS 27.0)', ip: '142.170.25.2', device: 'SP Wallet · Mac', credential: null }];
  if (j.signer?.reachable) { j.signer.recoveryExportedAt = null; j.signer.recoveryVerifiedAt = null; j.signer.credentialCooldownSec = 86_400; if (o.halted) j.signer.halted = true; }
  return j;
}
export const LOGINS = (now = Date.now()): J => ({ logins: [
  { seq: 410, at: new Date(now - 6 * 60_000).toISOString(), credential: 'abc', label: 'Cet appareil', ip: '142.170.25.2', device: 'Chrome · Mac', newDevice: false, session: null },
  { seq: 398, at: new Date(now - 5 * 3600_000).toISOString(), credential: 'Zm9vYmFyYmF6', label: 'iPhone de Simon', ip: '142.170.25.2', device: 'Safari · iPhone', newDevice: true, session: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { seq: 371, at: new Date(now - 2 * DAY).toISOString(), credential: 'abc', label: 'Cet appareil', ip: '142.170.25.2', device: 'SP Wallet · Mac', newDevice: false, session: null }] });
/** NOT a route of this branch: the shape the web client reads defensively (wallet-more.ts `readAnalytics`) */
export const ANALYTICS = (range: string): J => ({ range, currency: 'CAD', feesPaid: { total: range === '1D' ? '0.42' : '12.84', count: range === '1D' ? 1 : 9, complete: true }, networkFees: [{ network: 'base', symbol: 'ETH', fee: '0.0000021', fiat: '0.01' }] });

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
/** Lay the fixtures over the real stack for this page. Returns nothing: remove with `page.unrouteAll()`. */
export async function populate(page: Page, o: PopulateOpts = {}): Promise<void> {
  const cur = o.currency ?? 'CAD';
  await page.route('**/api/v1/portfolio', async (route) => { const r = await route.fetch(); await route.fulfill({ response: r, json: patchPortfolio(await r.json(), o) }); });
  await page.route('**/api/v1/portfolio/history?*', (route) => json(route, history(new URL(route.request().url()).searchParams.get('range') ?? '1W', cur)));
  await page.route('**/api/v1/activity?*', (route) => json(route, { items: movements() }));
  await page.route('**/api/v1/dashboard/activity?*', (route) => json(route, timeline()));
  await page.route(/\/api\/v1\/transfers\/proposals\/[0-9a-f-]{36}$/, (route) => { const id = route.request().url().split('/').pop()!, p = movements().find((m) => m.id === id); return p ? json(route, p) : route.fallback(); });
  await page.route('**/api/v1/contacts', (route) => json(route, { contacts: CONTACTS() }));
  await page.route('**/api/v1/addressbook', (route) => (route.request().method() === 'GET' ? json(route, CONTACTS()) : route.fallback()));
  await page.route('**/api/v1/security/overview', async (route) => { const r = await route.fetch(); await route.fulfill({ response: r, json: patchSecurity(await r.json(), o) }); });
  await page.route('**/api/v1/security/logins*', (route) => json(route, LOGINS()));
  // the live quotes of the real stack would lay real prices over the fixture's: the rows would no longer add up to the fixture's total
  await page.routeWebSocket(/\/api\/v1\/stream/, (ws) => { void ws.close(); });
  if (o.analytics !== false) await page.route('**/api/v1/analytics?*', (route) => json(route, ANALYTICS(new URL(route.request().url()).searchParams.get('range') ?? '1W')));
}
