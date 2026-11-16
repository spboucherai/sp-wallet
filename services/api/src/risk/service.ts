// The risk service (V11): the server-side home of the independent risk engine of @spw/trading. It assembles the context
// (`TradingRiskContext`) from what the wallet can read itself — never from what a caller says —, holds the owner's limits, the
// global kill switch and read-only mode, runs `evaluate()` and stores every evaluation in `risk_decisions`.
//
// Books. Paper and live are separate worlds: a context is built for ONE book — `paper`, `live-mainnet` (Hyperliquid mainnet
// accounts + GMX) or `live-testnet` — and never contains a position, a balance or a PnL figure of another one.
//
// One account per venue. The engine reads one account per venue and instrument. When the wallet has several accounts on a venue,
// the order's own account is presented under the venue's name and each sibling under `<venue>@<account id prefix>`: gross, net
// and per-asset exposure and the account leverage count every account; the per-venue exposure and the collateral-share limits
// then apply to the order's own account.
//
// Kill switch: blocks every order that is not strictly reducing, for every principal, on every venue, in every mode. It never
// blocks a cancel or a strictly reducing order. Read-only mode: only cancels pass. Engaging is free; releasing needs the passkey.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { D, type AccountState, type Book, type DecStr, type Instrument, type Position, type Ticker } from '@spw/derivatives';
import { canonicalOrder, evaluateRisk, RiskLimitsSchema, type CanonicalOrder, type CanonicalOrderInput, type RiskEvaluation, type RiskLimits, type TradingRiskContext } from '@spw/trading';
import { UserError } from '../config.ts';
import { audit, getSetting, setSetting, sql } from '../db.ts';
import type { Derivatives } from '../derivatives/index.ts';
import type { LiveService } from '../derivatives/exec.ts';
import type { NewRiskBlock, PreTradeGate, PreTradeRequest } from '../derivatives/gate.ts';
import type { GmxService } from '../derivatives/gmx-exec.ts';
import { defaultLimits, effectiveLimits, loosenedLimits, type RiskMode } from './limits.ts';
import { prepareIntent, takeIntent, type PasskeyDeps } from './passkey.ts';

export type BookKey = 'paper' | 'live-mainnet' | 'live-testnet';
export const bookOf = (mode: string, network: string): BookKey => (mode === 'paper' ? 'paper' : network === 'testnet' ? 'live-testnet' : 'live-mainnet');
export interface Actor { kind: 'owner' | 'api_key' | 'agent' | 'system'; id: string }
export interface Switch { on: boolean; at: number | null; by: Actor | null; reason: string | null }
export interface Switches { killSwitch: Switch; readOnly: Switch }
const OFF: Switch = { on: false, at: null, by: null, reason: null };
const SWITCHES_KEY = 'risk.switches', limitsKey = (m: RiskMode) => `risk.limits.${m}`, peakKey = (b: BookKey) => `risk.peak.${b}`, AUTO_KEY = 'risk.auto';
export const AutoKillSchema = z.strictObject({ totalLoss: z.boolean().default(true), drawdown: z.boolean().default(true), dailyLoss: z.boolean().default(false) });
export type AutoKill = z.infer<typeof AutoKillSchema>;

export interface RiskDeps extends PasskeyDeps {
  derivatives: () => Derivatives; live: () => LiveService;
  /** GMX positions are read from the chain through the GMX service; null = this server has no GMX service */
  gmx: () => Pick<GmxService, 'status'> | null;
  prices?: () => Promise<Record<string, { usd: number; priceAt?: string | null }> | null>;
  /** throws when the signer cannot be reached */
  signerStatus: () => Promise<{ halted: boolean }>;
  emit?: (event: 'risk.kill_switch', data: Record<string, unknown>) => Promise<unknown>;
  alert?: (kind: string, params: Record<string, string | number | boolean | null>, dedupe: string) => Promise<unknown>;
}

export interface ServiceCheck { id: string; ok: boolean; observed: string | null; limit: string | null; detail: string; exempt: boolean }
export interface Evaluated {
  decision: 'allow' | 'deny'; reducing: boolean; checks: ServiceCheck[]; failed: string[]; derived: RiskEvaluation['derived'];
  /** the refusal as a stable code, with the sentence of the first failing check; null when allowed */
  code: 'risk_denied' | 'kill_switch_active' | 'read_only_mode' | null; reason: string | null; decisionId: number;
  market: { instrument: Instrument | null; ticker: Ticker | null; book: Book | null; hasBook: boolean }; leverage: DecStr | null; equity: DecStr; book: BookKey;
  /** the accounts of the book as the context saw them (the order's own account carries the venue's name) */
  accounts: { accountId: string; venue: string; equity: DecStr; marginUsed: DecStr; freeCollateral: DecStr }[];
}
interface BookView { accounts: { venue: string; label: string; accountId: string; state: AccountState | null }[]; positions: { venue: string; label: string; accountId: string; asset: string; position: Position }[]; errors: string[]; gmxRealized: { today: DecStr; total: DecStr } }
type Known = PreTradeRequest['known'];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const dayStart = (now: number): number => Math.floor(now / 86_400_000) * 86_400_000;
/** the asset of an instrument id under one normalization for every venue: `hyperliquid:BTC` and `gmx:BTC/USD [BTC-USDC]` are both BTC */
export const assetOf = (instrument: string): string => (instrument.slice(instrument.indexOf(':') + 1).split(/[-/ ]/)[0] ?? '').toUpperCase() || instrument;
const sumDec = (xs: DecStr[]): DecStr => D.str(xs.reduce((a, x) => D.add(a, D.from(x)), D.zero));

