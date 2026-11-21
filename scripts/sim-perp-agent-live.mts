/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/sim-perp-agent-live.mts
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

// The whole life of a LIVE perp agent, with the real pieces in one process: the real API (its routes, called over HTTP
// injection with an owner session), the real perp engine and live executor, the real live execution engine and mandate helpers,
// the REAL isolated signer class (its own venue reader, its own price port) and a software passkey producing real WebAuthn
// assertions, PostgreSQL (a scratch database, dropped and recreated).
//
//   npx tsx scripts/sim-perp-agent-live.mts
//       The venue is the scripted FAKE of the Hyperliquid exchange + info endpoints (services/api/test/hl-fake.ts). No network at
//       all: any outgoing request aborts the run. create agent → checklist → approve strategy → venue account → the venue's
//       refusal for an unfunded account → fund (fake) → authorise (passkey) → mandate derived from the agent's limits → ONE
//       passkey → LIVE → engine passes on scripted bars (long, flip to short over two passes, a signer refusal that holds the
//       bar) → pause/resume → stop → wind-down → flat → STOPPED.
//
//   npx tsx scripts/sim-perp-agent-live.mts --testnet
//       The venue is the real Hyperliquid TESTNET (api.hyperliquid-testnet.xyz, nothing else is reachable). The account is a
//       throwaway one and is NOT funded: the run stops at the venue's documented refusal for the authorization ("Must deposit
//       before performing actions") and prints the state of the agent page for that case. Nothing of value is sent.
//
// KEYS. The wallet seed is generated IN MEMORY (a fresh BIP-39 phrase), never printed, never written, gone when the process
// ends. No existing key, seed or secrets file is read. Never mainnet: api.hyperliquid.xyz is refused before any request leaves
// the process, and both mainnet settings are forced off (SPW_DERIV_LIVE_MAINNET, SPW_DERIV_MANDATE_MAINNET are deleted).
import { execSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const TESTNET = process.argv.includes('--testnet');
const DB = TESTNET ? 'spw_sim_perp_live_testnet' : 'spw_sim_perp_live', ORIGIN = 'https://wallet.test', BTC = 'hyperliquid:BTC';
const say = (s = '') => console.log(s);
const short = (x: string | null | undefined, n = 12) => (x ? `${x.slice(0, n)}…` : String(x));

// ---- the guard: nothing leaves the process, except (with --testnet) POSTs to the Hyperliquid TESTNET ------------------------
delete process.env.SPW_DERIV_LIVE_MAINNET; delete process.env.SPW_DERIV_MANDATE_MAINNET;
const net: Record<string, number> = {};
const realFetch = globalThis.fetch;
const guarded = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const ok = TESTNET && url.origin === 'https://api.hyperliquid-testnet.xyz' && (url.pathname === '/info' || url.pathname === '/exchange') && (init?.method ?? 'GET') === 'POST';
  if (!ok) throw new Error(`FORBIDDEN request in the simulation: ${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
  const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string; action?: { type?: string } };
  const key = `${url.host}${url.pathname} ${body.type ?? body.action?.type ?? '?'}`;
  net[key] = (net[key] ?? 0) + 1;
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = guarded;

execSync(`dropdb --if-exists ${DB} && createdb ${DB}`, { stdio: 'ignore' });
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: 'wallet.test', DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });

const { sql, migrate } = await import('../services/api/src/db.ts');
await migrate();
const { liveWorld, AUTH_POLICY } = await import('../services/api/test/perp-live-world.ts');
const { fixtureVenues } = await import('../services/api/test/derivatives-helpers.ts');
const mod = await import('../services/api/src/derivatives/index.ts');
await import('../services/api/src/agents/perp-strategies.ts');
const pl = await import('../services/api/src/agents/perp-live.ts');

const w = await liveWorld({ mnemonic: generateMnemonic(wordlist), ...(TESTNET ? { real: { fetch: guarded } } : {}) });
// market DATA of the agent's creation form (instrument list): recorded fixtures of the venue's public endpoints — no network
const dv = mod.createDerivatives({ registry: mod.createRegistry(fixtureVenues(w.clock as never).adapters, w.clock.now), now: w.clock.now });
const app = await (await import('../services/api/src/server.ts')).buildServer({ derivatives: dv, live: w.svc });
// the bars and the strategy's answers are scripted (the data gate and the laboratory have their own proofs: perp-agent.test.ts, sim-perp-agent.mts)
const H = 3_600_000, script = { bar: Math.floor(w.clock.now() / H) * H - H, weights: { BTC: 0.5 } as Record<string, number>, signals: 0 };
const rt = pl.createPerpRuntime(dv, { live: w.svc, gate: async () => ({ bar: script.bar, data: {} }), signal: async () => { script.signals += 1; return { weights: script.weights, maxLeverage: 2, maxGrossExposure: 2 }; } });
pl.setPerpRuntime(rt);

const token = randomBytes(32).toString('base64url');
await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '3 hours')`;
const cookie = `${(await import('../services/api/src/auth.ts')).COOKIE}=${token}`;
const api = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...(method === 'POST' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
  return { status: r.statusCode, json: r.json() as any };
};
const ok = async (method: 'GET' | 'POST', url: string, body?: unknown) => { const r = await api(method, url, body); if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };
const L = '/derivatives/live';
const checklist = (r: any) => `next = ${r.next} | strategy ${r.steps.strategy.ok ? '✓' : '✗'} · account ${r.steps.account.ok ? '✓' : `✗ (${r.steps.account.code})`} · funded ${r.steps.funded.ok ? '✓' : `✗ (${r.steps.funded.code})`} · mandate ${r.steps.mandate.ok ? '✓' : r.steps.mandate.lock ? `locked (${r.steps.mandate.lock.code})` : '✗'}`;
const page = async (id: string) => {
  const d = await ok('GET', `/agents/${id}`), v = d.live.account?.venueState;
  return `state ${d.state} · mode ${d.mode} · simulation ${d.simulation} · execution ${d.execution.kind}${d.execution.network ? `/${d.execution.network}` : ''} · live.active ${d.live.active}`
    + (v ? ` · venue equity ${v.state?.equity ?? 'unreadable'} · positions [${v.positions.map((p: any) => `${p.side} ${p.size} BTC`).join(', ')}] (source ${v.source})` : '')
    + (d.live.signer ? ` · signer today: ${d.live.signer.today.orders} order(s) adding exposure, ${d.live.signer.today.reduceOnly} reduce-only, turnover ${d.live.signer.today.turnover}; phase ${d.live.signer.phase}` : '')
    + (d.live.exit ? ` · exit ${d.live.exit.code}` : '') + (d.stopReason ? `\n      stop reason: ${d.stopReason}` : '');
};
const pass = async (id: string) => (await pl.perpEnginePass(rt, w.clock.now()))[id];
const signerCalls = () => `${w.orderSigns()} order signature(s), ${w.mandateSigns.length - w.orderSigns()} leverage signature(s), ${w.signs.length} passkey-path signature(s)`;

try {
  say(`=== LIVE perp agent — ${TESTNET ? 'REAL Hyperliquid TESTNET (unfunded throwaway account)' : 'scripted FAKE venue (no network)'} — real API, real engine, real signer class, throwaway in-memory seed ===`);
  say(`    wallet account ${w.ACCOUNT} (derived from a seed generated in memory); mainnet settings: SPW_DERIV_LIVE_MAINNET=${process.env.SPW_DERIV_LIVE_MAINNET ?? '(unset)'}, SPW_DERIV_MANDATE_MAINNET=${process.env.SPW_DERIV_MANDATE_MAINNET ?? '(unset)'}`);
  await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });

  // 1 — the agent, in simulation
  const agent = await ok('POST', '/agents', { kind: 'perp', name: 'Sim live', instruments: ['BTC'], interval: '1h', capitalUsdc: '1000', risk: { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 } });
  const id = agent.id as string;
  say(`\n[1] perp agent created in simulation: ${id} (BTC, 1h, 2× max). ${await page(id)}`);
  say(`    checklist: ${checklist(await ok('GET', `/agents/${id}/perp/live?locale=fr`))}`);

  // 2 — an approved strategy version (its hash is what the mandate pins)
  const sv = randomUUID(), sha = createHash('sha256').update(`sim-live-${id}`).digest('hex');
  await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, report) values (${sv}, ${id}, 'sim_fixed_perp', '1', ${sha}, 'strategies/sim_fixed_perp/1', ${sql.json({ kind: 'perp', lookback: 10, max_leverage: 2, max_gross_exposure: 2 })},
    ${sql.json({ schema_version: 2, kind: 'perp', strategy_sha256: sha, config: { symbols: ['BTC'], start: '2026-04-16T20:00:00+00:00', end: '2026-11-11T03:00:00+00:00' }, checks: { lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass', data_quality: 'pass', notes: [] },
      liquidations: { train: [], validation: [], test: [] }, robustness: {}, metrics: {} })})`;
  await ok('POST', `/agents/${id}/strategies/${sv}/approve`);
  say(`\n[2] strategy version approved through the API (code hash ${short(sha)}; its signals are scripted in this run).`);
  say(`    checklist: ${checklist(await ok('GET', `/agents/${id}/perp/live?locale=fr`))}`);

  // 3 — the owner's part in Futures → Accounts: a venue account, then the authorization (passkey)
  const acct = (await ok('POST', `${L}/accounts`, { venue: 'hyperliquid', network: 'testnet', label: 'Testnet' })).id as string;
  say(`\n[3] venue account created (testnet, READ_ONLY): ${acct}`);
  say(`    checklist: ${checklist(await ok('GET', `/agents/${id}/perp/live?locale=fr`))}`);
  const authorise = async () => {
    const prep = await ok('POST', `${L}/accounts/${acct}/authorization/prepare`, { policy: AUTH_POLICY, days: 30, locale: 'fr' });
    return api('POST', `${L}/accounts/${acct}/authorization/approve`, { assertion: w.pk.assert(w.b64(prep.hash)), acknowledged: true });
  };
  const first = await authorise();
  say(`    authorization approved with the passkey on an UNFUNDED account → ${first.status} ${first.json.error}: ${String(first.json.message).slice(0, 230)}`);
  const unfunded = await ok('GET', `/agents/${id}/perp/live?locale=fr`);
  say(`    checklist: ${checklist(unfunded)}`);
  say(`      account step: ${unfunded.steps.account.reason}`);
  say(`      funded step: ${unfunded.steps.funded.reason} (minimum ${unfunded.steps.funded.minEquity} USDC = max(${unfunded.steps.funded.basis.floor}, ${unfunded.steps.funded.basis.ordersPerPosition} minimum orders × ${unfunded.steps.funded.basis.instruments.map((i: any) => `${i.minOrder} USD on ${i.instrument}`).join(' + ')} ÷ ${unfunded.steps.funded.basis.grossX}× gross))`);
  const early = await api('POST', `/agents/${id}/perp/live/prepare`, { accountId: acct, locale: 'fr' });
  say(`    "go live" now → ${early.status} ${early.json.error}: ${String(early.json.message).slice(0, 200)}`);
  say(`    agent page: ${await page(id)}`);

  if (TESTNET) {
    say('\n[4] --testnet: the account is not funded, so the run stops here, at the venue\'s documented refusal. To go further the owner funds');
    say(`    ${w.ACCOUNT} on the testnet (mock USDC, "USDC (Perps)") — with a seed he keeps — and authorises the account in Futures → Comptes.`);
  } else {
    // 4 — funded (on the fake), authorised, then the mandate: derived from the agent's limits, ONE passkey
    w.t.fund(w.ACCOUNT, '1000');
    const second = await authorise();
    say(`\n[4] the fake venue account is funded with 1 000 USDC; authorization approved with the passkey → ${second.status}, mode ${second.json.mode}, modes ${JSON.stringify(second.json.modes)}`);
    const ready = await ok('GET', `/agents/${id}/perp/live?locale=fr`);
    say(`    checklist: ${checklist(ready)}`);
    for (const d of ready.proposal.derived) say(`      ${String(d.field).padEnd(20)} ${String(d.value).padEnd(18)} ← ${d.from}`);
    const prep = await ok('POST', `/agents/${id}/perp/live/prepare`, { accountId: acct, locale: 'fr' });
    say(`    mandate prepared: hash ${short(prep.hash, 16)}, expires ${new Date(prep.mandate.expiresAt * 1000).toISOString()}, strategy ${short(prep.mandate.strategySha256)}, agent ${prep.mandate.agentId}`);
    say(`      shown before the passkey: warning "${prep.warning.slice(0, 80)}…", acknowledgement (${prep.acknowledgement.text.length} chars, ${prep.acknowledgement.locale}), ${prep.enforcedBySigner.length} lines enforced by the signer, ${prep.trustedBySigner.length} trusted, ${prep.notEnforced.length} not enforced, wind-down text`);
    const noAck = await api('POST', `/agents/${id}/perp/live/approve`, { accountId: acct, assertion: w.pk.assert(w.b64(prep.hash)), acknowledged: false });
    say(`      without the acknowledgement checkbox → ${noAck.status} ${noAck.json.error}`);
    const live = await ok('POST', `/agents/${id}/perp/live/approve`, { accountId: acct, assertion: w.pk.assert(w.b64(prep.hash)), acknowledged: true });
    say(`    ONE passkey → state ${live.state}, mode ${live.mode}, network ${live.live.network}, reference capital ${live.live.capital} USDC; signer holds ${w.signer.status().venueMandates.length} mandate (phase ${w.signer.status().venueMandates[0]!.phase}); requests to the venue\'s exchange endpoint so far: ${w.t.exchangeCalls()} (the two approveAgent of the authorizations: one refused, one accepted — going live sends nothing)`);

    // 5 — engine passes on scripted bars
    const bar = (weights: Record<string, number>) => { script.bar += H; script.weights = weights; w.next(); };
    say(`\n[5] bar 1 — signal BTC +0.5: ${await pass(id)}`);
    say(`    ${await page(id)}`);
    say(`    venue leverage setting of BTC: ${JSON.stringify(w.t.user(w.ACCOUNT).leverage.get('BTC'))} (was the venue's default 20× cross); signer: ${signerCalls()}`);
    w.next(); say(`    same bar, a minute later: ${await pass(id)} (signals asked: ${script.signals}; signer: ${signerCalls()})`);
    bar({ BTC: -0.5 });
    say(`\n[6] bar 2 — signal BTC −0.5 (a flip): ${await pass(id)}`);
    say(`    ${await page(id)}`);
    w.next(); say(`    next pass, a minute later: ${await pass(id)}`);
    say(`    ${await page(id)}`);
    // a signer refusal: an order rests on the venue that the wallet did not place — the signer counts it in the worst-case position
    const foreign = w.t.foreignOrder(w.ACCOUNT, { side: 'A', px: '80000', sz: '0.01' });
    bar({ BTC: -1 });
    say(`\n[7] bar 3 — signal BTC −1 while a foreign sell order of 0.01 BTC rests on the venue account: ${await pass(id)}`);
    const d7 = await ok('GET', `/agents/${id}`);
    say(`    refusal shown on the agent page: ${d7.live.holds[0]?.code} — ${String(d7.live.holds[0]?.reason).slice(0, 170)}`);
    const before = w.orderSigns();
    for (let k = 0; k < 3; k++) { w.next(); await pass(id); }
    say(`    three more passes on that bar: ${w.orderSigns() - before} more request(s) to the signer; state ${(await ok('GET', `/agents/${id}`)).state}`);
    w.t.removeOrder(w.ACCOUNT, foreign);

    // 6 — pause, resume
    const paused = await ok('POST', `/agents/${id}/perp/live/pause`, {});
    bar({ BTC: 0.5 });
    say(`\n[8] pause → state ${paused.state}; a new bar (signal +0.5) while paused: ${await pass(id)}`);
    const resumed = await ok('POST', `/agents/${id}/perp/live/resume`, {});
    say(`    resume → state ${resumed.state}`);

    // 7 — stop: no passkey; the book is thin, so the close takes two passes of the wind-down
    w.next(); w.t.asks = [['70005', '0.004']];
    const stop = await ok('POST', `/agents/${id}/perp/live/stop`, { locale: 'fr' });
    say(`\n[9] "Arrêter" (no passkey) with a thin book → state ${stop.state}: ${stop.result}`);
    say(`    wind-down until ${new Date(stop.windDown.until).toISOString()}; signer mandate: revoked ${w.signer.status().venueMandates[0]!.revoked}, phase ${w.signer.status().venueMandates[0]!.phase}`);
    w.t.asks = [['70005', '1']]; bar({ BTC: 1 });
    say(`    next pass (a new bar whose signal wants +1): ${await pass(id)}`);
    say(`    ${await page(id)}`);
    const orders = await sql`select side, reduce_only, state, size::text, filled::text, origin from deriv_orders where account_id = ${acct} order by created_at, nonce`;
    say(`\n[10] orders of the venue account (${orders.length}): ${orders.map((o: any) => `${o.side}${o.reduce_only ? ' RO' : ''} ${o.filled}/${o.size} ${o.state} (${o.origin})`).join(' · ')}`);
    say(`    venue position now: ${w.t.user(w.ACCOUNT).positions.get('BTC')?.szi ?? '0'} BTC; exchange requests on the fake testnet: ${['approveAgent', 'updateLeverage', 'order', 'cancel', 'cancelByCloid'].map((t) => `${t} ${w.t.exchangeCalls(t)}`).join(', ')}; on the fake mainnet: ${w.m.calls.length}`);
    say(`    signer: ${signerCalls()}; signals asked: ${script.signals}`);
    say(`    checklist afterwards: ${checklist(await ok('GET', `/agents/${id}/perp/live?locale=fr`))}`);
  }
  say(`\nreal network requests: ${Object.keys(net).length ? Object.entries(net).map(([k, n]) => `${k} ×${n}`).join(', ') : 'none'}; to api.hyperliquid.xyz (mainnet): ${Object.entries(net).filter(([k]) => k.startsWith('api.hyperliquid.xyz')).reduce((n, [, c]) => n + c, 0)}`);
} finally {
  pl.setPerpRuntime(null);
  await app.close().catch(() => {});
  await sql.end({ timeout: 2 }).catch(() => {});
}
