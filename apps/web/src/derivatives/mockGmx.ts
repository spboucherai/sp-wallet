/**
 * Browser mock of the GMX v2 trading routes (`/api/v1/derivatives/gmx/*`, v8) — development and browser tests only, loaded with
 * the rest of the mock (`?mock=1`), never part of a production build. It answers with the shapes of the section "GMX v2 trading
 * (v8)" of docs/v4/API-LIVE-NOTES.md: `GmxStatus`, `GmxPreview`, `GmxPrepared`, `GmxOperation`, the blocker and error codes.
 *
 * NOT real: there is no chain, no keeper, no signer, no risk engine. Time does the work of the network: an approved operation
 * is `signed`, then `sent`, then `created` (the order exists on-chain and waits for a keeper), then — `keeper` mode —
 * `executed` (default), `cancelled` by the keeper, or left pending. The owner's cancellation delay is `requestExpirationSec`
 * (300 s in `facts`, as on the real venue) but the mock lets the owner cancel after `cancelMs` so that a test does not wait
 * five minutes. Fees and rates are plausible constants, the intent hash is 32 random bytes (enough to bind the simulated
 * passkey), the addresses of `pins.contracts` are placeholders. Nothing here is evidence of how the real backend behaves.
 *
 * Scenario: `&gmx=<name>` (kept for the tab in sessionStorage `spw-mock-gmx`, like `mock=1`; `&gmx=` forgets it), or
 * `window.__spwMock.gmx.scenario(name)` — see `GmxScenario`. Both server settings are OFF by default.
 */
type Side = 'long' | 'short';
export type GmxScenario =
  | 'off'            /** default: SPW_DERIV_GMX_LIVE and SPW_DERIV_LIVE_MAINNET off */
  | 'mainnet-off'    /** SPW_DERIV_GMX_LIVE on, SPW_DERIV_LIVE_MAINNET off */
  | 'on'             /** both settings on, no authorization yet */
  | 'ready'          /** settings on + an active authorization: tradable */
  | 'position'       /** ready + a long BTC position read from the chain */
  | 'keeper-cancel'  /** ready; the keeper cancels the next orders (price moved beyond the acceptable price) */
  | 'pending'        /** ready; no keeper comes: the order stays `created`, the owner may cancel after the delay */
  | 'contracts'      /** GMX published new contracts: pins.ok false, authorization stale */
  | 'halted' | 'unreadable' | 'expired';
export interface GmxHooks {
  scenario: (s: GmxScenario) => void;
  /** the two simulated server settings */ settings: (liveMainnet: boolean, gmxLive: boolean) => void;
  /** what the keeper does with the next created orders */ keeper: (mode: 'execute' | 'cancel' | 'never') => void;
  /** ms from `created` to the keeper's transaction, and to the moment the owner may cancel */ delays: (d: { keeperMs?: number; cancelMs?: number; ttlMs?: number }) => void;
  /** the next passkey check of the simulated signer fails */ signerRefuses: () => void;
  state: () => { tradable: boolean; blockers: string[]; operations: { id: string; kind: string; state: string }[]; positions: number; usdc: string };
}
export interface GmxMockEnv { now: () => number; /** the mock market's mark for an instrument id */ mark: (instrument: string) => number | null }
interface Out { status: number; json: unknown }
class Refuse extends Error { code: string; status: number; constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; } }