export class RiskService {
  readonly deps: RiskDeps;
  readonly now: () => number;
  constructor(deps: RiskDeps) { this.deps = deps; this.now = deps.now; }

  // ------------------------------------------------------------------ switches
  async switches(): Promise<Switches> {
    const s = await getSetting<Partial<Switches> | null>(SWITCHES_KEY, null);
    return { killSwitch: { ...OFF, ...(s?.killSwitch ?? {}) }, readOnly: { ...OFF, ...(s?.readOnly ?? {}) } };
  }
  /** for the engines, at approval time: why new risk is blocked now, or null */
  newRiskBlock: NewRiskBlock = async () => {
    const s = await this.switches();
    if (s.readOnly.on) return { code: 'read_only_mode', reason: `read-only mode is on${s.readOnly.reason ? ` (${s.readOnly.reason})` : ''}: only cancels are permitted` };
    if (s.killSwitch.on) return { code: 'kill_switch_active', reason: `the kill switch is on${s.killSwitch.reason ? ` (${s.killSwitch.reason})` : ''}: no new risk; cancels and reduce-only exits still pass` };
    return null;
  };
  private async notifySwitch(kind: 'kill_switch' | 'read_only', on: boolean, by: Actor, reason: string): Promise<void> {
    const by2 = `${by.kind}:${by.id}`;
    await audit(`risk.${kind}`, by.kind === 'owner' ? 'owner' : by2, { engaged: on, by: by2, reason }).catch((e: Error) => console.error(`[risk] audit failed: ${e.message}`));
    if (kind === 'kill_switch') {
      await this.deps.emit?.('risk.kill_switch', { source: 'risk_engine', engaged: on, by: by2, reason }).catch(() => {});
      await this.deps.alert?.(on ? 'risk.kill_switch_on' : 'risk.kill_switch_off', { what: by2, state: reason.slice(0, 120) }, `risk.kill_switch:${on ? 'on' : 'off'}:${this.now()}`).catch(() => {});
    }
  }
  /** engaging is free: the owner's session, an API key holding `positions:manage`, or the supervisor on a declared stop condition */
  async engageKillSwitch(by: Actor, reason = ''): Promise<Switches> {
    const s = await this.switches();
    if (s.killSwitch.on) return s;
    const next: Switches = { ...s, killSwitch: { on: true, at: this.now(), by, reason: reason.slice(0, 200) || null } };
    await setSetting(SWITCHES_KEY, next);
    await this.notifySwitch('kill_switch', true, by, reason.slice(0, 200));
    return next;
  }
  async engageReadOnly(by: Actor, reason = ''): Promise<Switches> {
    const s = await this.switches();
    if (s.readOnly.on) return s;
    const next: Switches = { ...s, readOnly: { on: true, at: this.now(), by, reason: reason.slice(0, 200) || null } };
    await setSetting(SWITCHES_KEY, next);
    await this.notifySwitch('read_only', true, by, reason.slice(0, 200));
    return next;
  }
  /** releasing needs the owner's passkey over the intent that names the very switch being released (step 1) */
  async prepareRelease(kind: 'kill_switch' | 'read_only') {
    const s = await this.switches(), cur = kind === 'kill_switch' ? s.killSwitch : s.readOnly;
    if (!cur.on) return { needed: false as const, kind, intent: null, hash: null, options: null, expiresAt: null };
    const p = await prepareIntent(this.deps, 'SPW-RISK-SWITCH-INTENT-v1', `risk.intent.release.${kind}`, { v: 1, kind, engagedAt: cur.at, engagedBy: cur.by ? `${cur.by.kind}:${cur.by.id}` : null, reason: cur.reason });
    return { needed: true as const, kind, ...p };
  }
  /** step 2: only with the passkey; a switch re-engaged since the preparation is not the one that was approved */
  async release(kind: 'kill_switch' | 'read_only', assertion: unknown): Promise<Switches> {
    const s = await this.switches(), cur = kind === 'kill_switch' ? s.killSwitch : s.readOnly;
    if (!cur.on) return s;
    const i = await takeIntent<{ v: 1; kind: string; engagedAt: number | null }>(this.deps, 'SPW-RISK-SWITCH-INTENT-v1', `risk.intent.release.${kind}`, assertion, 'risk.release_refused');
    if (i.kind !== kind || i.engagedAt !== cur.at) throw new UserError('bad_state', 'the switch changed since its release was prepared: prepare it again', 409);
    const next: Switches = kind === 'kill_switch' ? { ...s, killSwitch: OFF } : { ...s, readOnly: OFF };
    await setSetting(SWITCHES_KEY, next);
    await this.notifySwitch(kind, false, { kind: 'owner', id: 'owner' }, 'released with the passkey');
    return next;
  }

