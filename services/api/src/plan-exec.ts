// Any-to-any plans (V7): execution as a saga over the EXISTING operations (docs/v7/ANY-TO-ANY.md).
//
// A plan is a list of legs. Each leg is one ordinary proposal — a same-network swap (swap-exec.ts / swap-exec-sol.ts), a CCTP
// transfer (bridge.ts) or a THORChain swap (xswap.ts) — created THROUGH THE SAME ROUTE the owner would use by hand, only when
// the previous leg has settled, sized on what was actually received, re-quoted at that moment, with its own minimum output and
// its own passkey approval. Nothing here signs, approves, broadcasts or builds a transaction; nothing here can make the signer
// accept anything the single-leg flows would refuse. Between two legs the funds are an ordinary balance of the wallet.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CCTP_ENABLED, cctpUsdc, formatUnits, fromThorAmount, getAsset, getNetwork, KYBER_ENABLED, parseUnits, THOR_ASSETS } from '@spw/core';
import { CCTP_SOL_NETWORK, CCTP_SOL_TIMES, cctpSolUsdc } from '@spw/core'; // v8
import {
  assetKey, checkPlan, createEnabledProviders, GAS_MARGIN, DEFAULT_POLICY, enumeratePlans, httpClient, planId, PlanQuoteError, pricePlan, ProviderRuntime, QuoteAggregator, rankPlans, whyNotExecutable,
  type AssetRef, type LegQuote, type PlanCaps, type PlanContext, type PlanLegSpec, type PricedPlan, type QuoteEvent, type QuoteLeg, type SwapProvider, type SwapQuote,
} from '@spw/swap';
import { adapterFor } from './chains/index.ts';
import { config, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { addressFor, signer, type SignerStatus } from './signer-client.ts';
import { view, type ProposalRow } from './transfers.ts';
import { JUPITER_LABEL } from './swap-exec-sol.ts';
import {
  floorHolds, legAmount, legOutcome, planAdvance, planAttach, planCreate, planOpen, planPause, planReplan, planRetry, planStop, TRANSIENT,
  type PlanDoc, type PlanEvent, type PlanLeg, type Step,
} from './plan-state.ts';

export interface PlanDeps {
  providers?: SwapProvider[]; prices: () => Promise<Record<string, { usd: number }> | null>;
  /** tests: a scripted quote source instead of the real providers */
  quoteLeg?: (slippageBps: number, st: SignerStatus) => QuoteLeg;
  /** tests: scripted balances instead of the chain adapters */
  balance?: (a: AssetRef, st: SignerStatus) => Promise<bigint | null>;
}

/** What the wallet can execute today, from the pinned tables (never from a provider's advertisement). */
export function planCaps(): PlanCaps {
  const swap: PlanCaps['swap'] = { solana: 'jupiter' };
  for (const n of Object.keys(KYBER_ENABLED)) swap[n] = 'kyberswap';
  const cctp: PlanCaps['cctp'] = {};
  for (const [n, pin] of Object.entries(CCTP_ENABLED)) cctp[n] = { usdc: cctpUsdc(n).id, fast: pin.fastSource };
  cctp[CCTP_SOL_NETWORK] = { usdc: cctpSolUsdc().id, fast: CCTP_SOL_TIMES.fastSource }; // v8: USDC between Solana and the seven EVM networks (services/api/src/bridge-sol.ts)
  return { swap, cctp, thor: THOR_ASSETS.map((a) => ({ network: a.network, asset: a.asset, source: a.source })) };
}

const LABEL: Record<string, string> = { kyberswap: 'KyberSwap', jupiter: JUPITER_LABEL, cctp: 'Circle CCTP', thorchain: 'THORChain' };
/** A same-network swap is one transaction; providers give no time for it. Rough inclusion + confirmation time, shown as an estimate. */
const swapSeconds = (network: string) => (network === 'ethereum' ? 180 : network === 'solana' ? 20 : 45);
const refOf = (s: string): AssetRef => {
  const k = s.indexOf(':');
  if (k < 1) throw new UserError('bad_asset', 'asset must be "<network>:<asset>"');
  const ref = { network: s.slice(0, k), asset: s.slice(k + 1) };
  try { return { network: ref.network, asset: getAsset(ref.network, ref.asset).id }; } catch { throw new UserError('unsupported_asset', 'asset is not in the wallet registry'); }
};
const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v, big)) as T;

