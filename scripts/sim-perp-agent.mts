/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/sim-perp-agent.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// The whole life of a PERP agent in simulation, against the REAL Hyperliquid public data (read-only): real API in-process on a
// scratch database, real venue candles / funding / tickers / books, the real laboratory (describe, backtest, signal), the real
// derivatives risk engine and paper engine. Nothing is signed, no signer is reachable, no trading endpoint is called: every
// outgoing request of the process goes through a guard that only lets `POST https://api.hyperliquid.xyz/info` pass and aborts
// on anything else.
//
//   create a perp agent (BTC, ETH) → library (spot and perp listings stay apart) → register + backtest a library perp strategy
//   and a test strategy with fixed signed weights → approve → engine passes on the last closed bar: the library strategy's own
//   signal, then long + short positions against the live book → same bar again (nothing) → rebalance with a flip → a funding
//   payment → the loss-limit path (limits lowered) → the final account.
//
//   SIM_DB (default spw_sim_perp)   scratch database, dropped and recreated
//   SIM_CAPITAL (default 10000)     simulated collateral, USDC
// The test strategy is written to research/strategies/zz_perptest (git-ignored) and removed at the end.
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
const DB = process.env.SIM_DB ?? 'spw_sim_perp', CAPITAL = process.env.SIM_CAPITAL ?? '10000', ORIGIN = 'https://wallet.test';
if (!/^[a-z0-9_]+$/.test(DB) || !/^\d{3,7}$/.test(CAPITAL)) throw new Error('bad SIM_DB or SIM_CAPITAL');
const STRAT = join(import.meta.dirname, '../research/strategies/zz_perptest');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => console.log(s);