  // ------------------------------------------------------------------ limits
  async storedLimits(mode: RiskMode): Promise<RiskLimits> { return RiskLimitsSchema.parse(await getSetting<RiskLimits>(limitsKey(mode), {})); }
  async limits(mode: RiskMode) {
    const stored = await this.storedLimits(mode);
    return { mode, stored, defaults: defaultLimits(mode), effective: { ...defaultLimits(mode), ...stored },
      missing: mode === 'live' ? (['allowedVenues', 'allowedInstruments', 'maxOrderNotional', 'maxDailyNotional', 'maxPositionNotional', 'maxOrderLeverage', 'maxAccountLeverage', 'maxGrossExposure', 'maxNetExposure',
        'maxAssetExposure', 'maxVenueExposure', 'maxVenueCollateralShareBps', 'maxDailyLoss', 'maxTotalLoss', 'maxDrawdownBps'] as const).filter((k) => stored[k] === undefined) : [] };
  }
  private async writeLimits(mode: RiskMode, next: RiskLimits, loosened: string[], passkey: boolean) {
    await setSetting(limitsKey(mode), next);
    await audit('risk.limits_replaced', 'owner', { mode, loosened, passkey, limits: next }).catch(() => {});
    return this.limits(mode);
  }
  /** tightening is free; a change that loosens anything is refused here with `passkey_required` (prepareLimits → approveLimits) */
  async setLimits(mode: RiskMode, raw: unknown) {
    const next = RiskLimitsSchema.parse(raw), loosened = loosenedLimits(mode, await this.storedLimits(mode), next);
    if (loosened.length) throw new UserError('passkey_required', `this change loosens ${loosened.join(', ')}: it needs the owner's passkey (prepare it, then approve). Tightening needs none.`, 403);
    return this.writeLimits(mode, next, [], false);
  }
  async prepareLimits(mode: RiskMode, raw: unknown) {
    const next = RiskLimitsSchema.parse(raw), loosened = loosenedLimits(mode, await this.storedLimits(mode), next);
    if (!loosened.length) return { needed: false as const, loosened, intent: null, hash: null, options: null, expiresAt: null };
    const p = await prepareIntent(this.deps, 'SPW-RISK-LIMITS-INTENT-v1', `risk.intent.limits.${mode}`, { v: 1, kind: 'limits', mode, limits: next, loosened });
    await audit('risk.limits_change_prepared', 'owner', { mode, hash: p.hash, loosened }).catch(() => {});
    return { needed: true as const, loosened, ...p };
  }
  /** exactly the limits that were prepared are written, once */
  async approveLimits(mode: RiskMode, assertion: unknown) {
    const i = await takeIntent<{ mode: RiskMode; limits: RiskLimits; loosened: string[] }>(this.deps, 'SPW-RISK-LIMITS-INTENT-v1', `risk.intent.limits.${mode}`, assertion, 'risk.limits_change_refused');
    if (i.mode !== mode) throw new UserError('bad_state', 'the prepared change is for the other mode', 409);
    return this.writeLimits(mode, RiskLimitsSchema.parse(i.limits), i.loosened, true);
  }
  async autoKill(): Promise<AutoKill> { return AutoKillSchema.parse(await getSetting(AUTO_KEY, {})); }
  /** switching an automatic stop OFF is a loosening */
  async setAutoKill(raw: unknown, assertion?: unknown): Promise<AutoKill> {
    const next = AutoKillSchema.parse(raw), cur = await this.autoKill();
    const loosened = (Object.keys(next) as (keyof AutoKill)[]).filter((k) => cur[k] && !next[k]);
    if (loosened.length) {
      const i = await takeIntent<{ auto: AutoKill }>(this.deps, 'SPW-RISK-AUTO-INTENT-v1', 'risk.intent.auto', assertion, 'risk.auto_change_refused');
      if (JSON.stringify(AutoKillSchema.parse(i.auto)) !== JSON.stringify(next)) throw new UserError('bad_state', 'the prepared change is not this one', 409);
    }
    await setSetting(AUTO_KEY, next);
    await audit('risk.auto_replaced', 'owner', { auto: next, loosened }).catch(() => {});
    return next;
  }
  async prepareAutoKill(raw: unknown) {
    const next = AutoKillSchema.parse(raw), cur = await this.autoKill();
    const loosened = (Object.keys(next) as (keyof AutoKill)[]).filter((k) => cur[k] && !next[k]);
    if (!loosened.length) return { needed: false as const, loosened, intent: null, hash: null, options: null, expiresAt: null };
    return { needed: true as const, loosened, ...(await prepareIntent(this.deps, 'SPW-RISK-AUTO-INTENT-v1', 'risk.intent.auto', { v: 1, kind: 'auto', auto: next, loosened })) };
  }