const MARKETS = [
  { market: '0x47c031236e19d024b42f8AE6780E44A573170703', name: 'BTC/USD [WBTC.b-USDC]', instrument: 'gmx:BTC/USD [BTC-USDC]', base: 'BTC', indexDecimals: 8 },
  { market: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336', name: 'ETH/USD [WETH-USDC]', instrument: 'gmx:ETH/USD [WETH-USDC]', base: 'ETH', indexDecimals: 18 },
] as const;
const USDC = { token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 };
const ACCOUNT = '0x8E2a4cB1f0d35A7c9F1e6b0D4a3C5e7F9b1D2a3C';
const EX = 'https://arbiscan.io';
// placeholders with the names of the real contract set (the real pins are in the backend, not here)
const CONTRACTS = [['ExchangeRouter', '0x1111111111111111111111111111111111111101'], ['Router', '0x1111111111111111111111111111111111111102'], ['OrderVault', '0x1111111111111111111111111111111111111103'],
  ['Reader', '0x1111111111111111111111111111111111111104'], ['DataStore', '0x1111111111111111111111111111111111111105']].map(([name, address]) => ({ name: name!, address: address!, explorer: `${EX}/address/${address}` }));
const ACK = {
  fr: 'GMX v2 est un protocole décentralisé de contrats perpétuels sur Arbitrum. Il n’y a ni carnet d’ordres ni compte chez une plateforme : chaque ordre est une transaction de votre portefeuille, exécutée ensuite par un exécutant (« keeper ») du réseau GMX au prix de l’oracle.\n\n1. Vous êtes seul responsable de vérifier que la négociation de dérivés sur GMX vous est permise là où vous résidez. Ce portefeuille ne le vérifie pas à votre place.\n\n2. Les contrats perpétuels à effet de levier peuvent entraîner la perte de toute la garantie engagée. Le prix de liquidation affiché est une estimation.\n\n3. Un ordre créé peut être exécuté à un prix différent du prix affiché, dans la limite du prix acceptable que vous signez, ou annulé par le réseau ; la garantie revient alors au portefeuille, moins les frais de réseau.\n\n4. Les frais (position, impact de prix, exécution, réseau, financement, emprunt) sont ceux du protocole au moment de l’exécution ; les montants affichés avant la signature sont des estimations.\n\n5. Les contrats de GMX peuvent être mis à jour par le protocole. Si l’ensemble de contrats change, cette autorisation cesse de valoir jusqu’à une nouvelle revue.\n\n(Texte de démonstration du simulateur de développement — le texte réel est fourni par le serveur.)',
  en: 'GMX v2 is a decentralized perpetual-contract protocol on Arbitrum. There is no order book and no account at a venue: each order is a transaction of your wallet, executed afterwards by a keeper of the GMX network at the oracle price.\n\n1. You alone are responsible for checking that trading derivatives on GMX is permitted where you live. This wallet does not check it for you.\n\n2. Leveraged perpetual contracts can lose the whole collateral committed. The liquidation price shown is an estimate.\n\n3. A created order may be executed at a price different from the one shown, within the acceptable price you sign, or cancelled by the network; the collateral then returns to the wallet, less network fees.\n\n4. Fees (position, price impact, execution, network, funding, borrowing) are the protocol’s at execution time; amounts shown before signing are estimates.\n\n5. GMX’s contracts can be updated by the protocol. If the contract set changes, this authorization stops applying until a new review.\n\n(Demonstration text of the development simulator — the real text comes from the server.)',
};
const BLOCKER_TEXT: Record<string, [string, string]> = {
  gmx_setting_off: ['La négociation sur GMX est désactivée sur ce serveur (SPW_DERIV_GMX_LIVE n’est pas « on »).', 'Trading on GMX is disabled on this server (SPW_DERIV_GMX_LIVE is not "on").'],
  mainnet_setting_off: ['La négociation réelle est désactivée sur ce serveur (SPW_DERIV_LIVE_MAINNET n’est pas « on »).', 'Real trading is disabled on this server (SPW_DERIV_LIVE_MAINNET is not "on").'],
  not_authorized: ['Aucune politique GMX n’a été approuvée avec la clé d’accès.', 'No GMX policy has been approved with the passkey.'],
  authorization_expired: ['L’autorisation GMX a expiré.', 'The GMX authorization has expired.'],
  authorization_revoked: ['L’autorisation GMX a été révoquée.', 'The GMX authorization was revoked.'],
  contracts_changed: ['GMX a publié de nouveaux contrats : nouvelle revue nécessaire.', 'GMX published new contracts: a new review is needed.'],
  signer_halted: ['Le signataire est à l’arrêt : il ne signe plus rien.', 'The signer is halted: it signs nothing.'],
  chain_unreadable: ['Arbitrum n’a pas pu être lu : les positions sont inconnues.', 'Arbitrum could not be read: positions are unknown.'],
  wallet_unreadable: ['Les soldes du portefeuille n’ont pas pu être lus.', 'The wallet balances could not be read.'],
};

const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const b64u = (hexStr: string) => btoa(String.fromCharCode(...(hexStr.match(/../g) ?? []).map((h) => parseInt(h, 16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const d = (n: number, dp: number): string => { const s = n.toFixed(dp); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s; };
const isDec = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/.test(x);

interface Auth { id: string; raw: Record<string, unknown>; policy: { allowedMarkets: string[]; maxLeverage: number; maxOrderSizeUsd: string; maxOrdersPerDay: number; maxPriceDeviationBps: number; maxExecutionFeeWei: string }; createdAt: number; expiresAt: number; revoked: boolean; stale: boolean; hash: string; increases: number; reduces: number }
interface Pos { key: string; market: string; side: Side; sizeUsd: number; sizeTokens: number; collateral: number; entry: number; increasedAt: number }
interface Op { id: string; kind: 'increase' | 'decrease' | 'cancel'; state: string; final: boolean; market: string | null; side: Side | null; collateral: number | null; sizeUsd: number | null; acceptable: number | null; slippageBps: number | null; leverage: number | null;
  needsApproval: boolean; orderKey: string | null; targetOpId: string | null; hash: string; proposalId: string; txid: string | null; createdAt: number; expiresAt: number; approvedAt: number | null; orderCreatedAt: number | null; doneAt: number | null;
  cancellableAt: number | null; estimate: any; outcome: any; error: string | null; keeper: 'execute' | 'cancel' | 'never'; keeperMs: number; moved: boolean; key: string | null }

export function createGmxMock(env: GmxMockEnv) {
  let LIVE_MAINNET = false, GMX_LIVE = false, PINS_OK: boolean | null = true, HALTED = false, UNREADABLE = false, AUTH: Auth | null = null, PREPARED: { raw: Record<string, unknown>; hash: string; auth: Auth } | null = null;
  let KEEPER: 'execute' | 'cancel' | 'never' = 'execute', KEEPER_MS = 3500, CANCEL_MS = 6000, TTL_MS = 120_000, REFUSE_NEXT = false, APPROVED_USDC = false;
  let WUSDC = 250, WETH_ = 0.0042, SPENT = 0;
  const PER_TX = 100, PER_DAY = 300, EXEC_FEE = 0.00012, GAS_MAX = 0.00035, GAS_EXPECTED = 0.00009, FEE_CEIL = 0.002;
  const OPS: Op[] = [], POS: Pos[] = [], BY_KEY = new Map<string, Op>();
  const now = () => env.now();
  const mkt = (addr: unknown) => MARKETS.find((m) => typeof addr === 'string' && m.market.toLowerCase() === addr.toLowerCase());
  const markOf = (m: (typeof MARKETS)[number]) => env.mark(m.instrument) ?? (m.base === 'BTC' ? 68000 : 3400);
  const ethUsd = () => markOf(MARKETS[1]);
  const options = (hash: string) => ({ challenge: b64u(hash), timeout: 120_000, rpId: location.hostname, allowCredentials: [], userVerification: 'required' as const });
  const approves = (assertion: unknown, hash: string): boolean => { if (REFUSE_NEXT) { REFUSE_NEXT = false; return false; }
    try { return JSON.parse(atob(String((assertion as any)?.response?.clientDataJSON).replace(/-/g, '+').replace(/_/g, '/'))).challenge === b64u(hash); } catch { return false; } };

  const authState = (a: Auth) => (a.stale ? 'stale' : a.revoked ? 'revoked' : a.expiresAt * 1000 <= now() ? 'expired' : 'active');
  function blockers(): string[] {
    const b: string[] = [];
    if (!GMX_LIVE) b.push('gmx_setting_off');
    if (!LIVE_MAINNET) b.push('mainnet_setting_off');
    if (PINS_OK === false) b.push('contracts_changed');
    if (HALTED) b.push('signer_halted');
    if (UNREADABLE) b.push('chain_unreadable', 'wallet_unreadable');
    if (!AUTH) b.push('not_authorized');
    else { const s = authState(AUTH); if (s === 'expired') b.push('authorization_expired'); else if (s === 'revoked') b.push('authorization_revoked'); else if (s === 'stale' && PINS_OK !== false) b.push('not_authorized'); }
    return b;
  }
  /** the refusals of every writing route, in the order of the contract: settings, contracts, authorization */
  function gate(): void {
    if (!GMX_LIVE) throw new Refuse('gmx_disabled', 'GMX trading is disabled on this server (SPW_DERIV_GMX_LIVE is not "on"): nothing was built, signed or sent', 403);
    if (!LIVE_MAINNET) throw new Refuse('mainnet_disabled', 'real trading is disabled on this server (SPW_DERIV_LIVE_MAINNET is not "on"): nothing was built, signed or sent', 403);
    if (PINS_OK === false) throw new Refuse('contract_changed', 'GMX a publié de nouveaux contrats : nouvelle revue nécessaire', 503);
    if (UNREADABLE) throw new Refuse('chain_unreadable', 'Arbitrum could not be read: eth_call timed out after 8000 ms', 503);
  }
  const needAuth = (): Auth => { if (!AUTH || authState(AUTH) !== 'active') throw new Refuse('not_authorized', 'no active GMX authorization: approve the venue policy with the passkey first', 409); return AUTH; };

  // ------------------------------------------------------------------ estimate
  function estimate(m: (typeof MARKETS)[number], side: Side, action: 'increase' | 'decrease', collateral: number | null, sizeUsd: number, bps: number, entryLev: number | null) {
    const mark = markOf(m), min = mark * 0.9999, max = mark * 1.0001, up = (side === 'long') === (action === 'increase');
    const ref = up ? max : min, acceptable = up ? ref * (1 + bps / 10000) : ref * (1 - bps / 10000), feeBps = 6, fee = sizeUsd * feeBps / 10000, impact = -sizeUsd * 0.00012, e = ethUsd();
    const fund = side === 'long' ? 0.0000081 : -0.0000034, borrow = 0.0000052;
    const liq = entryLev && action === 'increase' ? (side === 'long' ? ref * (1 - 1 / entryLev + 0.012) : ref * (1 + 1 / entryLev - 0.012)) : null;
    const approval = action === 'increase' && !APPROVED_USDC;
    return { source: 'estimate', referencePrice: d(ref, 2), oracleMin: d(min, 2), oracleMax: d(max, 2), acceptablePrice: d(acceptable, 2), slippageBps: bps, sizeUsd: d(sizeUsd, 2), sizeTokens: d(sizeUsd / ref, 8), collateral: collateral === null ? null : d(collateral, 6),
      leverage: entryLev === null ? null : d(entryLev, 2), positionFee: { usd: d(fee, 4), bps: String(feeBps), balanceImproved: false },
      priceImpact: { usd: d(impact, 4), uncertaintyUsd: d(sizeUsd * 0.0001, 4), settledAt: 'close', capped: false, note: 'computed from the pool imbalance at the time of the preview; the real impact is fixed at execution and settled when the position is closed' },
      executionFee: { eth: d(EXEC_FEE, 8), usd: d(EXEC_FEE * e, 2), sentWei: String(Math.round(EXEC_FEE * 1e18)), note: 'paid to the keeper; the unused part is refunded to the wallet in the execution transaction' },
      gas: { maxEth: d(GAS_MAX * (approval ? 1.4 : 1), 8), expectedEth: d(GAS_EXPECTED * (approval ? 1.4 : 1), 8), usd: d(GAS_EXPECTED * (approval ? 1.4 : 1) * e, 2) }, approval,
      funding: { perHour: d(fund, 10), usdPerDay: d(sizeUsd * fund * 24, 4) }, borrow: { perHour: d(borrow, 10), usdPerDay: d(sizeUsd * borrow * 24, 4) },
      liquidationPrice: liq === null ? null : d(liq, 2), liquidationNote: 'estimate from the minimum collateral factor of the market, before funding and borrowing fees accrue',
      totalAtEntryUsd: d(fee + (GAS_EXPECTED + EXEC_FEE) * e, 2), notes: ['mock estimate: constants, not the venue\'s formulas'], ts: now() };
  }
  /** the order as the routes take it + the first refusal of the simulated risk engine */
  function resolve(b: any) {
    const m = mkt(b?.market);
    if (!m || (b.side !== 'long' && b.side !== 'short') || (b.action !== 'increase' && b.action !== 'decrease')) throw new Refuse('bad_request', 'invalid request', 400);
    const bps = b.slippageBps === undefined ? 50 : b.slippageBps;
    if (!Number.isInteger(bps) || bps < 1 || bps > 500) throw new Refuse('bad_request', 'slippageBps must be an integer between 1 and 500', 400);
    let collateral: number | null = null, sizeUsd: number, leverage: number | null = null, risk: { ok: true } | { ok: false; code: string; reason: string } = { ok: true };
    const pos = POS.find((p) => p.market === m.market && p.side === b.side);
    if (b.action === 'increase') {
      if (!isDec(b.collateral) || (b.leverage === undefined) === (b.sizeUsd === undefined) || (b.leverage !== undefined && !isDec(b.leverage)) || (b.sizeUsd !== undefined && !isDec(b.sizeUsd))) throw new Refuse('bad_request', 'an increase needs collateral and exactly one of leverage and sizeUsd', 400);
      collateral = Number(b.collateral); sizeUsd = b.leverage !== undefined ? collateral * Number(b.leverage) : Number(b.sizeUsd); leverage = sizeUsd / collateral;
      const p = AUTH?.policy;
      if (sizeUsd < 2) risk = { ok: false, code: 'below_min_size', reason: 'the smallest position on this market is 2 USD' };
      else if (p && leverage > p.maxLeverage + 1e-9) risk = { ok: false, code: 'leverage_exceeded', reason: `leverage ${d(leverage, 2)}× is above the ${p.maxLeverage}× of the venue policy` };
      else if (p && sizeUsd > Number(p.maxOrderSizeUsd) + 1e-9) risk = { ok: false, code: 'order_size_exceeded', reason: `size ${d(sizeUsd, 2)} USD is above the ${p.maxOrderSizeUsd} USD of the venue policy` };
      else if (collateral > WUSDC) risk = { ok: false, code: 'insufficient_collateral', reason: `the wallet holds ${d(WUSDC, 2)} USDC on Arbitrum` };
      else if (WETH_ < EXEC_FEE + GAS_MAX) risk = { ok: false, code: 'insufficient_gas', reason: 'the wallet does not hold enough ETH on Arbitrum for the execution fee and the gas' };
    } else {
      if (!isDec(b.sizeUsd)) throw new Refuse('bad_request', 'a decrease needs sizeUsd', 400);
      sizeUsd = Number(b.sizeUsd);
      if (!pos) risk = { ok: false, code: 'no_position', reason: `no ${b.side} position on ${m.name}` };
      else if (sizeUsd > pos.sizeUsd + 0.005) risk = { ok: false, code: 'reduce_would_flip', reason: 'the size is larger than the position' };
    }
    const signerWould = !AUTH || authState(AUTH) !== 'active' ? null : !AUTH.policy.allowedMarkets.some((x) => x.toLowerCase() === m.market.toLowerCase()) ? 'market_not_allowed: this market is not in the venue policy'
      : b.action === 'increase' && AUTH.increases >= AUTH.policy.maxOrdersPerDay ? 'orders_per_day: the daily number of orders of the venue policy is reached' : null;
    return { m, side: b.side as Side, action: b.action as 'increase' | 'decrease', collateral, sizeUsd, leverage, bps, risk, signerWould, estimate: estimate(m, b.side, b.action, collateral, sizeUsd, bps, leverage) };
  }

  // ------------------------------------------------------------------ operations
  function settle(o: Op, executed: boolean): void {
    const t = o.orderCreatedAt! + o.keeperMs, m = mkt(o.market)!, e = o.estimate, txid = `0x${rnd(32)}`;
    o.doneAt = t; o.final = true;
    if (!executed) {
      o.state = 'cancelled';
      if (o.kind === 'increase') WUSDC += o.collateral!;
      WETH_ += EXEC_FEE * 0.4;
      o.outcome = { event: 'OrderCancelled', txid, explorer: `${EX}/tx/${txid}`, executionPrice: null, sizeUsd: null, positionFeeUsd: null, priceImpactUsd: null, pnlUsd: null, collateralOut: o.kind === 'increase' ? d(o.collateral!, 6) : null,
        executionFeeRefundEth: d(EXEC_FEE * 0.4, 8), reason: 'the oracle price moved beyond the acceptable price of the order before a keeper could execute it', reasonCode: 'OrderNotFulfillableAtAcceptablePrice', cancelledBy: 'keeper', collateralReturned: o.kind === 'increase' ? true : null };
      return;
    }
    const price = Number(e.referencePrice) * (o.side === 'long' ? 1.00004 : 0.99996), fee = Number(e.positionFee.usd);
    o.state = 'executed'; WETH_ += EXEC_FEE * 0.55;
    let pnl: number | null = null, out: number | null = null;
    const i = POS.findIndex((p) => p.market === o.market && p.side === o.side), p = POS[i];
    if (o.kind === 'increase') {
      const tokens = o.sizeUsd! / price;
      if (p) { p.entry = (p.sizeUsd + o.sizeUsd!) / (p.sizeTokens + tokens); p.sizeUsd += o.sizeUsd!; p.sizeTokens += tokens; p.collateral += o.collateral! - fee; p.increasedAt = Math.floor(t / 1000); }
      else POS.push({ key: `0x${rnd(32)}`, market: m.market, side: o.side!, sizeUsd: o.sizeUsd!, sizeTokens: tokens, collateral: o.collateral! - fee, entry: price, increasedAt: Math.floor(t / 1000) });
    } else if (p) {
      const f = Math.min(1, o.sizeUsd! / p.sizeUsd), tokens = p.sizeTokens * f;
      pnl = (o.side === 'long' ? 1 : -1) * (price - p.entry) * tokens; out = Math.max(0, p.collateral * f + pnl - fee);
      WUSDC += out;
      if (f >= 0.9999) POS.splice(i, 1); else { p.sizeUsd -= o.sizeUsd!; p.sizeTokens -= tokens; p.collateral -= p.collateral * f; }
    }
    o.outcome = { event: 'OrderExecuted', txid, explorer: `${EX}/tx/${txid}`, executionPrice: d(price, 2), sizeUsd: d(o.sizeUsd!, 2), positionFeeUsd: d(fee, 4), priceImpactUsd: o.kind === 'decrease' ? e.priceImpact.usd : null, pnlUsd: pnl === null ? null : d(pnl, 4),
      collateralOut: out === null ? null : d(out, 6), executionFeeRefundEth: d(EXEC_FEE * 0.55, 8), reason: null, reasonCode: null, cancelledBy: null, collateralReturned: null };
  }
  /** time moves an operation forward: read on every request, like the backend re-reads the chain */
  function advance(o: Op): void {
    const t = now();
    if (o.final) return;
    if (o.approvedAt === null) { if (t > o.expiresAt) { o.state = 'expired'; o.final = true; o.error = 'expired before approval; nothing was signed'; } return; }
    const since = t - o.approvedAt;
    if (since < 700) { o.state = 'signed'; return; }
    if (!o.moved) { o.moved = true; o.txid = `0x${rnd(32)}`;                       // the wallet's transaction is mined: the collateral and the execution fee leave
      if (o.kind === 'increase') { WUSDC -= o.collateral!; SPENT += o.collateral!; APPROVED_USDC = true; }
      WETH_ -= o.kind === 'cancel' ? GAS_EXPECTED : EXEC_FEE + GAS_EXPECTED; }
    if (since < 1600) { o.state = 'sent'; return; }
    if (o.kind === 'cancel') {
      const target = OPS.find((x) => x.id === o.targetOpId);
      o.state = 'done'; o.final = true; o.doneAt = o.approvedAt + 1600;
      if (target && target.state === 'created') { target.state = 'cancelled'; target.final = true; target.doneAt = o.doneAt; if (target.kind === 'increase') WUSDC += target.collateral!; WETH_ += EXEC_FEE;
        target.outcome = { event: 'OrderCancelled', txid: o.txid, explorer: `${EX}/tx/${o.txid}`, executionPrice: null, sizeUsd: null, positionFeeUsd: null, priceImpactUsd: null, pnlUsd: null, collateralOut: target.kind === 'increase' ? d(target.collateral!, 6) : null,
          executionFeeRefundEth: d(EXEC_FEE, 8), reason: 'cancelled by the wallet after the request expiration delay', reasonCode: null, cancelledBy: 'owner', collateralReturned: target.kind === 'increase' ? true : null }; }
      return;
    }
    if (o.orderCreatedAt === null) { o.orderCreatedAt = o.approvedAt + 1600; o.orderKey = `0x${rnd(32)}`; o.cancellableAt = o.orderCreatedAt + CANCEL_MS; }
    o.state = 'created';
    if (o.keeper !== 'never' && t >= o.orderCreatedAt + o.keeperMs) settle(o, o.keeper === 'execute');
  }
  function view(o: Op) {
    const m = mkt(o.market), t = now();
    return { id: o.id, kind: o.kind, state: o.state, final: o.final, market: o.market, marketName: m?.name ?? null, side: o.side, collateral: o.collateral === null ? null : d(o.collateral, 6), collateralSymbol: o.collateral === null ? null : 'USDC',
      sizeUsd: o.sizeUsd === null ? null : d(o.sizeUsd, 2), acceptablePrice: o.acceptable === null ? null : d(o.acceptable, 2), slippageBps: o.slippageBps, leverage: o.leverage === null ? null : d(o.leverage, 2),
      executionFeeEth: d(o.kind === 'cancel' ? 0 : EXEC_FEE, 8), maxFeeEth: d(o.kind === 'cancel' ? GAS_MAX : GAS_MAX + EXEC_FEE, 8), needsApproval: o.needsApproval, orderKey: o.orderKey, targetOpId: o.targetOpId, hash: o.hash, proposalId: o.proposalId,
      txid: o.txid, explorer: o.txid ? `${EX}/tx/${o.txid}` : null, approvalTxid: null, createdAt: o.createdAt, expiresAt: o.expiresAt, sentAt: o.approvedAt === null ? null : o.approvedAt + 700, orderCreatedAt: o.orderCreatedAt, doneAt: o.doneAt, checkedAt: t,
      cancellableAt: o.cancellableAt, overdue: o.state === 'created' && o.orderCreatedAt !== null && t - o.orderCreatedAt > 600_000, estimate: o.estimate, outcome: o.outcome, error: o.error };
  }
  const find = (id: string): Op => { const o = OPS.find((x) => x.id === id); if (!o) throw new Refuse('unknown_operation', 'unknown GMX operation', 404); advance(o); return o; };
  const F = (label: string, value: string) => ({ label, value });
  function prepared(o: Op) {
    const m = mkt(o.market), v = view(o), t = OPS.find((x) => x.id === o.targetOpId);
    const fields = o.kind === 'cancel'
      ? [F('action', 'cancel'), F('market', mkt(t?.market)?.name ?? '—'), F('orderKey', t?.orderKey ?? '—'), F('maxFee', `${v.maxFeeEth} ETH`), F('network', 'Arbitrum One (42161)'), F('exchangeRouter', CONTRACTS[0]!.address), F('expiresAt', new Date(o.expiresAt).toISOString())]
      : [F('action', o.kind), F('market', `${m!.name} (${m!.market})`), F('side', o.side!), F('orderType', o.kind === 'increase' ? 'MarketIncrease' : 'MarketDecrease'), ...(o.kind === 'increase' ? [F('collateral', `${v.collateral} USDC`)] : []), F('sizeUsd', `${v.sizeUsd} USD`),
        ...(o.leverage !== null ? [F('leverage', `${v.leverage}×`)] : []), F('acceptablePrice', `${v.acceptablePrice} USD`), F('executionFee', `${v.executionFeeEth} ETH`), F('maxFee', `${v.maxFeeEth} ETH`), F('network', 'Arbitrum One (42161)'),
        F('exchangeRouter', CONTRACTS[0]!.address), F('router', CONTRACTS[1]!.address), F('orderVault', CONTRACTS[2]!.address), F('expiresAt', new Date(o.expiresAt).toISOString())];
    const fixed = o.kind === 'cancel' ? [F('receiver', ACCOUNT)]
      : [F('receiver', ACCOUNT), F('cancellationReceiver', ACCOUNT), F('callbackContract', 'none (0x0000000000000000000000000000000000000000)'), F('uiFeeReceiver', 'none (0x0000000000000000000000000000000000000000)'), F('swapPath', '[] (no swap)'),
        F('referralCode', 'none (0x00…00)'), F('minOutputAmount', '0'), F('shouldUnwrapNativeToken', 'false')];
    return { operation: v, intent: { v: 1, proposalId: o.proposalId, network: 'arbitrum', chainRef: '42161', from: ACCOUNT, gmx: { kind: o.kind, market: o.market, side: o.side, orderKey: t?.orderKey ?? null } }, estimate: o.estimate, fields, fixed, options: options(o.hash) };
  }
  function newOp(key: string | null, x: Partial<Op> & Pick<Op, 'kind'>): Op {
    for (const p of OPS) if (p.state === 'pending_approval') { p.state = 'withdrawn'; p.final = true; p.error = 'replaced by a newer proposal; nothing was signed'; }
    const t = now(), o: Op = { id: crypto.randomUUID(), state: 'pending_approval', final: false, market: null, side: null, collateral: null, sizeUsd: null, acceptable: null, slippageBps: null, leverage: null, needsApproval: false, orderKey: null, targetOpId: null,
      hash: rnd(32), proposalId: crypto.randomUUID(), txid: null, createdAt: t, expiresAt: t + TTL_MS, approvedAt: null, orderCreatedAt: null, doneAt: null, cancellableAt: null, estimate: null, outcome: null, error: null, keeper: KEEPER, keeperMs: KEEPER_MS, moved: false, key, ...x };
    OPS.push(o); if (key) BY_KEY.set(key, o);
    return o;
  }
  function order(b: any, key: string | null) {
    if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new Refuse('idempotency', 'an Idempotency-Key header is required', 400);
    const had = BY_KEY.get(key); if (had) { advance(had); return prepared(had); }
    gate(); needAuth();
    const r = resolve(b);
    if (!r.risk.ok) throw new Refuse(`risk_${r.risk.code}`, r.risk.reason, 422);
    if (r.signerWould) throw new Refuse(`signer_${r.signerWould.split(':')[0]}`, r.signerWould, 422);
    if (r.action === 'increase' && (r.collateral! > PER_TX || SPENT + r.collateral! > PER_DAY)) throw new Refuse('policy', `amount above the wallet limit for arbitrum:USDC (${PER_TX} per transaction, ${PER_DAY} per day, ${d(SPENT, 2)} spent today)`, 422);
    if (OPS.some((o) => !o.final && (o.state === 'signed' || o.state === 'sent'))) throw new Refuse('pending_tx', 'another transaction of the wallet on Arbitrum is not confirmed yet', 409);
    return prepared(newOp(key, { kind: r.action, market: r.m.market, side: r.side, collateral: r.collateral, sizeUsd: r.sizeUsd, acceptable: Number(r.estimate.acceptablePrice), slippageBps: r.bps, leverage: r.leverage, needsApproval: r.estimate.approval, estimate: r.estimate }));
  }

  // ------------------------------------------------------------------ status
  function status(locale: string) {
    for (const o of OPS) advance(o);
    const t = now(), b = blockers(), fr = locale !== 'en', room = Math.max(0, PER_DAY - SPENT);
    const positions = UNREADABLE ? [] : POS.map((p) => { const m = mkt(p.market)!, mark = markOf(m), pnl = (p.side === 'long' ? 1 : -1) * (mark - p.entry) * p.sizeTokens, lv = p.sizeUsd / p.collateral;
      return { key: p.key, market: p.market, marketName: m.name, instrument: m.instrument, side: p.side, collateralToken: USDC.token, collateralSymbol: 'USDC', sizeUsd: d(p.sizeUsd, 2), sizeTokens: d(p.sizeTokens, 8), collateral: d(p.collateral, 6), entryPrice: d(p.entry, 2),
        markPrice: d(mark, 2), pnlUsd: d(pnl, 4), leverage: d(lv, 2), liquidationPrice: d(p.side === 'long' ? p.entry * (1 - 1 / lv + 0.012) : p.entry * (1 + 1 / lv - 0.012), 2), increasedAt: p.increasedAt, source: 'chain', venueApi: { agrees: true, detail: null } }; });
    const pendingOrders = UNREADABLE ? [] : OPS.filter((o) => o.state === 'created').map((o) => ({ key: o.orderKey!, market: o.market!, marketName: mkt(o.market)!.name, orderType: o.kind === 'increase' ? 'MarketIncrease' : 'MarketDecrease', side: o.side!, sizeUsd: d(o.sizeUsd!, 2),
      collateral: d(o.collateral ?? 0, 6), acceptablePrice: d(o.acceptable!, 2), executionFeeEth: d(EXEC_FEE, 8), updatedAt: Math.floor(o.orderCreatedAt! / 1000), cancellableAt: Math.floor(o.cancellableAt! / 1000), frozen: false, opId: o.id }));
    return { venue: 'gmx', network: 'arbitrum', chainId: 42161, settings: { liveMainnet: LIVE_MAINNET, gmxLive: GMX_LIVE }, tradable: b.length === 0, blockers: b,
      blockerText: Object.fromEntries(b.map((c) => [c, BLOCKER_TEXT[c]![fr ? 0 : 1]])),
      pins: { id: PINS_OK === false ? 'gmx-v2-arbitrum-mock-1' : 'gmx-v2-arbitrum-mock-1', reviewedAt: '2026-11-10', ok: PINS_OK, checkedAt: t - 20_000, problems: PINS_OK === false ? ['ExchangeRouter: the address published by GMX differs from the reviewed one'] : [], contracts: CONTRACTS },
      account: { address: ACCOUNT, explorer: `${EX}/address/${ACCOUNT}` },
      wallet: UNREADABLE ? null : { usdc: d(WUSDC, 6), eth: d(WETH_, 8), weth: '0', limits: { perTransfer: String(PER_TX), perDay: String(PER_DAY), spentToday: d(SPENT, 2), maxNow: d(Math.max(0, Math.min(PER_TX, room, WUSDC)), 6) }, feeCeilingEth: String(FEE_CEIL) },
      walletError: UNREADABLE ? 'arbitrum: eth_call timed out after 8000 ms' : null,
      authorization: AUTH ? { id: AUTH.id, state: authState(AUTH), policy: AUTH.policy, createdAt: AUTH.createdAt, expiresAt: AUTH.expiresAt, today: { increases: AUTH.increases, reduces: AUTH.reduces } } : null,
      markets: MARKETS.map((m) => { const mark = markOf(m); return { market: m.market, name: m.name, instrument: m.instrument, base: m.base, indexDecimals: m.indexDecimals, collateral: [USDC],
        allowed: !!AUTH && authState(AUTH) === 'active' && AUTH.policy.allowedMarkets.some((x) => x.toLowerCase() === m.market.toLowerCase()), mark: d(mark, 2), oracleMin: d(mark * 0.9999, 2), oracleMax: d(mark * 1.0001, 2) }; }),
      positions, positionsSource: 'chain', positionsError: UNREADABLE ? 'arbitrum: eth_call timed out after 8000 ms' : null, pendingOrders,
      operations: [...OPS].reverse().slice(0, 20).map(view), facts: { requestExpirationSec: 300, executionGas: '2000000', twoStep: true }, ts: t };
  }
  function makeAuth(p: { allowedMarkets: string[]; maxLeverage: number; maxOrderSizeUsd: string; maxOrdersPerDay: number; maxPriceDeviationBps: number }, days: number, ackSha256: string): { raw: Record<string, unknown>; hash: string; auth: Auth } {
    const t = Math.floor(now() / 1000), id = crypto.randomUUID(), policy = { ...p, maxExecutionFeeWei: String(Math.round(FEE_CEIL * 1e18)) };
    const raw = { v: 1, authorizationId: id, keyId: 'spw-mock0000000000', venue: 'gmx', network: 'arbitrum', chainId: 42161, account: ACCOUNT, pins: 'gmx-v2-arbitrum-mock-1', policy, createdAt: t, expiresAt: t + days * 86_400, ackSha256 };
    return { raw, hash: rnd(32), auth: { id, raw, policy, createdAt: t * 1000, expiresAt: t + days * 86_400, revoked: false, stale: false, hash: '', increases: 0, reduces: 0 } };
  }

  function handle(method: string, rest: string, b: any, headers: Headers, q?: URLSearchParams): unknown {
    const key = headers.get('idempotency-key');
    for (const o of OPS) advance(o);
    if (rest === '/status' && method === 'GET') return status(q?.get('locale') ?? 'fr');
    if (rest === '/jurisdiction' && method === 'GET') return { venue: 'gmx', fr: { venue: 'gmx', locale: 'fr', text: ACK.fr, sha256: 'a1'.repeat(32), version: 'mock-2026-11-11', source: 'mock' }, en: { venue: 'gmx', locale: 'en', text: ACK.en, sha256: 'b2'.repeat(32), version: 'mock-2026-11-11', source: 'mock' } };
    if (method !== 'POST' && !rest.startsWith('/operations/')) throw new Refuse('not_found', 'no such GMX route', 404);
    if (rest === '/authorization/prepare') {
      gate();
      const ok = Array.isArray(b?.allowedMarkets) && b.allowedMarkets.length > 0 && b.allowedMarkets.every((m: unknown) => !!mkt(m)) && Number.isInteger(b.maxLeverage) && b.maxLeverage >= 1 && b.maxLeverage <= 20 && isDec(b.maxOrderSizeUsd) && Number(b.maxOrderSizeUsd) > 0
        && Number.isInteger(b.maxOrdersPerDay) && b.maxOrdersPerDay >= 1 && b.maxOrdersPerDay <= 100 && Number.isInteger(b.maxPriceDeviationBps) && b.maxPriceDeviationBps >= 10 && b.maxPriceDeviationBps <= 1000 && Number.isInteger(b.days) && b.days >= 1 && b.days <= 90 && (b.locale === 'fr' || b.locale === 'en');
      if (!ok) throw new Refuse('bad_request', 'invalid policy: leverage 1–20, orders per day 1–100, price band 10–1000 bps, 1–90 days, pinned markets only', 400);
      const loc = b.locale as 'fr' | 'en', ack = { venue: 'gmx', locale: loc, text: ACK[loc], sha256: (loc === 'fr' ? 'a1' : 'b2').repeat(32), version: 'mock-2026-11-11', source: 'mock' };
      PREPARED = makeAuth({ allowedMarkets: b.allowedMarkets.map((m: string) => mkt(m)!.market), maxLeverage: b.maxLeverage, maxOrderSizeUsd: b.maxOrderSizeUsd, maxOrdersPerDay: b.maxOrdersPerDay, maxPriceDeviationBps: b.maxPriceDeviationBps }, b.days, ack.sha256);
      return { authorization: PREPARED.raw, hash: PREPARED.hash, ack, options: options(PREPARED.hash), maxExecutionFeeEth: String(FEE_CEIL) };
    }
    if (rest === '/authorization/approve') {
      gate();
      if (!PREPARED || JSON.stringify(b?.authorization) !== JSON.stringify(PREPARED.raw)) throw new Refuse('bad_state', 'this authorization was not prepared here, or another one was prepared since', 409);
      if (!approves(b?.assertion, PREPARED.hash)) throw new Refuse('signer_bad_approval', 'the passkey assertion does not approve this authorization (challenge mismatch)', 422);
      AUTH = PREPARED.auth; PREPARED = null;
      return status(String(AUTH.raw.locale ?? q?.get('locale') ?? 'fr'));
    }
    if (rest === '/authorization/revoke') { if (AUTH) AUTH.revoked = true; return status(q?.get('locale') ?? 'fr'); }
    if (rest === '/orders/preview') { const r = resolve(b);
      return { order: { market: r.m.market, marketName: r.m.name, side: r.side, action: r.action, collateral: r.collateral === null ? null : d(r.collateral, 6), sizeUsd: d(r.sizeUsd, 2), acceptablePrice: r.estimate.acceptablePrice, slippageBps: r.bps, leverage: r.leverage === null ? null : d(r.leverage, 2) },
        estimate: r.estimate, risk: r.risk, blockers: blockers(), signerWould: r.signerWould }; }
    if (rest === '/orders') return order(b, key);
    if (rest === '/positions/close') {
      const m = mkt(b?.market), p = POS.find((x) => x.market === m?.market && x.side === b?.side), fr = b?.fraction === undefined ? 1 : Number(b.fraction);
      if (!m || !(fr > 0 && fr <= 1)) throw new Refuse('bad_request', 'invalid request', 400);
      if (!key) throw new Refuse('idempotency', 'an Idempotency-Key header is required', 400);
      if (!p && !BY_KEY.has(key)) { gate(); needAuth(); throw new Refuse('risk_no_position', `no ${b.side} position on ${m.name}`, 422); }
      return order({ market: m.market, side: b.side, action: 'decrease', sizeUsd: d((p?.sizeUsd ?? 0) * fr, 2), ...(b.slippageBps !== undefined ? { slippageBps: b.slippageBps } : {}) }, key);
    }
    let x = /^\/orders\/([0-9a-f-]{36})\/cancel$/.exec(rest);
    if (x) {
      gate(); needAuth();
      const target = find(x[1]!);
      if (target.kind === 'cancel' || target.state !== 'created') throw new Refuse('bad_state', `the operation is ${target.state}: there is no pending order to cancel`, 409);
      if (now() < target.cancellableAt!) throw new Refuse('not_yet_cancellable', `a pending market order can be cancelled by its owner ${300} s after its creation (mock: ${CANCEL_MS} ms); ${Math.ceil((target.cancellableAt! - now()) / 1000)} s left`, 409);
      return prepared(newOp(null, { kind: 'cancel', market: target.market, side: target.side, targetOpId: target.id }));
    }
    x = /^\/operations\/([0-9a-f-]{36})(\/approve|\/withdraw)?$/.exec(rest);
    if (x) {
      const o = find(x[1]!);
      if (!x[2]) { if (method !== 'GET') throw new Refuse('not_found', 'no such GMX route', 404); return { operation: view(o) }; }
      if (x[2] === '/withdraw') { if (o.state !== 'pending_approval') throw new Refuse('bad_state', `the operation is ${o.state}: it can no longer be withdrawn`, 409); o.state = 'withdrawn'; o.final = true; o.error = 'withdrawn before approval; nothing was signed'; return { operation: view(o) }; }
      gate(); const a = needAuth();
      if (o.state !== 'pending_approval') throw new Refuse(o.state === 'expired' ? 'expired' : 'bad_state', `the operation is ${o.state}`, o.state === 'expired' ? 410 : 409);
      if (!approves(b?.assertion, o.hash)) { o.state = 'failed'; o.final = true; o.error = 'the signer refused: the passkey assertion does not approve this intent. Nothing was signed or sent.'; throw new Refuse('signer_bad_approval', 'the passkey assertion does not approve this intent (challenge mismatch)', 422); }
      o.approvedAt = now(); if (o.kind === 'increase') a.increases++; else if (o.kind === 'decrease') a.reduces++;
      advance(o);
      return { operation: view(o) };
    }
    throw new Refuse('not_found', 'no such GMX route', 404);
  }

  const authorize = () => { AUTH = makeAuth({ allowedMarkets: MARKETS.map((m) => m.market), maxLeverage: 5, maxOrderSizeUsd: '250', maxOrdersPerDay: 10, maxPriceDeviationBps: 100 }, 30, 'a1'.repeat(32)).auth; };
  const hooks: GmxHooks = {
    scenario(s) {
      LIVE_MAINNET = s !== 'off' && s !== 'mainnet-off'; GMX_LIVE = s !== 'off'; PINS_OK = true; HALTED = false; UNREADABLE = false; KEEPER = 'execute'; AUTH = null;
      if (s === 'off' || s === 'mainnet-off' || s === 'on') return;
      authorize();
      if (s === 'position') { const m = MARKETS[0], mark = markOf(m), entry = mark * 0.992; POS.length = 0; POS.push({ key: `0x${rnd(32)}`, market: m.market, side: 'long', sizeUsd: 120, sizeTokens: 120 / entry, collateral: 39.93, entry, increasedAt: Math.floor(now() / 1000) - 5400 }); }
      if (s === 'keeper-cancel') KEEPER = 'cancel';
      if (s === 'pending') KEEPER = 'never';
      if (s === 'contracts') { PINS_OK = false; AUTH!.stale = true; }
      if (s === 'halted') HALTED = true;
      if (s === 'unreadable') UNREADABLE = true;
      if (s === 'expired') AUTH!.expiresAt = Math.floor(now() / 1000) - 60;
    },
    settings: (liveMainnet, gmxLive) => { LIVE_MAINNET = liveMainnet; GMX_LIVE = gmxLive; },
    keeper: (mode) => { KEEPER = mode; },
    delays: (x) => { if (x.keeperMs !== undefined) KEEPER_MS = x.keeperMs; if (x.cancelMs !== undefined) CANCEL_MS = x.cancelMs; if (x.ttlMs !== undefined) TTL_MS = x.ttlMs; },
    signerRefuses: () => { REFUSE_NEXT = true; },
    state: () => { for (const o of OPS) advance(o); const b = blockers(); return { tradable: b.length === 0, blockers: b, operations: OPS.map((o) => ({ id: o.id, kind: o.kind, state: o.state })), positions: POS.length, usdc: d(WUSDC, 6) }; },
  };
  return {
    hooks,
    route(method: string, path: string, b: any, headers: Headers, q?: URLSearchParams): Out {
      try { return { status: 200, json: handle(method, path.slice('/derivatives/gmx'.length), b, headers, q) }; }
      catch (e) { if (e instanceof Refuse) return { status: e.status, json: { error: e.code, message: e.message } }; throw e; }
    },
  };
}