// ---- the guard: the only thing this process may reach is the venue's public info endpoint ---------------------------------
const seen: Record<string, number> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== 'api.hyperliquid.xyz' || url.pathname !== '/info' || (init?.method ?? 'GET') !== 'POST') throw new Error(`FORBIDDEN request in the simulation: ${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
  const type = String((JSON.parse(String(init?.body ?? '{}')) as { type?: string }).type);
  seen[type] = (seen[type] ?? 0) + 1;
  return realFetch(input, init);
}) as typeof fetch;

const writeStrategy = (version: string, btc: number, eth: number) => {
  mkdirSync(join(STRAT, version), { recursive: true });
  writeFileSync(join(STRAT, version, 'strategy.py'), `"""Simulation-test strategy: constant SIGNED target weights (fractions of equity, negative = short). Not a trading rule."""
META = {
    "name": "zz_perptest",
    "version": "${version}",
    "kind": "perp",
    "universe": ["BTC", "ETH"],
    "interval": "1h",
    "lookback": 300,
    "max_leverage": 2.0,
    "max_gross_exposure": 2.0,
    "params": {"btc": ${btc}, "eth": ${eth}},
}


def target_weights(data, params):
    return {"BTC": float(params["btc"]), "ETH": float(params["eth"])}
`);
};

let app: any, sql: any;
const cleanup = async () => { rmSync(STRAT, { recursive: true, force: true }); await app?.close().catch(() => {}); await sql?.end().catch(() => {}); };
try {
  execSync(`dropdb --if-exists ${DB} && createdb ${DB}`);
  // the signer URL points at a closed port AND the guard refuses it: a signer call would abort the run
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: 'wallet.test', DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: 's'.repeat(48), SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db = await import('../services/api/src/db.ts'); sql = db.sql; await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '3 hours')`;
  const cookie = `${(await import('../services/api/src/auth.ts')).COOKIE}=${token}`;
  const deriv = (await import('../services/api/src/derivatives/index.ts')).createDerivatives();
  app = await (await import('../services/api/src/server.ts')).buildServer({ swapProviders: [], derivatives: deriv });
  const pl = await import('../services/api/src/agents/perp-live.ts'), wk = await import('../services/api/src/derivatives/worker.ts'), { D } = await import('@spw/derivatives');
  const rt = pl.perpRuntime();
  const api = async (method: string, url: string, body?: unknown) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}) }, ...(method !== 'GET' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    return { status: r.statusCode as number, json: (() => { try { return r.json(); } catch { return null; } })() }; };
  const ok = async (method: string, url: string, body?: unknown) => { const r = await api(method, url, body); if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const pass = async () => Object.values(await pl.perpEnginePass(rt)).at(-1);
  const f2 = (x: unknown) => (x === null || x === undefined ? '—' : Number(x).toFixed(2)), pct = (x: unknown) => (typeof x === 'number' ? `${(100 * x).toFixed(2)} %` : '—');

  say(`simulation at ${new Date().toISOString()} — scratch database ${DB}, simulated capital ${CAPITAL} USDC, venue data: Hyperliquid mainnet public info endpoint (read-only)`);

  // 0 — what a perp agent can be built from
  const ven = await ok('GET', '/agents/perp/venues'), insts = ven.venues[0].instruments as any[];
  say(`\n[0] venue ${ven.venues[0].name} (${ven.venues[0].network}): ${insts.length} perpetuals listed, ${insts.filter((x) => x.eligible).length} eligible for a perp agent (up to ${ven.maxInstruments}); live trading available: ${ven.live.available}`);
  say(`    most traded: ${insts.slice(0, 6).map((x) => `${x.symbol} (max ${x.maxLeverage}x, lot ${x.lotSize}, mark ${x.mark})`).join(', ')}`);
  say(`    not eligible, for example: ${insts.filter((x) => !x.eligible).slice(0, 3).map((x) => `${x.symbol} — ${x.why}`).join('; ') || 'none'}`);

  // 1 — the two libraries never mix
  writeStrategy('1', 0.5, -0.4); writeStrategy('2', -0.3, -0.6);
  const spotLib = (await ok('GET', '/strategies')).strategies as any[], perpLib = (await ok('GET', '/strategies?kind=perp')).strategies as any[];
  say(`\n[1] spot library: ${spotLib.length} versions, of which perpetual-futures strategies: ${spotLib.filter((x) => x.meta.kind === 'perp' || /_perp$|zz_perptest/.test(x.meta.name)).length}`);
  say(`    perp library (--contract 2): ${perpLib.length} versions: ${perpLib.map((x) => `${x.meta.name}/${x.meta.version}${x.spotLegs ? ' [spot legs: not for perp agents]' : ''}`).join(', ')}`);
  if (spotLib.some((x) => x.meta.kind === 'perp') || perpLib.some((x) => x.kind !== 'perp') || !perpLib.length) throw new Error('the libraries are mixed');

  // 2 — the agent: one venue, two instruments, one interval, its own paper account, the owner's limits
  const RISK = { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 };
  const ag = await ok('POST', '/agents', { kind: 'perp', name: 'Sim perp agent', mission: 'simulation run', instruments: ['BTC', 'ETH'], interval: '1h', capitalUsdc: CAPITAL, risk: RISK });
  const id = ag.id as string, acct = ag.accountId as string;
  let d = await ok('GET', `/agents/${id}`);
  say(`\n[2] perp agent ${id} (${ag.kind}, simulation: ${ag.simulation}) on ${ag.venue}: ${ag.instruments.join(', ')}, interval ${ag.interval}, vault "${ag.vaultAddress}" (none), mandate ${ag.mandateId}`);
  say(`    paper account ${acct}: collateral ${d.account.state.collateral} USDC, mode ${d.account.policy.mode}`);
  say(`    risk policy fed to the derivatives risk engine: leverage ≤ ${d.account.policy.maxLeverage}x, gross ≤ ${d.account.policy.maxGrossExposure}, position ≤ ${d.account.policy.maxPositionNotional}, order ≤ ${d.account.policy.maxOrderNotional}, daily loss ≤ ${d.account.policy.maxDailyLoss}, total loss ≤ ${d.account.policy.maxTotalLoss}, min free collateral ${d.account.policy.minFreeCollateral}, liquidation distance ≥ ${d.account.policy.minLiquidationDistanceBps} bps, instruments ${d.account.policy.allowedInstruments.join(' ')}`);
  for (const r of ['mandate/prepare', 'revoke']) { const x = await api('POST', `/agents/${id}/${r}`); say(`    POST /agents/:id/${r} → ${x.status} ${x.json?.error}`); if (x.status !== 409) throw new Error('a vault/mandate route answered for a perp agent'); }

  // 3 — strategies: registered by path, pinned by hash, backtested on the venue's own data (pre-fetched here, the laboratory stays offline)
  const wrong = await api('POST', `/agents/${id}/strategies`, { path: 'ts_momentum/3' });
  say(`\n[3] a spot strategy offered to the perp agent → ${wrong.status} ${wrong.json?.error}`);
  const wrongU = await api('POST', `/agents/${id}/strategies`, { path: 'ts_momentum_perp/1' });
  say(`    a perp strategy written for other instruments → ${wrongU.status} ${wrongU.json?.error}: ${String(wrongU.json?.message).slice(0, 110)}`);
  const legs = await api('POST', `/agents/${id}/strategies`, { path: 'funding_carry_neutral_perp/1' });
  say(`    a perp strategy with spot legs → ${legs.status} ${legs.json?.error}`);
  if (wrong.status === 200 || wrongU.status === 200 || legs.status === 200) throw new Error('a strategy that does not fit was accepted');
  const t0 = Date.now();
  const reg: Record<string, any> = {};
  for (const p of ['pairs_coint_perp/1', 'zz_perptest/1', 'zz_perptest/2']) reg[p] = await ok('POST', `/agents/${id}/strategies`, { path: p });
  const early = await api('POST', `/agents/${id}/strategies/${reg['zz_perptest/1'].id}/approve`);
  say(`    registered ${Object.entries(reg).map(([p, r]) => `${p} (sha256 ${r.sha256.slice(0, 12)}…, ${r.status})`).join(', ')}; approval before the report → ${early.status} ${early.json?.error}`);
  let versions: any[] = [];
  for (let k = 0; k < 1500; k++) {
    versions = (await ok('GET', `/agents/${id}`)).versions;
    if (versions.every((v) => v.summary || (v.status === 'draft' && v.notes))) break;
    await sleep(2000);
  }
  say(`    backtests done in ${Math.round((Date.now() - t0) / 1000)} s; store budget used now ${rt.store.budget.used()}/${rt.store.budget.limit} weight per minute; venue requests so far: ${JSON.stringify(seen)}`);
  const stored = await sql`select symbol, count(*)::int as bars, min(ts) as lo, max(ts) as hi from perp_candles group by symbol order by symbol`;
  const fstored = await sql`select symbol, count(*)::int as n from perp_funding group by symbol order by symbol`;
  say(`    stored venue history: ${stored.map((r: any) => `${r.symbol} ${r.bars} closed 1h bars ${r.lo.toISOString().slice(0, 13)}h → ${r.hi.toISOString().slice(0, 13)}h`).join('; ')}; funding settlements: ${fstored.map((r: any) => `${r.symbol} ${r.n}`).join(', ')}`);
  for (const v of [...versions].reverse()) {
    const s = v.summary;
    if (!s) throw new Error(`${v.name}/${v.version}: no report — ${v.notes}`);
    say(`    ── ${v.name}/${v.version}  report v${s.schemaVersion}, ${s.config.bars} bars = ${s.historyDays} days (${String(s.config.start).slice(0, 10)} → ${String(s.config.end).slice(0, 10)}), costs ${s.config.fee_bps} bps fee + ${s.config.slippage_bps} bps slippage, liquidation penalty ${s.config.liquidation_penalty_bps} bps, funding priced on: ${s.config.funding_reference_price}`);
    say(`       test split ${String(s.splits.test[0]).slice(0, 10)} → ${String(s.splits.test[1]).slice(0, 10)}: return ${pct(s.metrics.test.total_return)}, Sharpe ${f2(s.metrics.test.sharpe)} (bootstrap 95 % interval ${s.robustness.bootstrap_sharpe_ci?.map(f2).join(' … ')}), max drawdown ${pct(s.metrics.test.max_drawdown)}, worst intrabar ${pct(s.metrics.test.worst_intrabar_drawdown)}, ${s.metrics.test.trades} trades, fees ${f2(s.metrics.test.fees_paid)}, funding ${f2(s.metrics.test.funding_pnl)}`);
    say(`       benchmarks on the test split: ${s.buyAndHoldIsSpot ? 'spot' : 'perp price (no spot candles supplied)'} buy & hold ${pct(s.benchmarks.buy_and_hold?.total_return)}, perp long 1x ${pct(s.benchmarks.perp_long_1x?.total_return)}`);
    say(`       caveats: liquidations in the backtest train/validation/test = ${s.liquidations.train}/${s.liquidations.validation}/${s.liquidations.test}, wiped out on test: ${s.metrics.test.wiped_out}; trials tested ${s.robustness.trials_tested}, deflated Sharpe ${typeof s.robustness.deflated_sharpe === 'number' ? s.robustness.deflated_sharpe.toFixed(4) : '—'} (below 0.95: "no skill" is not rejected); checks ${JSON.stringify(s.checks)}; approvable: ${s.problem === null ? 'yes' : `NO — ${s.problem}`}`);
  }
  const ver = (path: string) => versions.find((v) => v.id === reg[path].id);

  // 4 — the library strategy on the last closed bar: its own signal, whatever it says
  const show = async (title: string) => {
    d = await ok('GET', `/agents/${id}`);
    const s = d.signals[0];
    say(`    ${title}: bar ${new Date(s.bar).toISOString().slice(0, 16)}Z, decision "${s.status}"${s.reason ? ` (${s.reason})` : ''}, weights ${JSON.stringify(s.weights)}${s.scale ? `, scale ${s.scale} (${s.orders?.binding}), equity ${Number(s.equity).toFixed(2)}, targets ${JSON.stringify(s.targets)}` : ''}`);
    for (const o of s.orders?.list ?? []) say(`      order ${o.symbol} ${o.side} ${o.size}${o.reduceOnly ? ' reduce-only' : ''} [${o.reason}] → ${o.status}${o.filled ? `, filled ${o.filled} @ ${Number(o.avgFillPrice).toFixed(2)} (worst acceptable ${o.worstPrice})` : ''}${o.why ? ` — ${o.why}` : ''}`);
    say(`      positions: ${d.account.positions.map((p: any) => `${p.instrument} ${p.side.toUpperCase()} ${p.size} @ ${Number(p.entryPrice).toFixed(2)}, mark ${p.markPrice}, leverage ${p.leverage}x, liq. estimate ${p.liquidationPrice ?? 'none'}, uPnL ${Number(p.unrealizedPnl).toFixed(2)}`).join(' | ') || 'none'}`);
    say(`      account: equity ${Number(d.account.state.equity).toFixed(2)}, collateral ${Number(d.account.state.collateral).toFixed(2)}, margin used ${Number(d.account.state.marginUsed).toFixed(2)}, fees paid ${Number(d.account.totals.feesPaid).toFixed(4)}, funding net ${d.account.totals.fundingNet}`);
  };
  /** SIMULATION ONLY: let the newly approved version decide the same closed bar again (in production it decides at the next bar) */
  const redecide = async () => { await sql`delete from perp_agent_signals where agent_id = ${id}`; await sql`update agents set last_bar = null where id = ${id}`; };
  await ok('POST', `/agents/${id}/strategies/${ver('pairs_coint_perp/1').id}/approve`);
  await ok('POST', `/agents/${id}/mode`, { mode: 'PAPER' });
  say(`\n[4] library strategy pairs_coint_perp/1 approved, paper trading started; engine pass: ${await pass()}`);
  await show('pairs_coint_perp/1');
  say(`    same bar again: ${await pass()}`);

  // 5 — fixed signed weights: a long and a short opened against the live book
  await ok('POST', `/agents/${id}/strategies/${ver('zz_perptest/1').id}/approve`); await redecide();
  const before5 = (await sql`select count(*)::int as n from deriv_orders where account_id = ${acct}`)[0].n as number;
  const book = async (sym: string) => { const m = await rt.deps.market(sym); return `${sym} mark ${m.ticker.mark}, index ${m.ticker.index}, best bid ${m.book.bids[0]?.[0]} × ${m.book.bids[0]?.[1]}, best ask ${m.book.asks[0]?.[0]} × ${m.book.asks[0]?.[1]}`; };
  say(`\n[5] test strategy zz_perptest/1 approved (BTC +0.5, ETH −0.4 of equity). Live book: ${await book('BTC')}; ${await book('ETH')}`);
  say(`    engine pass: ${await pass()}`);
  await show('zz_perptest/1');
  if (d.account.positions.length !== 2 || !d.account.positions.some((p: any) => p.side === 'long') || !d.account.positions.some((p: any) => p.side === 'short')) throw new Error('expected one long and one short position');
  say(`    same bar again: ${await pass()} (one decision per bar)`);
  const step1 = await wk.paperStep(deriv.paper);
  say(`    paper worker step: ${step1.fed} account fed, ${step1.fills} fill(s), ${step1.funding} funding payment(s), ${step1.liquidations} liquidation(s), ${step1.halts} halt(s)`);

  // 6 — rebalance with a flip: BTC long → short (close, then open), ETH short increased
  await ok('POST', `/agents/${id}/strategies/${ver('zz_perptest/2').id}/approve`); await redecide();
  say(`\n[6] rebalance — zz_perptest/2 approved (BTC −0.3, ETH −0.6). engine pass: ${await pass()}`);
  await show('zz_perptest/2');
  const ords = await sql`select instrument, side, reduce_only, status, size::text, avg_fill_price::text, origin from deriv_orders where account_id = ${acct} order by created_at, venue_order_id`;
  say(`    every order of the account, in order: ${ords.map((o: any) => `${o.instrument.split(':')[1]} ${o.side} ${o.size}${o.reduce_only ? ' RO' : ''} ${o.status} (${o.origin})`).join(' → ')}`);
  const btc = ords.slice(before5).filter((o: any) => o.instrument.endsWith(':BTC')), [c1, c2] = btc.slice(-2);
  if (!(c1 && c2 && c1.reduce_only && c1.side === 'sell' && c1.status === 'filled' && !c2.reduce_only && c2.side === 'sell')) throw new Error('the BTC flip was not close-then-open');

  // 7 — funding. The venue settles on the hour; to show a payment without waiting for the next hour the account's funding cursor is
  //     moved back one hour (as if the positions had been held through the last settlement). The rate applied is the venue's own.
  const [row] = await sql`select meta from deriv_paper_accounts where id = ${acct}`;
  const cur = Object.fromEntries(Object.entries(row.meta.fundingCursor as Record<string, number>).map(([k, t]) => [k, t - 3_600_000]));
  await sql`update deriv_paper_accounts set meta = jsonb_set(meta, '{fundingCursor}', ${sql.json(cur)}::jsonb) where id = ${acct}`;
  const step2 = await wk.paperStep(deriv.paper);
  const fund = await sql`select instrument, ts, amount::text, rate::text, size::text from deriv_funding where account_id = ${acct} order by instrument`;
  say(`\n[7] simulated funding application (cursor moved back one hour; the venue's published rate of that settlement): worker applied ${step2.funding} payment(s)${step2.errors.length ? `, errors: ${step2.errors.join('; ')}` : ''}`);
  for (const f of fund) say(`      ${f.instrument} settlement ${f.ts.toISOString().slice(0, 16)}Z: rate ${f.rate} per hour on size ${f.size} → ${Number(f.amount) >= 0 ? 'received' : 'paid'} ${Math.abs(Number(f.amount)).toFixed(6)} USDC (a short receives a positive rate)`);
  if (fund.length < 2) throw new Error('expected one funding payment per position');

  // 8 — the loss-limit path: the owner lowers the limits below what fees and slippage already cost → flatten (reduce-only), then stop
  d = await ok('GET', `/agents/${id}`);
  const lost = D.sub(D.from(CAPITAL), D.from(d.account.state.equity));
  say(`\n[8] loss so far: ${D.toNumber(lost).toFixed(4)} USDC (fees, spread, funding, price moves). The owner lowers both loss limits to 0.01 % of the capital`);
  const lowered = await ok('POST', `/agents/${id}/perp/risk`, { risk: { ...RISK, maxDailyLossPct: 0.01, maxTotalLossPct: 0.01 } });
  const pol = (await ok('GET', `/agents/${id}`)).account.policy;
  say(`    agent limits now ${lowered.risk.maxDailyLossPct} % / ${lowered.risk.maxTotalLossPct} %; account policy maxDailyLoss ${pol.maxDailyLoss}, maxTotalLoss ${pol.maxTotalLoss} USDC`);
  let res = '';
  for (let k = 0; k < 6; k++) { res = String(await pass()); say(`    engine pass: ${res}`); if (res.startsWith('stopped')) break; await sleep(61_000); }
  d = await ok('GET', `/agents/${id}`);
  if (d.state !== 'STOPPED' || d.account.positions.length) throw new Error('the loss limit did not flatten and stop the agent');
  say(`    state ${d.state}; reason: ${d.stopReason}`);
  const closes = (await sql`select instrument, side, reduce_only, status, size::text, avg_fill_price::text from deriv_orders where account_id = ${acct} and client_id like ${'ag-' + id + '-x%'} order by created_at, venue_order_id`);
  say(`    closing orders: ${closes.map((o: any) => `${o.instrument.split(':')[1]} ${o.side} ${o.size} reduce-only:${o.reduce_only} ${o.status} @ ${Number(o.avg_fill_price).toFixed(2)}`).join('; ')}`);
  say(`    engine pass after the stop: ${JSON.stringify(await pl.perpEnginePass(rt))} (a stopped agent is not ticked)`);

  // 9 — the final account
  const n = async (t: string) => (await sql.unsafe(`select count(*)::int as n from ${t} where account_id = $1`, [acct]))[0].n as number;
  say(`\n[9] final paper account: collateral ${d.account.state.collateral} USDC, equity ${d.account.state.equity}, positions ${d.account.positions.length}, open orders ${d.account.openOrders.length}`);
  say(`    totals: realised PnL ${d.account.totals.realizedPnl}, fees ${d.account.totals.feesPaid}, funding ${d.account.totals.fundingNet}, liquidations ${d.account.totals.liquidations}; result ${D.str(D.sub(D.from(d.account.state.equity), D.from(CAPITAL)))} USDC on ${CAPITAL}`);
  say(`    rows: ${await n('deriv_orders')} orders, ${await n('deriv_fills')} fills, ${await n('deriv_funding')} funding payments, ${await n('deriv_risk_events')} risk events, ${await n('deriv_equity')} equity points; agent signal log ${d.signals.length} row(s), log: ${d.log.map((l: any) => l.title).join(' | ')}`);
  const identity = D.add(D.add(D.sub(D.from(CAPITAL), D.from(d.account.totals.feesPaid)), D.from(d.account.totals.realizedPnl)), D.from(d.account.totals.fundingNet));
  say(`    ledger identity: capital − fees + realised PnL + funding = ${D.str(identity)} ${D.eq(identity, D.from(d.account.state.collateral)) ? '= collateral (exact)' : '≠ collateral'}`);
  if (!D.eq(identity, D.from(d.account.state.collateral))) throw new Error('the account does not reconcile');
  const audits = await sql`select type, count(*)::int as n from audit_events group by type order by type`;
  say(`    audit chain: ${audits.map((a: any) => `${a.type}×${a.n}`).join(', ')}`);
  say(`\nvenue requests of the whole run, by info type (all POST https://api.hyperliquid.xyz/info): ${JSON.stringify(seen)}`);
  say('no request to any other host, no /exchange request, no signer call: the guard would have aborted the run.');
  await cleanup();
  say('SIM OK');
  process.exit(0);
} catch (e) { console.error('SIM FAILED:', (e as Error).message); await cleanup(); process.exit(1); }