  // ------------------------------------------------------------------ context
  private async readBook(book: BookKey): Promise<BookView> {
    const out: BookView = { accounts: [], positions: [], errors: [], gmxRealized: { today: '0', total: '0' } };
    if (book === 'paper') {
      for (const a of await this.deps.derivatives().paper.list()) {
        out.accounts.push({ venue: a.venue, label: a.venue, accountId: a.id, state: a.state });
        for (const p of a.positions) out.positions.push({ venue: a.venue, label: a.venue, accountId: a.id, asset: assetOf(p.instrument), position: p });
      }
      return out;
    }
    const live = this.deps.live(), testnet = book === 'live-testnet';
    let list: Awaited<ReturnType<LiveService['list']>> = [];
    try { list = await live.list(); } catch (e) { out.errors.push(`live accounts: ${msg(e)}`); }
    for (const a of list) {
      if ((a.network === 'testnet') !== testnet || !a.authorization) continue;         // a venue account that was never authorized is not under this wallet's control
      try {
        const s = await live.mandateAccountState(a.id);
        if (s.error) out.errors.push(`${a.venue} ${a.id}: ${s.error}`);
        out.accounts.push({ venue: a.venue, label: a.venue, accountId: a.id, state: s.state });
        for (const p of s.positions) out.positions.push({ venue: a.venue, label: a.venue, accountId: a.id, asset: assetOf(p.instrument), position: p });
      } catch (e) { out.errors.push(`${a.venue} ${a.id}: ${msg(e)}`); }
    }
    if (!testnet) {
      const gmx = this.deps.gmx();
      const [used] = await sql`select 1 as x from deriv_gmx_ops limit 1`;
      if (gmx && used) {
        try {
          const s = await gmx.status();
          if (s.positionsError) out.errors.push(`gmx: ${s.positionsError}`);
          const accountId = s.account?.address ?? 'gmx-wallet';
          let equity = D.zero;
          for (const x of s.positions as unknown as Record<string, string | null>[]) {
            const position: Position = { instrument: String(x.instrument), side: x.side === 'short' ? 'short' : 'long', size: String(x.sizeTokens ?? '0'), entryPrice: String(x.entryPrice ?? '0'), markPrice: String(x.markPrice ?? x.entryPrice ?? '0'),
              liquidationPrice: x.liquidationPrice ?? null, leverage: String(x.leverage ?? '1'), marginMode: 'isolated', margin: String(x.collateral ?? '0'), unrealizedPnl: String(x.pnlUsd ?? '0'), realizedPnl: null, fundingPaid: null, source: 'venue' };
            out.positions.push({ venue: 'gmx', label: 'gmx', accountId, asset: assetOf(position.instrument), position });
            equity = D.add(equity, D.add(D.from(position.margin), D.from(position.unrealizedPnl)));
          }
          const eq = D.str(equity);
          out.accounts.push({ venue: 'gmx', label: 'gmx', accountId, state: { venue: 'gmx', account: accountId, equity: eq, collateral: eq, freeCollateral: '0', marginUsed: eq, maintenanceMargin: null, withdrawable: null, ts: this.now(), source: 'venue' } });
          const rows = await sql<{ pnl: string | null; fee: string | null; done_at: Date | null }[]>`select outcome->>'pnlUsd' as pnl, outcome->>'positionFeeUsd' as fee, done_at from deriv_gmx_ops where state = 'executed' and kind <> 'cancel' and outcome is not null`;
          const day = new Date(dayStart(this.now()));
          let today = D.zero, total = D.zero;
          for (const r of rows) { try { const v = D.sub(D.from(r.pnl ?? '0'), D.from(r.fee ?? '0')); total = D.add(total, v); if (r.done_at && r.done_at >= day) today = D.add(today, v); } catch { /* an outcome without figures */ } }
          out.gmxRealized = { today: D.str(today), total: D.str(total) };
        } catch (e) { out.errors.push(`gmx: ${msg(e)}`); }
      }
    }
    return out;
  }

  /** instrument, ticker and book of an order's market, read now from the venue the order goes to */
  async market(mode: 'paper' | 'live', venue: string, network: string, instrumentId: string): Promise<{ instrument: Instrument | null; ticker: Ticker | null; book: Book | null; hasBook: boolean; error: string | null }> {
    let instrument: Instrument | null = null;
    try {
      if (mode === 'live' && venue === 'hyperliquid') {
        const v = this.deps.live().deps.venues.get(network);
        instrument = await v.instrument(instrumentId);
        const m = await v.market(instrument);
        return { instrument, ticker: m.ticker, book: m.book, hasBook: true, error: null };
      }
      const d = this.deps.derivatives().data;
      instrument = await d.instrument(instrumentId);
      const hasBook = d.hasBook(instrument);
      const [ticker, book] = await Promise.all([d.ticker(instrument, { within: 1_000 }), hasBook ? d.book(instrument, { within: 1_000 }) : Promise.resolve(null)]);
      return { instrument, ticker, book, hasBook, error: null };
    } catch (e) {
      const hasBook = instrument ? (venue === 'hyperliquid' ? true : (() => { try { return this.deps.derivatives().data.hasBook(instrument!); } catch { return true; } })()) : true;
      return { instrument, ticker: null, book: null, hasBook, error: msg(e) };
    }
  }

  private async pnl(ids: string[], view: BookView, now: number) {
    const day = new Date(dayStart(now));
    const [f] = ids.length ? await sql<{ today: string; total: string }[]>`select coalesce(sum(coalesce(closed_pnl, 0) - fee) filter (where ts >= ${day}), 0)::text as today, coalesce(sum(coalesce(closed_pnl, 0) - fee), 0)::text as total from deriv_fills where account_id::text = any(${ids})` : [{ today: '0', total: '0' }];
    const [g] = ids.length ? await sql<{ today: string; total: string }[]>`select coalesce(sum(amount) filter (where ts >= ${day}), 0)::text as today, coalesce(sum(amount), 0)::text as total from deriv_funding where account_id::text = any(${ids})` : [{ today: '0', total: '0' }];
    const unrealized = sumDec(view.positions.map((p) => p.position.unrealizedPnl));
    return { realizedToday: sumDec([f!.today, g!.today, view.gmxRealized.today]), unrealizedToday: unrealized, realizedInception: sumDec([f!.total, g!.total, view.gmxRealized.total]), unrealizedInception: unrealized };
  }
  private async usage(book: BookKey, now: number, exceptId: string | null) {
    const mode = book === 'paper' ? 'paper' : 'live', testnet = book === 'live-testnet';
    const [c] = await sql<{ minute: number; hour: number; today: number; notional: string }[]>`select count(*) filter (where created_at > ${new Date(now - 60_000)})::int as minute, count(*) filter (where created_at > ${new Date(now - 3_600_000)})::int as hour,
        count(*) filter (where created_at >= ${new Date(dayStart(now))})::int as today, coalesce(sum(notional_usd) filter (where created_at >= ${new Date(dayStart(now))}), 0)::text as notional
      from orders where mode = ${mode} and (${mode === 'paper'} or (network = 'testnet') = ${testnet}) and not reduce_only and state not in ('REJECTED', 'FAILED') and id <> ${exceptId ?? ''} and created_at > ${new Date(now - 86_400_000)}`;
    return { ordersLastMinute: c!.minute, ordersLastHour: c!.hour, ordersToday: c!.today, notionalToday: D.str(D.from(c!.notional)) };
  }
  private async peak(book: BookKey, current: DecStr): Promise<DecStr> {
    const stored = await getSetting<{ equity: DecStr } | null>(peakKey(book), null);
    if (stored && D.gte(D.from(stored.equity), D.from(current))) return stored.equity;
    if (D.isPos(D.from(current))) await setSetting(peakKey(book), { equity: current, at: this.now() });
    return current;
  }