interface Row { id: string; state: string; current: number; legs: PlanLeg[]; meta: Omit<PlanDoc, 'id' | 'state' | 'current' | 'legs'>; created_at: Date; updated_at: Date }
const docOf = (r: Row): PlanDoc => ({ ...r.meta, id: r.id, state: r.state as PlanDoc['state'], current: r.current, legs: r.legs });
async function loadPlan(id: string): Promise<PlanDoc> {
  const [r] = z.uuid().safeParse(id).success ? await sql<Row[]>`select * from plans where id = ${id}` : [];
  if (!r) throw new UserError('not_found', 'plan not found', 404);
  return docOf(r);
}
async function savePlan(s: Step, describe: (e: PlanEvent, p: PlanDoc) => Record<string, unknown>): Promise<PlanDoc> {
  const { id, state, current, legs, ...meta } = s.plan;
  await sql`insert into plans (id, state, current, legs, meta, created_at, updated_at) values (${id}, ${state}, ${current}, ${sql.json(legs as never)}, ${sql.json(meta as never)}, ${new Date(s.plan.createdAt)}, now())
    on conflict (id) do update set state = excluded.state, current = excluded.current, legs = excluded.legs, meta = excluded.meta, updated_at = now()`;
  for (const e of s.events) await audit(e[0], e[0] === 'plan.step_settled' || e[0] === 'plan.done' ? 'chain' : 'system', describe(e, s.plan));
  return s.plan;
}

// one preparation at a time per plan (a second click must not create a second proposal)
const locks = new Map<string, Promise<unknown>>();
function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
  locks.set(id, run.catch(() => {}));
  return run;
}

