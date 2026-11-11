// The signer's own READ of a venue account, used only by derivative mandates (venue-mandate.ts): positions, account value,
// resting orders and the leverage setting of an instrument, from the venue's PUBLIC info endpoint. No key is needed to read,
// nothing is ever sent to the venue's trading endpoint from here, and the hosts are pinned below (never taken from a request).
//
// Why the signer reads the venue itself: a mandate signs orders without a passkey, so its position and exposure limits must
// not depend on what the API says the positions are. What this trusts: the venue's info endpoint, for the SIZE of the
// positions, the resting orders and the account value. A venue that lies about them can already do anything with the funds
// it holds; it is the same party that executes the orders. What it does not trust the venue for: prices (prices.ts).
// Any doubt — unreachable, HTTP error, an answer that does not have exactly the expected shape — is an error: no signature.
export type VenueNetwork = 'mainnet' | 'testnet';
export interface VenuePositionView { coin: string; /** signed size */ szi: string; /** the venue's own valuation of the position, at its mark */ positionValue: string; leverage: { type: 'cross' | 'isolated'; value: number } }
export interface VenueOpenOrderView { coin: string; side: 'buy' | 'sell'; /** remaining size */ size: string; /** the higher of the limit and the trigger price */ price: string; reduceOnly: boolean; cloid: string | null; /** when the venue took the order (unix ms) */ timestamp: number }
export interface VenueAccountView { /** the venue's own timestamp of the account state (unix ms) */ time: number; accountValue: string; totalNtlPos: string; positions: VenuePositionView[]; openOrders: VenueOpenOrderView[] }
export interface VenueReader {
  /** positions, account value and resting orders of an account; throws when they cannot be established */
  account(network: VenueNetwork, account: string): Promise<VenueAccountView>;
  /** the leverage setting of one instrument on the account */
  leverage(network: VenueNetwork, account: string, coin: string): Promise<{ type: 'cross' | 'isolated'; value: number }>;
}
export type JsonPost = (url: string, body: unknown) => Promise<unknown>;

/** the only venue hosts the signer ever contacts, and only their /info path */
export const VENUE_INFO_URL: Record<VenueNetwork, string> = { mainnet: 'https://api.hyperliquid.xyz/info', testnet: 'https://api.hyperliquid-testnet.xyz/info' };
const TIMEOUT_MS = 6000, MAX_BYTES = 400_000, MAX_ROWS = 2000;
const post: JsonPost = async (url, body) => {
  const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'account-check' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  if (t.length > MAX_BYTES) throw new Error('response too large');
  return JSON.parse(t);
};

const DEC = /^-?(0|[1-9]\d{0,24})(\.\d{1,24})?$/, COIN = /^[A-Za-z0-9:@/._-]{1,40}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
const bad = (what: string): never => { throw new Error(`unexpected venue answer (${what})`); };
const obj = (v: unknown, what: string): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(what));
const dec = (v: unknown, what: string): string => (typeof v === 'string' && DEC.test(v) ? v : bad(what));
const nonNeg = (v: unknown, what: string): string => { const d = dec(v, what); return d.startsWith('-') ? bad(what) : d; };
const coin = (v: unknown, what: string): string => (typeof v === 'string' && COIN.test(v) ? v : bad(what));
const lev = (v: unknown, what: string): { type: 'cross' | 'isolated'; value: number } => {
  const l = obj(v, what);
  if ((l.type !== 'cross' && l.type !== 'isolated') || !Number.isInteger(l.value) || (l.value as number) < 1 || (l.value as number) > 1000) bad(what);
  return { type: l.type as 'cross' | 'isolated', value: l.value as number };
};
/** numeric comparison of two non-negative decimal strings, without floats */
const higher = (a: string, b: string): string => {
  const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.'), n = Math.max(af.length, bf.length);
  return BigInt(ai + af.padEnd(n, '0')) >= BigInt(bi + bf.padEnd(n, '0')) ? a : b;
};

export function hyperliquidReader(send: JsonPost = post): VenueReader {
  const user = (account: string): string => (ADDRESS.test(account) ? account : bad('account address'));
  return {
    async account(network, account) {
      const url = VENUE_INFO_URL[network] ?? bad('network'), u = user(account);
      // both must answer; the account state is read last so that its timestamp is not older than the order list
      const ordersRaw = await send(url, { type: 'frontendOpenOrders', user: u });
      const s = obj(await send(url, { type: 'clearinghouseState', user: u }), 'clearinghouseState');
      const m = obj(s.marginSummary, 'marginSummary');
      if (!Number.isSafeInteger(s.time) || (s.time as number) <= 0) bad('time');
      if (!Array.isArray(s.assetPositions) || s.assetPositions.length > MAX_ROWS) bad('assetPositions');
      const positions = (s.assetPositions as unknown[]).map((row): VenuePositionView => {
        const p = obj(obj(row, 'assetPosition').position, 'position');
        return { coin: coin(p.coin, 'position coin'), szi: dec(p.szi, 'szi'), positionValue: nonNeg(p.positionValue, 'positionValue'), leverage: lev(p.leverage, 'position leverage') };
      });
      if (!Array.isArray(ordersRaw) || ordersRaw.length > MAX_ROWS) bad('frontendOpenOrders');
      const openOrders = (ordersRaw as unknown[]).map((row): VenueOpenOrderView => {
        const o = obj(row, 'open order');
        if ((o.side !== 'B' && o.side !== 'A') || typeof o.reduceOnly !== 'boolean' || typeof o.isTrigger !== 'boolean') bad('open order');
        const limit = nonNeg(o.limitPx, 'limitPx'), trigger = o.isTrigger ? nonNeg(o.triggerPx, 'triggerPx') : '0';
        const cloid = o.cloid === null || o.cloid === undefined ? null : typeof o.cloid === 'string' && /^0x[0-9a-f]{32}$/.test(o.cloid) ? o.cloid : bad('cloid');
        if (!Number.isSafeInteger(o.timestamp) || (o.timestamp as number) < 0) bad('order timestamp');
        return { coin: coin(o.coin, 'order coin'), side: o.side === 'B' ? 'buy' : 'sell', size: nonNeg(o.sz, 'sz'), price: higher(limit, trigger), reduceOnly: o.reduceOnly as boolean, cloid, timestamp: o.timestamp as number };
      });
      return { time: s.time as number, accountValue: dec(m.accountValue, 'accountValue'), totalNtlPos: nonNeg(m.totalNtlPos, 'totalNtlPos'), positions, openOrders };
    },
    async leverage(network, account, c) {
      const url = VENUE_INFO_URL[network] ?? bad('network');
      const a = obj(await send(url, { type: 'activeAssetData', user: user(account), coin: coin(c, 'coin') }), 'activeAssetData');
      if (a.coin !== undefined && a.coin !== c) bad('activeAssetData is for another coin');
      return lev(a.leverage, 'leverage');
    },
  };
}
/** default of the Signer class (tests, CLI paths): no venue view, so nothing that needs one is ever signed */
export const noVenueReader: VenueReader = { account: async () => { throw new Error('no venue reader configured'); }, leverage: async () => { throw new Error('no venue reader configured'); } };