  /** the context of one order, and what was read to build it */
  async context(order: CanonicalOrder, o: { accountId: string | null; orderId?: string | null; known?: Known; instrument?: Instrument } = { accountId: null }) {
    const now = this.now(), mode: 'paper' | 'live' = order.mode === 'live' ? 'live' : 'paper', book = bookOf(mode, order.network);
    const [sw, view, signerSt] = await Promise.all([this.switches(), this.readBook(book), this.deps.signerStatus().then((s) => ({ reachable: true, halted: s.halted }), () => ({ reachable: false, halted: false }))]);
    const m = o.known ? { instrument: o.instrument ?? null, ticker: o.known.ticker, book: o.known.book, hasBook: o.known.book !== null || order.venue === 'hyperliquid', error: null as string | null }
      : await this.market(mode, order.venue, order.network, order.instrument);
    const inst = m.instrument ?? o.instrument ?? null;
    // the order's own account is the venue's account for the engine; siblings on the same venue are separate labels (see the header)
    const own = o.accountId ?? view.accounts.find((a) => a.venue === order.venue)?.accountId ?? null;
    const label = (venue: string, accountId: string): string => (venue === order.venue && accountId !== own ? `${venue}@${accountId.slice(0, 8)}` : venue);
    let accounts = view.accounts.map((a) => ({ ...a, label: label(a.venue, a.accountId) })), positions = view.positions.map((p) => ({ ...p, label: label(p.venue, p.accountId) }));
    if (o.known && own) {                                                 // what the engine has just read replaces the book's copy of that account
      if (o.known.account) accounts = [...accounts.filter((a) => a.accountId !== own), { venue: order.venue, label: order.venue, accountId: own, state: o.known.account }];
      if (o.known.positions) positions = [...positions.filter((p) => p.accountId !== own), ...o.known.positions.map((position) => ({ venue: order.venue, label: order.venue, accountId: own, asset: assetOf(position.instrument), position }))];
    }
    const readable = accounts.filter((a) => a.state !== null), equity = sumDec(readable.map((a) => a.state!.equity));
    const marks: TradingRiskContext['marks'] = [];
    if (m.ticker) {
      marks.push({ instrument: order.instrument, source: 'mark', price: m.ticker.mark, ts: m.ticker.ts });
      if (m.ticker.index !== null) marks.push({ instrument: order.instrument, source: 'index', price: m.ticker.index, ts: m.ticker.ts });
    }
    // one reference that does not come from the venue: the wallet's spot price list, with the time ITS source gives
    const px = inst && this.deps.prices ? await this.deps.prices().then((p) => p?.[inst.base.toUpperCase()] ?? null, () => null) : null;
    if (px && Number.isFinite(px.usd) && px.usd > 0 && px.priceAt) { const ts = Date.parse(px.priceAt); if (Number.isFinite(ts)) marks.push({ instrument: order.instrument, source: 'coingecko', price: D.str(D.from(String(px.usd))), ts }); }
    let leverageSetting: DecStr | null = o.known?.leverage ?? null;
    if (leverageSetting === null && inst && own && order.marketKind === 'perp') leverageSetting = await this.leverageOf(mode, order, own, inst).catch(() => null);
    const ownAccount = accounts.find((a) => a.accountId === own);
    const ctx: TradingRiskContext = {
      now, killSwitch: sw.killSwitch.on, readOnly: sw.readOnly.on,
      instrument: inst ? { venue: inst.venue, symbol: inst.symbol, id: inst.id, base: inst.base, quote: inst.quote, kind: 'perpetual', tickSize: inst.tickSize, lotSize: inst.lotSize, maxLeverage: inst.maxLeverage, status: inst.status } : null,
      asset: inst ? inst.base.toUpperCase() : null,
      positions: positions.map((p) => ({ venue: p.label, account: p.accountId, asset: p.asset, position: p.position })),
      accounts: readable.map((a) => ({ venue: a.label, account: a.accountId, equity: a.state!.equity, collateral: a.state!.collateral, freeCollateral: a.state!.freeCollateral, marginUsed: a.state!.marginUsed, ts: a.state!.ts })),
      marks, book: m.book, pnl: await this.pnl(accounts.map((a) => a.accountId), view, now), equity: { current: equity, peak: await this.peak(book, equity) },
      signer: signerSt, connections: { [order.venue]: { connected: m.ticker !== null } }, usage: await this.usage(book, now, o.orderId ?? null),
      ...(leverageSetting !== null ? { leverageSetting } : {}),
      ...(o.known?.maintenanceMarginFraction !== undefined ? { maintenanceMarginFraction: o.known.maintenanceMarginFraction } : {}),
    };
    const incomplete = [...view.errors, ...(ownAccount && ownAccount.state === null ? [`the account ${own} could not be read`] : []), ...(own === null && order.marketKind === 'perp' ? ['no account of the wallet on this venue'] : [])];
    return { ctx, book, market: { instrument: inst, ticker: m.ticker, book: m.book, hasBook: m.hasBook }, marketError: m.error, incomplete, leverage: leverageSetting, equity };
  }