export function planRoutes(app: FastifyInstance, deps: PlanDeps): void {
  const caps = planCaps();
  const providers = deps.providers ?? createEnabledProviders(process.env);
  // own runtimes: a plan asks several quotes in a row from the same provider (leg 3 on two amounts)
  const agg = new QuoteAggregator(providers.map((p) => new ProviderRuntime(p, { ...DEFAULT_POLICY, timeoutMs: 7000, ratePerSec: 3, burst: 12, ...(p.id === 'thorchain' ? { timeoutMs: 8000 } : {}) }, httpClient(p.id))));
  let priceMap: Record<string, { usd: number }> = {};
  const refresh = async () => { const p = await deps.prices().catch(() => null); if (p) priceMap = p; };
  const usd = (a: AssetRef, amount: bigint): number | null => { try { const d = getAsset(a.network, a.asset), p = priceMap[d.symbol]?.usd; return p === undefined ? null : Number(formatUnits(amount, d.decimals)) * p; } catch { return null; } };
  const assetView = (a: AssetRef) => { const d = getAsset(a.network, a.asset), n = getNetwork(a.network); return { key: assetKey(a), network: a.network, networkName: n.name, asset: d.id, symbol: d.symbol, decimals: d.decimals }; };
  const disp = (a: AssetRef, v: bigint | string) => formatUnits(BigInt(v), getAsset(a.network, a.asset).decimals);

  const lastCall = new Map<string, number>();
  const pace = async (via: string) => { const wait = (lastCall.get(via) ?? 0) + 400 - Date.now(); lastCall.set(via, Math.max(Date.now(), (lastCall.get(via) ?? 0) + 400)); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); };
  /** Real quotes from the provider that executes the leg, with the wallet's own addresses at both ends. */
  const liveQuote = (slippageBps: number, st: SignerStatus): QuoteLeg => async (leg, amountIn) => {
    const req = { from: leg.from, to: leg.to, amountIn, sender: addressFor(st, leg.from.network), recipient: addressFor(st, leg.to.network), slippageBps };
    // a plan asks the same keyless provider several times in a row: space the calls, and wait once or twice when it says "too many"
    let quotes: SwapQuote[] = [], events: QuoteEvent[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await pace(leg.via);
      ({ quotes, events } = await agg.collect(req, { only: [leg.via], deadlineMs: 9000, role: 'direct' }));
      if (quotes.length || !events.some((e) => e.type === 'provider' && e.status === 'error' && e.code === 'rate_limited')) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    const q = leg.via === 'cctp' ? quotes.find((x) => { const r = x.raw as { product?: string; transfer?: string } | undefined; return r?.product === 'cctp-v2' && r.transfer === (leg.speed ?? 'standard'); }) : quotes[0];
    if (!q) {
      const err = events.find((e) => e.type === 'provider' && e.status === 'error') as { code?: string; detail?: string } | undefined;
      if (err) throw new UserError('provider_unavailable', `${LABEL[leg.via]} did not give a quote (${err.code ?? 'error'}${err.detail ? `: ${err.detail.slice(0, 100)}` : ''})`, 503);
      return null;
    }
    const raw = q.raw as { recommendedMinAmountIn1e8?: string } | undefined;
    const out: LegQuote = { amountOut: q.amountOut, minAmountOut: q.minAmountOut, fees: q.fees, seconds: q.estimatedSeconds ?? (leg.kind === 'swap' ? swapSeconds(leg.from.network) : null), via: q.steps.flatMap((s) => s.via).slice(0, 4),
      minIn: leg.via === 'thorchain' && raw?.recommendedMinAmountIn1e8 ? fromThorAmount(BigInt(raw.recommendedMinAmountIn1e8), getAsset(leg.from.network, leg.from.asset).decimals) : null };
    return out;
  };
  /** One request prices several plans that share legs: the same (leg, amount) is asked once. */
  const memo = (q: QuoteLeg): QuoteLeg => { const seen = new Map<string, Promise<LegQuote | null>>(); return (leg, amount) => { const k = `${planId([leg])}#${amount}`; let p = seen.get(k); if (!p) { p = q(leg, amount); seen.set(k, p); } return p; }; };
  const quoter = (slippageBps: number, st: SignerStatus) => memo((deps.quoteLeg ?? liveQuote)(slippageBps, st));

  const liveBalance = async (a: AssetRef, st: SignerStatus): Promise<bigint | null> => { try { const b = await adapterFor(a.network).balances(addressFor(st, a.network)); return b[getAsset(a.network, a.asset).id] ?? null; } catch { return null; } };
  const balanceOf = deps.balance ?? liveBalance;
  async function context(st: SignerStatus, plans: PlanLegSpec[][]): Promise<PlanContext> {
    // every asset whose balance a check needs: the source, and the coin of every network involved
    const need = new Map<string, AssetRef>();
    for (const legs of plans) for (const l of legs) { need.set(assetKey(l.from), l.from); for (const n of [l.from.network, l.to.network]) need.set(`${n}:native`, { network: n, asset: 'native' }); }
    const bal = new Map<string, bigint | null>();
    await Promise.all([...need].map(async ([k, a]) => { bal.set(k, await balanceOf(a, st)); }));
    return { asset: (a) => { const d = getAsset(a.network, a.asset); return { symbol: d.symbol, decimals: d.decimals }; }, perTx: st.policy.perTx, daily: st.policy.daily, spentToday: st.spentToday, balance: (a) => bal.get(assetKey(a)) ?? null };
  }

  const planView = (p: PricedPlan, ctx: PlanContext) => {
    const last = p.legs[p.legs.length - 1]!.spec.to, first = p.legs[0]!.spec.from;
    const gas = new Map<string, bigint>();
    for (const f of p.legs.flatMap((l) => l.fees)) if (f.kind === 'network' && !f.includedInOutput && f.asset.asset === 'native') gas.set(f.asset.network, (gas.get(f.asset.network) ?? 0n) + f.amount * GAS_MARGIN);
    return {
      id: p.id, executable: p.executable, approvals: p.approvals, seconds: p.seconds, extraFeesUsd: p.extraFeesUsd,
      from: assetView(first), to: assetView(last), amountIn: p.amountIn, amountInDisplay: disp(first, p.amountIn),
      expectedOut: p.expectedOut, expectedOutDisplay: disp(last, p.expectedOut), worstOut: p.worstOut, worstOutDisplay: disp(last, p.worstOut),
      expectedUsd: usd(last, p.expectedOut), worstUsd: usd(last, p.worstOut), inUsd: usd(first, p.amountIn),
      legs: p.legs.map((l) => ({ kind: l.spec.kind, via: l.spec.via, label: LABEL[l.spec.via], speed: l.spec.speed ?? null, from: assetView(l.spec.from), to: assetView(l.spec.to), venues: l.via,
        expectedInDisplay: disp(l.spec.from, l.expectedIn), worstInDisplay: disp(l.spec.from, l.worstIn), expectedOutDisplay: disp(l.spec.to, l.expectedOut), worstOutDisplay: disp(l.spec.to, l.worstOut), seconds: l.seconds,
        fees: l.fees.map((f) => { const d = getAsset(f.asset.network, f.asset.asset); return { kind: f.kind, symbol: d.symbol, network: f.asset.network, networkName: getNetwork(f.asset.network).name, display: formatUnits(f.amount, d.decimals), usd: f.usd, includedInOutput: f.includedInOutput, estimated: f.estimated }; }) })),
      // what must be true before starting: the coin of every network involved, and the limits of each leg's own asset
      requirements: {
        gas: [...gas].map(([network, need]) => { const n = getNetwork(network), have = ctx.balance({ network, asset: 'native' }); const miss = p.issues.find((i) => i.code === 'gas_missing' && i.network === network);
          return { network, networkName: n.name, symbol: n.native.symbol, needDisplay: formatUnits(need, n.native.decimals), haveDisplay: have === null ? null : formatUnits(have, n.native.decimals), ok: !miss }; }),
        limits: p.legs.map((l, k) => { const a = ctx.asset(l.spec.from), id = `${l.spec.from.network}:${a.symbol}`, perTx = BigInt(ctx.perTx[id] ?? '0'), daily = BigInt(ctx.daily[id] ?? '0'), spent = BigInt(ctx.spentToday[id] ?? '0');
          return { leg: k, network: l.spec.from.network, networkName: getNetwork(l.spec.from.network).name, symbol: a.symbol, needDisplay: formatUnits(l.expectedIn, a.decimals), perTransferDisplay: formatUnits(perTx, a.decimals), leftTodayDisplay: formatUnits(daily > spent ? daily - spent : 0n, a.decimals),
            ok: !p.issues.some((i) => i.leg === k && i.blocking && i.code.startsWith('limit')) }; }),
      },
      issues: p.issues.map((i) => ({ ...i, networkName: getNetwork(i.network).name, needDisplay: formatUnits(BigInt(i.need), i.decimals), haveDisplay: formatUnits(BigInt(i.have), i.decimals) })),
    };
  };
  /** A blocking issue in plain words (API answers are English; the UI has its own FR/EN wording per code). */
  const issueText = (i: ReturnType<typeof planView>['issues'][number]) => {
    const step = i.leg === null ? '' : `step ${i.leg + 1}: `;
    switch (i.code) {
      case 'insufficient_balance': return `the wallet holds ${i.haveDisplay} ${i.symbol} on ${i.networkName}, less than the amount`;
      case 'limit_missing': return `${step}${i.symbol} on ${i.networkName} has no transfer limit in the signer's policy and cannot be moved`;
      case 'limit_per_transfer': return `${step}${i.needDisplay} ${i.symbol} on ${i.networkName} is above the per-transfer limit of ${i.haveDisplay} ${i.symbol}`;
      case 'limit_daily': return `${step}${i.needDisplay} ${i.symbol} on ${i.networkName} is above what is left of today's limit (${i.haveDisplay} ${i.symbol})`;
      case 'below_minimum': return `${step}the minimum for this step is ${i.needDisplay} ${i.symbol}`;
      case 'gas_missing': return `about ${i.needDisplay} ${i.symbol} is needed on ${i.networkName} for network fees; the wallet has ${i.haveDisplay} available there`;
      default: return `${step}${i.code}`;
    }
  };

  /** Enumerate, price with real quotes and check every candidate plan for a pair and an amount. */
  async function plansFor(from: AssetRef, to: AssetRef, amountIn: bigint, slippageBps: number, st: SignerStatus) {
    const shapes = enumeratePlans(from, to, caps);
    if (shapes.length === 0) return { plans: [] as PricedPlan[], ctx: null as PlanContext | null, skipped: [] as { id: string; leg: number; code: string; message: string }[], notExecutable: whyNotExecutable(from, to, caps) };
    await refresh();
    const q = quoter(slippageBps, st), ctx = await context(st, shapes);
    const plans: PricedPlan[] = [], skipped: { id: string; leg: number; code: string; message: string }[] = [];
    for (const legs of shapes) { // sequential: the quotes of one plan feed the next through the memo, and providers are not hammered
      try { plans.push(checkPlan(await pricePlan(legs, amountIn, q, usd), ctx)); }
      catch (e) { if (!(e instanceof PlanQuoteError)) throw e; skipped.push({ id: planId(legs), leg: e.leg, code: e.code, message: e.message.slice(0, 160) }); }
    }
    return { plans: rankPlans(plans), ctx, skipped, notExecutable: null };
  }
  const plannedOf = (p: PricedPlan) => p.legs.map((l) => ({ spec: l.spec, planned: { expectedIn: l.expectedIn.toString(), worstIn: l.worstIn.toString(), expectedOut: l.expectedOut.toString(), worstOut: l.worstOut.toString(), seconds: l.seconds } }));

  // ---- the plan as shown to the owner ---------------------------------------------------------------------------------
  const describe = (e: PlanEvent, p: PlanDoc): Record<string, unknown> => {
    const leg = p.legs[Math.min(p.current, p.legs.length - 1)]!, a = assetView(p.from), b = assetView(p.to);
    return { ...e[1], what: `${a.symbol} → ${b.symbol}`, network: leg.spec.from.network, steps: p.legs.length };
  };
  async function docView(p: PlanDoc) {
    const cur = p.legs[p.current], dstA = p.to;
    const [row] = cur?.proposalId ? await sql<ProposalRow[]>`select * from proposals where id = ${cur.proposalId}` : [];
    const done = p.state === 'done', hold = { network: p.holding.network, asset: p.holding.asset };
    const next = done ? 'done' : p.state === 'stopped' ? 'stopped' : p.state === 'paused' ? 'paused' : !cur ? 'done' : cur.state === 'ready' ? 'prepare' : cur.state === 'proposed' && row?.state === 'pending_approval' ? 'approve' : 'wait';
    return plain({
      id: p.id, state: p.state, next, current: p.current, steps: p.legs.length, replans: p.replans, createdAt: new Date(p.createdAt).toISOString(), updatedAt: new Date(p.updatedAt).toISOString(),
      from: assetView(p.from), to: assetView(p.to), amountInDisplay: disp(p.from, p.amountIn), slippageBps: p.slippageBps,
      floor: p.floor, floorDisplay: p.floor === null ? null : disp(dstA, p.floor),
      // where the funds are now: always the wallet's own address
      holding: { ...assetView(hold), amount: p.holding.amount, amountDisplay: disp(hold, p.holding.amount) },
      pause: p.pause, estimate: p.estimate ? { expectedOutDisplay: disp(dstA, p.estimate.expectedOut), worstOutDisplay: disp(dstA, p.estimate.worstOut), at: new Date(p.estimate.at).toISOString() } : null,
      // planned at the start: "attendu" and "garanti au pire" for the whole route — information, not a promise
      plannedExpectedDisplay: disp(dstA, p.legs[p.legs.length - 1]!.planned.expectedOut), plannedWorstDisplay: disp(dstA, p.legs[p.legs.length - 1]!.planned.worstOut),
      receivedDisplay: done ? disp(dstA, p.holding.amount) : null,
      legs: p.legs.map((l, k) => ({ index: k, state: l.state, kind: l.spec.kind, via: l.spec.via, label: LABEL[l.spec.via], speed: l.spec.speed ?? null, from: assetView(l.spec.from), to: assetView(l.spec.to), seconds: l.planned.seconds,
        planned: { expectedInDisplay: disp(l.spec.from, l.planned.expectedIn), worstInDisplay: disp(l.spec.from, l.planned.worstIn), expectedOutDisplay: disp(l.spec.to, l.planned.expectedOut), worstOutDisplay: disp(l.spec.to, l.planned.worstOut) },
        actual: { inDisplay: l.actualIn !== undefined ? disp(l.spec.from, l.actualIn) : null, outDisplay: l.actualOut !== undefined ? disp(l.spec.to, l.actualOut) : null },
        proposalId: l.proposalId ?? null, attempts: l.attempts.map((a) => ({ proposalId: a.proposalId, outcome: a.outcome ?? null, error: a.error ?? null, at: new Date(a.at).toISOString() })) })),
      proposal: row ? view(row) : null,
    });
  }

  /** Look at the current leg's proposal and move the plan accordingly. Signs nothing, creates nothing. */
  async function advance(p: PlanDoc): Promise<PlanDoc> {
    const l = p.legs[p.current];
    if (p.state !== 'active' || !l?.proposalId || (l.state !== 'proposed' && l.state !== 'in_flight')) return p;
    const [row] = await sql<ProposalRow[]>`select * from proposals where id = ${l.proposalId}`;
    if (!row) return savePlan(planAdvance(p, { kind: 'failed', outcome: 'failed', reason: 'the proposal of this step no longer exists' }, Date.now()), describe);
    const s = planAdvance(p, legOutcome({ state: row.state, kind: row.kind, confirmations: row.confirmations, minConf: getNetwork(row.network).minConf, error: row.error, out_amount: row.out_amount, bridge: row.bridge, xswap: row.xswap }), Date.now());
    return s.events.length || s.plan !== p ? savePlan(s, describe) : p;
  }
  advanceOne = advance;

  /** Call one of the wallet's own routes as the owner's request would: same session, same checks, same code path. */
  async function inject(req: FastifyRequest, url: string, body: unknown, idem?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await app.inject({ method: 'POST', url, headers: { ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), origin: config.origin, 'x-spw-csrf': '1', 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) }, payload: JSON.stringify(body) });
    let json: Record<string, unknown> = {}; try { json = r.json(); } catch { /* not JSON */ }
    return { status: r.statusCode, json };
  }

  const Pair = z.strictObject({ from: z.string().min(3).max(140), to: z.string().min(3).max(140), amount: z.string().min(1).max(60), slippageBps: z.number().int().min(1).max(300).default(50) });
  function parsePair(b: z.infer<typeof Pair>) {
    const from = refOf(b.from), to = refOf(b.to);
    if (assetKey(from) === assetKey(to)) throw new UserError('same_asset', 'choose two different assets');
    let amountIn: bigint;
    try { amountIn = parseUnits(b.amount, getAsset(from.network, from.asset).decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
    if (amountIn <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
    return { from, to, amountIn };
  }

  app.get('/api/v1/plans/capabilities', async () => ({ maxLegs: 3, swap: caps.swap, cctp: Object.keys(caps.cctp), thorchain: caps.thor.map((t) => ({ ...assetView(t), source: t.source })), hub: 'USDC' }));

  // Candidate plans with real quotes for every leg. Signs nothing, prepares nothing, stores nothing.
  app.post('/api/v1/plans/quote', async (req) => {
    const b = Pair.parse(req.body), { from, to, amountIn } = parsePair(b);
    const st = await signer.status();
    const r = await plansFor(from, to, amountIn, b.slippageBps, st);
    return plain({ from: assetView(from), to: assetView(to), amountIn, slippageBps: b.slippageBps, notExecutable: r.notExecutable, plans: r.ctx ? r.plans.map((p) => planView(p, r.ctx!)) : [], skipped: r.skipped });
  });

  // Start a plan: the chosen shape is priced and checked again, then stored. Nothing is prepared or signed: the first leg is "ready".
  app.post('/api/v1/plans', async (req) => {
    const b = Pair.extend({ plan: z.string().min(3).max(600), floor: z.string().min(1).max(60).nullish() }).parse(req.body), { from, to, amountIn } = parsePair(b);
    const st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const [open] = await sql<{ id: string }[]>`select id from plans where state in ('active', 'paused') limit 1`;
    if (open) throw new UserError('plan_open', 'another plan is still open; finish it or stop it first (the funds stay where they are)', 409);
    let floor: bigint | null = null;
    if (b.floor) { try { floor = parseUnits(b.floor, getAsset(to.network, to.asset).decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); } if (floor <= 0n) floor = null; }
    const r = await plansFor(from, to, amountIn, b.slippageBps, st);
    const p = r.plans.find((x) => x.id === b.plan);
    if (!p || !r.ctx) throw new UserError('no_route', r.skipped.find((s) => s.id === b.plan)?.message ?? 'this plan has no quote right now; ask for plans again', 422);
    if (!p.executable) { const v = planView(p, r.ctx); throw Object.assign(new UserError('plan_not_startable', `this plan cannot start: ${v.issues.filter((i) => i.blocking).map(issueText).join('; ')}`, 422), { issues: v.issues }); }
    if (floor !== null && p.expectedOut < floor) throw new UserError('floor_above_estimate', 'the floor is above the result expected right now', 422);
    const doc = planCreate({ id: randomUUID(), from, to, amountIn, slippageBps: b.slippageBps, floor, legs: plannedOf(p), now: Date.now() });
    await savePlan({ plan: doc, events: [['plan.created', { id: doc.id, amount: amountIn.toString(), shape: p.id, expected: p.expectedOut.toString(), worst: p.worstOut.toString(), floor: doc.floor }]] }, describe);
    return docView(doc);
  });

  app.get('/api/v1/plans', async (req) => {
    const q = z.object({ open: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
    const rows = q.open ? await sql<Row[]>`select * from plans where state in ('active', 'paused') order by created_at desc limit ${q.limit}` : await sql<Row[]>`select * from plans order by created_at desc limit ${q.limit}`;
    return { plans: await Promise.all(rows.map((r) => docView(docOf(r)))) };
  });
  app.get('/api/v1/plans/:id', async (req) => { const id = (req.params as { id: string }).id; return locked(id, async () => docView(await advance(await loadPlan(id)))); });

  // Prepare the leg that is ready: the ordinary proposal for it, sized on what the plan actually holds. Returns the passkey challenge.
  app.post('/api/v1/plans/:id/prepare', async (req) => {
    const id = (req.params as { id: string }).id;
    return locked(id, async () => {
      let p = await advance(await loadPlan(id));
      if (p.state !== 'active') throw new UserError('bad_state', `the plan is ${p.state}`, 409);
      let leg = p.legs[p.current]!;
      // a challenge issued earlier and never used (page closed): it is withdrawn and a fresh one is prepared
      if (leg.state === 'proposed' && leg.proposalId) {
        const [row] = await sql<ProposalRow[]>`select * from proposals where id = ${leg.proposalId}`;
        if (row?.state !== 'pending_approval') throw new UserError('bad_state', 'this step is already approved and on its way', 409);
        await inject(req, `/api/v1/transfers/proposals/${leg.proposalId}/reject`, {});
        p = await savePlan(planAdvance(p, { kind: 'failed', outcome: 'expired', reason: 'replaced by a fresh preparation' }, Date.now()), describe);
        leg = p.legs[p.current]!;
      }
      if (leg.state !== 'ready') throw new UserError('bad_state', 'this step is in progress', 409);
      const st = await signer.status(true);
      if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
      const amount = legAmount(p, await balanceOf(leg.spec.from, st));
      const pause = async (code: string, message: string) => ({ plan: await docView(await savePlan(planPause(p, code, message, Date.now()), describe)), proposal: null, options: null });
      if (amount <= 0n) return pause('no_funds', `the wallet no longer holds the ${assetView(leg.spec.from).symbol} of this plan on ${getNetwork(leg.spec.from.network).name}`);
      // the final result estimated from what is really held now, through the legs that remain (real quotes)
      const rest = p.legs.slice(p.current).map((l) => l.spec);
      let est: PricedPlan | null = null;
      try { await refresh(); est = await pricePlan(rest, amount, quoter(p.slippageBps, st), usd); }
      catch (e) { if (p.floor !== null) throw new UserError('provider_unavailable', `the final result could not be estimated, so the floor could not be checked: ${(e as Error).message.slice(0, 120)}. Nothing was prepared`, 503); }
      if (est) {
        p = await savePlan({ plan: { ...p, estimate: { expectedOut: est.expectedOut.toString(), worstOut: est.worstOut.toString(), at: Date.now() }, updatedAt: Date.now() }, events: [] }, describe);
        if (!floorHolds(p, est.expectedOut)) return pause('floor', `the final result estimated now is ${disp(p.to, est.expectedOut)} ${assetView(p.to).symbol}, below the floor of ${disp(p.to, p.floor!)}. Nothing was prepared; the funds are where they were`);
      }
      const amt = formatUnits(amount, getAsset(leg.spec.from.network, leg.spec.from.asset).decimals), s = leg.spec;
      const idem = `pl-${p.id.replace(/-/g, '').slice(0, 24)}-${p.replans}-${p.current}-${leg.attempts.length}`;
      const r = s.kind === 'swap' ? await inject(req, '/api/v1/swap/proposals', { network: s.from.network, fromAsset: s.from.asset, toAsset: s.to.asset, amount: amt, slippageBps: p.slippageBps }, idem)
        : s.kind === 'bridge' ? await inject(req, '/api/v1/bridge/proposals', { fromNetwork: s.from.network, toNetwork: s.to.network, amount: amt, speed: s.speed ?? 'standard' }, idem)
        : await inject(req, '/api/v1/xswap/proposals', { fromNetwork: s.from.network, fromAsset: s.from.asset, toNetwork: s.to.network, toAsset: s.to.asset, amount: amt, slippageBps: p.slippageBps }, idem);
      if (r.status !== 200) {
        const code = String(r.json.error ?? 'error'), message = String(r.json.message ?? 'the step could not be prepared');
        // "not now": the step stays ready and the plan active; anything else is a refusal of this step — the plan pauses
        if (TRANSIENT.has(code) || r.status === 401 || r.status === 429 || r.status >= 500 && code === 'internal') throw new UserError(code, message, r.status);
        return pause(code, message);
      }
      const proposal = r.json.proposal as { id: string; amount: string };
      p = await savePlan(planAttach(p, proposal.id, BigInt(proposal.amount), Date.now()), describe);
      return { plan: await docView(p), proposal: r.json.proposal, options: r.json.options };
    });
  });

  // "Réessayer" (optionally with another floor), "arrêter ici", "re-planifier depuis l'actif actuel". None of them signs anything.
  app.post('/api/v1/plans/:id/retry', async (req) => {
    const id = (req.params as { id: string }).id, b = z.strictObject({ floor: z.string().max(60).nullish() }).parse(req.body ?? {});
    return locked(id, async () => {
      let p = await loadPlan(id);
      if (b.floor !== undefined) { let f: bigint | null = null; if (b.floor) { try { f = parseUnits(b.floor, getAsset(p.to.network, p.to.asset).decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); } } p = { ...p, floor: f && f > 0n ? f.toString() : null }; }
      try { return docView(await savePlan(planRetry(p, Date.now()), describe)); } catch (e) { throw new UserError('bad_state', (e as Error).message, 409); }
    });
  });
  app.post('/api/v1/plans/:id/stop', async (req) => {
    const id = (req.params as { id: string }).id;
    return locked(id, async () => {
      let p = await advance(await loadPlan(id));
      const leg = p.legs[p.current];
      if (p.state === 'active' && leg?.state === 'proposed' && leg.proposalId) { // an unused challenge is withdrawn first
        const [row] = await sql<ProposalRow[]>`select state from proposals where id = ${leg.proposalId}`;
        if (row?.state === 'pending_approval') { await inject(req, `/api/v1/transfers/proposals/${leg.proposalId}/reject`, {}); p = await savePlan(planAdvance(p, { kind: 'failed', outcome: 'expired', reason: 'withdrawn: the plan was stopped' }, Date.now()), describe); }
      }
      try { return docView(await savePlan(planStop(p, Date.now()), describe)); } catch (e) { throw new UserError('bad_state', (e as Error).message, 409); }
    });
  });
  app.post('/api/v1/plans/:id/replan', async (req) => {
    const id = (req.params as { id: string }).id, b = z.strictObject({ plan: z.string().max(600).optional() }).parse(req.body ?? {});
    return locked(id, async () => {
      const p = await advance(await loadPlan(id));
      if (!planOpen(p)) throw new UserError('bad_state', `the plan is ${p.state}`, 409);
      const st = await signer.status(true), hold = { network: p.holding.network, asset: p.holding.asset };
      const amount = legAmount(p, await balanceOf(hold, st));
      if (amount <= 0n) throw new UserError('insufficient_funds', 'the wallet no longer holds the asset of this plan');
      const r = await plansFor(hold, p.to, amount, p.slippageBps, st);
      const pick = b.plan ? r.plans.find((x) => x.id === b.plan) : r.plans.find((x) => x.executable);
      if (!pick || !r.ctx) throw new UserError('no_route', r.notExecutable ? `no executable route from the asset held (${r.notExecutable.code})` : r.plans[0] ? `no route can start from the asset held: ${planView(r.plans[0], r.ctx!).issues.filter((i) => i.blocking).map(issueText).join('; ')}` : 'no route from the asset held has a quote right now', 422);
      if (!pick.executable) throw new UserError('plan_not_startable', `this route cannot start: ${planView(pick, r.ctx).issues.filter((i) => i.blocking).map(issueText).join('; ')}`, 422);
      try { return docView(await savePlan(planReplan({ ...p, holding: { ...p.holding, amount: amount.toString() } }, plannedOf(pick), Date.now()), describe)); } catch (e) { throw new UserError('bad_state', (e as Error).message, 409); }
    });
  });
}

let advanceOne: ((p: PlanDoc) => Promise<PlanDoc>) | null = null;
/** Worker tick: every active plan whose current leg has a proposal. Only reads proposals and moves the plan; never signs. */
export async function advancePlans(): Promise<void> {
  if (!advanceOne) return;
  const rows = await sql<Row[]>`select * from plans where state = 'active' order by created_at`;
  for (const r of rows) { try { await locked(r.id, async () => advanceOne!(await loadPlan(r.id))); } catch (e) { console.log(`[worker] plan ${r.id}: ${(e as Error).message}`); } }
}