  private async leverageOf(mode: 'paper' | 'live', order: CanonicalOrder, accountId: string, inst: Instrument): Promise<DecStr | null> {
    if (mode === 'paper') {
      const a = (await this.deps.derivatives().paper.list()).find((x) => x.id === accountId);
      if (!a) return null;
      return a.settings.leverageByInstrument[inst.id] ?? D.str(D.min(D.from(a.settings.leverage), D.from(inst.maxLeverage)));
    }
    if (order.venue !== 'hyperliquid') return null;
    const [row] = await sql<{ account: string }[]>`select account from deriv_accounts where id::text = ${accountId}`;
    return row ? (await this.deps.live().deps.venues.get(order.network).leverageOf(row.account, inst.symbol)).leverage : null;
  }

  // ------------------------------------------------------------------ evaluation
  private async record(e: Omit<Evaluated, 'decisionId'>, r: { kind: 'order' | 'cancel'; preview: boolean; orderId: string | null; clientOrderId: string | null; principal: { kind: string; id: string }; mode: string; venue: string; instrument: string | null; limits: unknown; context: unknown }): Promise<number> {
    const [row] = await sql<{ id: string }[]>`insert into risk_decisions (at, order_id, client_order_id, kind, preview, principal_kind, principal_id, mode, venue, instrument, decision, reducing, failed, checks, derived, limits, context)
      values (${new Date(this.now())}, ${r.orderId}, ${r.clientOrderId}, ${r.kind}, ${r.preview}, ${r.principal.kind}, ${r.principal.id}, ${r.mode}, ${r.venue}, ${r.instrument}, ${e.decision}, ${e.reducing}, ${e.failed},
        ${sql.json(e.checks as never)}, ${sql.json(e.derived as never)}, ${sql.json(r.limits as never)}, ${sql.json(r.context as never)}) returning id`;
    return Number(row!.id);
  }

  /** every order of every principal passes here before any approval prompt or signature. The evaluation is stored, allowed or denied. */
  async evaluateOrder(input: CanonicalOrderInput, o: { accountId: string | null; orderId?: string | null; preview?: boolean; known?: Known; instrument?: Instrument } = { accountId: null }): Promise<Evaluated> {
    const order = canonicalOrder(input), mode: RiskMode = order.mode === 'live' ? 'live' : 'paper';
    const c = await this.context(order, o), limits = effectiveLimits(mode, await this.storedLimits(mode), order);
    const ev = evaluateRisk({ kind: 'order', order }, c.ctx, limits);
    let checks: ServiceCheck[] = ev.checks.map((x) => ({ ...x }));
    // a venue without an order book (a liquidity pool): the two book checks cannot be answered from a book that does not exist.
    // The venue engine bounds the execution price itself (the order's acceptable price); said here, not hidden.
    if (!c.market.hasBook && !ev.reducing) checks = checks.map((x) => (x.id === 'slippage' || x.id === 'min_liquidity') && !x.ok
      ? { ...x, ok: true, detail: `not applicable: ${order.venue} has no order book; the order's acceptable price bounds its execution (checked by the venue engine and the signer)` } : x);
    // a part of the book that could not be read understates exposure: no new risk on an incomplete context
    checks.push(ev.reducing ? { id: 'context_complete', ok: true, observed: null, limit: null, detail: 'exempt: the order strictly reduces an existing position', exempt: true }
      : { id: 'context_complete', ok: c.incomplete.length === 0, observed: c.incomplete.length ? c.incomplete.join('; ').slice(0, 300) : 'every account and venue of the book was read', limit: null,
        detail: c.incomplete.length ? 'a part of the book could not be read: exposure cannot be shown to be within the limits' : 'the context is complete', exempt: false });
    const failed = checks.filter((x) => !x.ok).map((x) => x.id), decision = failed.length ? 'deny' as const : 'allow' as const;
    const first = checks.find((x) => !x.ok) ?? null;
    const code = decision === 'allow' ? null : failed.includes('read_only') ? 'read_only_mode' as const : failed.includes('kill_switch') ? 'kill_switch_active' as const : 'risk_denied' as const;
    const pick = code === 'read_only_mode' ? checks.find((x) => x.id === 'read_only') : code === 'kill_switch_active' ? checks.find((x) => x.id === 'kill_switch') : first;
    const e: Omit<Evaluated, 'decisionId'> = { decision, reducing: ev.reducing, checks, failed, derived: ev.derived, code, reason: pick ? `${pick.id}: ${pick.detail}` : null, market: c.market, leverage: c.leverage, equity: c.equity, book: c.book,
      accounts: c.ctx.accounts.map((a) => ({ accountId: a.account, venue: a.venue, equity: a.equity, marginUsed: a.marginUsed, freeCollateral: a.freeCollateral })) };
    const decisionId = await this.record(e, { kind: 'order', preview: o.preview === true, orderId: o.orderId ?? null, clientOrderId: order.clientOrderId, principal: order.principal, mode: order.mode, venue: order.venue, instrument: order.instrument, limits,
      context: { book: c.book, equity: c.ctx.equity, pnl: c.ctx.pnl, usage: c.ctx.usage, marks: c.ctx.marks, positions: c.ctx.positions.length, accounts: c.ctx.accounts.length, signer: c.ctx.signer, killSwitch: c.ctx.killSwitch, readOnly: c.ctx.readOnly, incomplete: c.incomplete, marketError: c.marketError } });
    return { ...e, decisionId };
  }

  /** a cancel is always permitted (kill switch, read-only, signer down): recorded like any decision */
  async evaluateCancel(r: { venue: string; clientOrderId: string; orderId: string | null; principal: { kind: string; id: string }; mode: string; instrument: string | null }): Promise<{ decision: 'allow' | 'deny'; decisionId: number }> {
    const sw = await this.switches();
    const ev = evaluateRisk({ kind: 'cancel', venue: r.venue, clientOrderId: r.clientOrderId }, { now: this.now(), killSwitch: sw.killSwitch.on, readOnly: sw.readOnly.on, instrument: null, asset: null, positions: [], accounts: [], marks: [], book: null,
      pnl: { realizedToday: '0', unrealizedToday: '0', realizedInception: '0', unrealizedInception: '0' }, equity: { current: '0', peak: '0' }, signer: { reachable: true, halted: false }, connections: {},
      usage: { ordersLastMinute: 0, ordersLastHour: 0, ordersToday: 0, notionalToday: '0' } }, {});
    const e = { decision: ev.decision, reducing: ev.reducing, checks: ev.checks as ServiceCheck[], failed: ev.checks.filter((x) => !x.ok).map((x) => x.id as string), derived: ev.derived, code: null, reason: null,
      market: { instrument: null, ticker: null, book: null, hasBook: false }, leverage: null, equity: '0', book: bookOf(r.mode, 'mainnet'), accounts: [] };
    return { decision: ev.decision, decisionId: await this.record(e, { kind: 'cancel', preview: false, orderId: r.orderId, clientOrderId: r.clientOrderId, principal: r.principal, mode: r.mode, venue: r.venue, instrument: r.instrument, limits: {}, context: { killSwitch: sw.killSwitch.on, readOnly: sw.readOnly.on } }) };
  }

  /** the gate the venue engines call (derivatives/gate.ts). An order the order service has just evaluated is not evaluated twice. */
  gate: PreTradeGate = async (r) => {
    const now = this.now(), req = r.req;
    const cid = /^[A-Za-z0-9._:-]{8,128}$/.test(req.clientId) ? req.clientId : `legacy-${createHash('sha256').update(req.clientId).digest('hex').slice(0, 32)}`;
    const [seen] = await sql<{ decision: string }[]>`select decision from risk_decisions where client_order_id = ${cid} and not preview and kind = 'order' and mode = ${r.mode} and at > ${new Date(now - 60_000)} order by id desc limit 1`;
    if (seen?.decision === 'allow') return { ok: true };
    const triggered = req.type !== 'market' && req.type !== 'limit', limited = req.type === 'limit' || req.type === 'stop_limit' || req.type === 'take_profit_limit';
    const ref = triggered && req.triggerPrice ? req.triggerPrice : r.known.ticker.mid ?? r.known.ticker.mark;
    let slip = 500;
    if (!limited && req.price !== null) { try { const d = D.abs(D.sub(D.from(req.price), D.from(ref))); slip = Math.min(10_000, Number(D.str(D.div(D.mul(d, D.from(10000n)), D.from(ref), 0, 'up')))); } catch { slip = 500; } }
    const notional = D.mul(D.from(req.size), D.from(req.price ?? ref));
    let order: CanonicalOrder;
    try {
      order = canonicalOrder({ v: 1, venue: r.venue, network: r.network, instrument: req.instrument, marketKind: 'perp', side: req.side, type: req.type === 'market' ? 'market' : req.type === 'limit' ? 'limit' : req.type.startsWith('stop') ? 'stop' : 'take_profit',
        size: req.size, notional: null, limitPrice: limited ? req.price : null, triggerPrice: triggered ? req.triggerPrice : null, reduceOnly: req.reduceOnly, tif: req.type === 'market' ? 'ioc' : req.tif, maxSlippageBps: slip,
        maxFeeUsd: D.str(D.div(notional, D.from(1000n), 6, 'up')), leverage: null, marginMode: null, clientOrderId: cid, mode: r.mode,
        principal: r.origin === 'mandate' ? { kind: 'agent', id: (r.agentId ?? 'agent').slice(0, 80) } : { kind: 'owner', id: 'owner' }, mandateId: r.origin === 'mandate' ? r.mandateId ?? null : null, createdAt: now, expiresAt: now + 120_000 });
    } catch (e) { return { ok: false, code: 'risk_denied', reason: `the order cannot be expressed as a canonical order (${msg(e)})` }; }
    const ev = await this.evaluateOrder(order, { accountId: r.accountId, known: r.known, instrument: r.instrument });
    return ev.decision === 'allow' ? { ok: true } : { ok: false, code: ev.code ?? 'risk_denied', reason: (ev.reason ?? 'denied by the risk engine').slice(0, 400) };
  };

  // ------------------------------------------------------------------ views (Risk screen, GET /risk)
  async decisions(limit = 50) {
    return (await sql`select id, at, order_id, client_order_id, kind, preview, principal_kind, principal_id, mode, venue, instrument, decision, reducing, failed, checks from risk_decisions order by id desc limit ${limit}`).map((r) => ({
      id: Number(r.id), at: (r.at as Date).getTime(), orderId: r.order_id as string | null, clientOrderId: r.client_order_id as string | null, kind: r.kind as string, preview: r.preview as boolean,
      principal: { kind: r.principal_kind as string, id: r.principal_id as string }, mode: r.mode as string, venue: r.venue as string, instrument: r.instrument as string | null, decision: r.decision as string, reducing: r.reducing as boolean,
      failed: r.failed as string[], failing: (r.checks as ServiceCheck[]).filter((x) => !x.ok).map((x) => ({ id: x.id, observed: x.observed, limit: x.limit, detail: x.detail })) }));
  }

  /** exposure of one book: per asset, per venue, leverage, collateral per venue, distance to liquidation — from the same reads as a context */
  async exposure(book: BookKey) {
    const v = await this.readBook(book);
    const readable = v.accounts.filter((a) => a.state !== null), equity = sumDec(readable.map((a) => a.state!.equity));
    const byAsset = new Map<string, { long: ReturnType<typeof D.from>; short: ReturnType<typeof D.from> }>(), byVenue = new Map<string, ReturnType<typeof D.from>>();
    let gross = D.zero;
    const positions = v.positions.map((p) => {
      const notional = D.mul(D.from(p.position.size), D.from(p.position.markPrice));
      const a = byAsset.get(p.asset) ?? { long: D.zero, short: D.zero };
      if (p.position.side === 'long') a.long = D.add(a.long, notional); else a.short = D.add(a.short, notional);
      byAsset.set(p.asset, a); byVenue.set(p.venue, D.add(byVenue.get(p.venue) ?? D.zero, notional)); gross = D.add(gross, notional);
      const mark = D.from(p.position.markPrice), liq = p.position.liquidationPrice === null ? null : D.from(p.position.liquidationPrice);
      const distanceBps = liq !== null && D.isPos(mark) ? D.str(D.div(D.mul(D.abs(D.sub(mark, liq)), D.from(10000n)), mark, 2, 'down')) : null;
      return { venue: p.venue, accountId: p.accountId, asset: p.asset, instrument: p.position.instrument, side: p.position.side, size: p.position.size, markPrice: p.position.markPrice, notional: D.str(notional), leverage: p.position.leverage,
        liquidationPrice: p.position.liquidationPrice, liquidationDistanceBps: distanceBps, unrealizedPnl: p.position.unrealizedPnl, source: p.position.source };
    });
    const peak = await getSetting<{ equity: DecStr } | null>(peakKey(book), null);
    return {
      book, ts: this.now(), equity, peakEquity: peak?.equity ?? equity, grossExposure: D.str(gross), leverage: D.isPos(D.from(equity)) ? D.str(D.div(gross, D.from(equity), 4, 'half_even')) : null,
      byAsset: [...byAsset].map(([asset, x]) => ({ asset, long: D.str(x.long), short: D.str(x.short), net: D.str(D.sub(x.long, x.short)) })),
      byVenue: [...byVenue].map(([venue, x]) => ({ venue, gross: D.str(x) })),
      collateral: readable.map((a) => ({ venue: a.venue, accountId: a.accountId, equity: a.state!.equity, collateral: a.state!.collateral, freeCollateral: a.state!.freeCollateral, marginUsed: a.state!.marginUsed,
        shareBps: D.isPos(D.from(equity)) ? D.str(D.div(D.mul(D.from(a.state!.equity), D.from(10000n)), D.from(equity), 0, 'half_even')) : null })),
      positions, errors: v.errors, pnl: await this.pnl(v.accounts.map((a) => a.accountId), v, this.now()),
    };
  }

  /** supervisor step: the declared automatic stops of the LIVE book. Returns the reason when the kill switch was engaged. */
  async superviseAuto(): Promise<string | null> {
    const sw = await this.switches();
    if (sw.killSwitch.on) return null;
    const auto = await this.autoKill(), lim = { ...defaultLimits('live'), ...(await this.storedLimits('live')) };
    if (!auto.totalLoss && !auto.drawdown && !auto.dailyLoss) return null;
    const [any] = await sql`select 1 as x from deriv_accounts where authorization_id is not null limit 1`;
    if (!any) return null;
    const x = await this.exposure('live-mainnet');
    if (x.errors.length || !D.isPos(D.from(x.equity))) return null;                   // an unreadable book stops new risk order by order (context_complete); it does not trip the switch
    await this.peak('live-mainnet', x.equity);
    const total = D.add(D.from(x.pnl.realizedInception), D.from(x.pnl.unrealizedInception)), daily = D.add(D.from(x.pnl.realizedToday), D.from(x.pnl.unrealizedToday));
    const peak = D.from((await getSetting<{ equity: DecStr } | null>(peakKey('live-mainnet'), null))?.equity ?? x.equity), dd = D.max(D.sub(peak, D.from(x.equity)), D.zero);
    let why: string | null = null;
    if (auto.totalLoss && lim.maxTotalLoss !== undefined && D.lte(total, D.neg(D.from(lim.maxTotalLoss)))) why = `total loss limit reached: PnL ${D.str(total)} against -${lim.maxTotalLoss}`;
    else if (auto.dailyLoss && lim.maxDailyLoss !== undefined && D.lte(daily, D.neg(D.from(lim.maxDailyLoss)))) why = `daily loss limit reached: PnL ${D.str(daily)} against -${lim.maxDailyLoss}`;
    else if (auto.drawdown && lim.maxDrawdownBps !== undefined && D.isPos(peak) && D.isPos(dd) && D.gte(D.mul(dd, D.from(10000n)), D.mul(D.from(lim.maxDrawdownBps), peak))) why = `drawdown limit reached: equity ${x.equity} against a peak of ${D.str(peak)} (limit ${lim.maxDrawdownBps} bps)`;
    if (why) await this.engageKillSwitch({ kind: 'system', id: 'supervisor' }, why);
    return why;
  }
}
