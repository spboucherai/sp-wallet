// Any-to-any plan proof on TWO LOCAL FORKS (anvil): Arbitrum and Base. Nothing reaches a real network; the wallet seed, the
// passkey and the attester keys are fresh random test keys generated in memory.     node scripts/fork-plan.mts
//
// What is REAL: the API (its own process: server, providers, worker steps, plan saga, alerts dispatcher), the isolated signer
// behind its HMAC channel, a passkey assertion for EVERY leg, KyberSwap's live quotes and calldata, Circle's live fee schedule,
// and the real bytecode of the KyberSwap router, USDC, LINK, cbBTC and Circle's CCTP contracts as forked from mainnet.
// What is SIMULATED (as in scripts/fork-cctp.mts): a burn made on a fork is unknown to Circle, so on the Base fork two TEST
// attester keys are enabled through the impersonated attester manager and a local stand-in signs the fork's MessageSent bytes.
// Balances are given to the throwaway wallet by writing storage slots on the forks.
//
//   A  planning: capabilities, Solana ↔ EVM said not executable, limits exceeded on a leg, missing gas named per network
//   B  a full 3-leg plan  LINK (Arbitrum) → USDC → [CCTP] → USDC (Base) → cbBTC (Base), passkey per leg, planned vs actual —
//      with a process RESTART between legs 1 and 2, the attestation of leg 2 DELAYED, and leg 3 REFUSED at the last gate after
//      the fork's market moved away from the quote (plan paused, re-planned from USDC on Base, completed)
//   C  an overall floor that stops a plan between two legs; "stop here" leaves the funds as an ordinary balance
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encodeFunctionData, erc20Abi, formatUnits, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { cctpUsdc, KYBER_ROUTER, NETWORKS } from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';
import { balanceOf, dealToken, enableTestAttesters, mine, setNative, startForks, startTestIris, type Forks } from './lib/fork-helpers.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'arbitrum', DST = 'base', PORT = Number(process.env.FORK_PLAN_PORT ?? 8571), DB = process.env.FORK_PLAN_DB ?? 'spw_fork_plan';
const ORIGIN = `http://localhost:${PORT}`, RP = 'localhost', SECRET = 'p'.repeat(48), SETUP = 'fork-plan-setup';
const keys = deriveKeys(generateMnemonic(wordlist, 128)), ME = keys.addresses.evm;                              // fresh throwaway wallet
const tok = (n: string, s: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === s)!;
const LINK = tok(SRC, 'LINK'), CBBTC = tok(DST, 'cbBTC'), USDC_A = cctpUsdc(SRC).id, USDC_B = cctpUsdc(DST).id;
const say = (s: string) => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let forks: Forks | undefined, signerSrv: Server | undefined, irisSrv: Server | undefined, child: ChildProcess | undefined;
const cleanup = () => { child?.kill('SIGKILL'); forks?.kill(); signerSrv?.close(); irisSrv?.close(); };
process.on('exit', cleanup);

let cookie = '';
async function api(method: string, path: string, body?: unknown, idem?: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const set = r.headers.getSetCookie?.()[0]; if (set) cookie = set.split(';')[0]!;
  return { status: r.status, json: await r.json().catch(() => null) };
}
let childEnv: Record<string, string> = {};
async function startApi(fresh: boolean): Promise<number> {
  child = spawn(process.execPath, [...process.execArgv, join(ROOT, 'scripts/lib/plan-api-child.mts'), ...(fresh ? ['--fresh'] : [])], { env: { ...process.env, ...childEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid!;
  let out = ''; child.stdout!.on('data', (d: Buffer) => { out += d.toString(); if (process.env.FORK_PLAN_VERBOSE) process.stdout.write(d); }); child.stderr!.on('data', (d: Buffer) => { out += d.toString(); if (process.env.FORK_PLAN_VERBOSE) process.stderr.write(d); });
  for (let k = 0; k < 240; k++) { if (/READY/.test(out)) return pid; if (child.exitCode !== null) throw new Error(`the API process exited: ${out.slice(-1500)}`); await sleep(250); }
  throw new Error(`the API process did not start: ${out.slice(-1500)}`);
}

try {
  // the scratch database is created here (never an existing one: the name is fixed and it is emptied)
  if (!/^[a-z_0-9]+$/.test(DB)) throw new Error('bad database name');
  execSync(`dropdb --if-exists ${DB} && createdb ${DB}`);

  forks = await startForks([SRC, DST], PORT + 1);
  const f = forks, rpc = f.rpc;
  say(`forks: ${NETWORKS[SRC]!.name} at block ${Number(await rpc<string>(SRC, 'eth_blockNumber'))}, ${NETWORKS[DST]!.name} at block ${Number(await rpc<string>(DST, 'eth_blockNumber'))}; throwaway wallet ${ME}`);
  // the forks' clocks are frozen at the fork block's time: some venues price from on-chain quotes that expire with time, and a
  // fork receives no fresh ones (provider deadlines are wall-clock times in the future either way)
  for (const n of [SRC, DST]) await rpc(n, 'anvil_setBlockTimestampInterval', [0]);
  const attesters = await enableTestAttesters(f, DST);
  say(`[fork only] Base fork: two TEST attesters enabled through the impersonated attester manager ${attesters.manager} (threshold stays ${attesters.threshold}); Circle's real attesters cannot sign a fork-only burn`);
  const iris = await startTestIris(f, [{ src: SRC, dst: DST }], { [DST]: attesters }); irisSrv = iris.server;

  const dir = mkdtempSync(join(tmpdir(), 'spw-fork-plan-')), store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update(SETUP).digest('hex');
  // anvil reports a 1 gwei priority fee (far above the real one on these networks): raise the NETWORK-FEE ceilings for these forks only.
  // The per-transfer and daily limits are the wallet's defaults, untouched.
  store.policy = { ...store.policy, maxFee: { ...store.policy.maxFee, [SRC]: '20000000000000000', [DST]: '20000000000000000' } };
  const limits = { link: store.policy.perTx[`${SRC}:LINK`]!, usdc: store.policy.perTx[`${DST}:USDC`]! };
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  childEnv = { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_IRIS_OVERRIDE: iris.url, SPW_RPC_OVERRIDE: JSON.stringify({ [SRC]: [f.url(SRC), f.url(SRC)], [DST]: [f.url(DST), f.url(DST)] }), SPW_WEB_DIR: '', SPW_DATA_DIR: dir };

  await setNative(f, SRC, ME, '0.05'); await setNative(f, DST, ME, '0.05');
  await dealToken(f, SRC, LINK.id, ME, 6n * 10n ** 18n);
  const pid1 = await startApi(true);
  const pk = new TestPasskey(RP, ORIGIN), so = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const sv = await api('POST', '/api/v1/auth/setup/verify', { challengeId: so.challengeId, response: pk.register(so.options.challenge), setupToken: SETUP });
  if (sv.status !== 200) throw new Error(`setup failed: ${JSON.stringify(sv.json)}`);
  say(`API process ${pid1} on ${ORIGIN} (workers stepped every 1.5 s), signer over HTTP, virtual passkey enrolled; wallet: 0.05 ETH on each fork, 6 LINK on Arbitrum`);

  const bal = (net: string, token: string) => balanceOf(f, net, token, ME);
  const pump = async () => { await mine(f, SRC, 14); await mine(f, DST, 14); await sleep(900); };
  const getPlan = async (id: string) => (await api('GET', `/api/v1/plans/${id}`)).json;
  /** wait until the plan satisfies `until`, mining blocks on both forks meanwhile */
  async function waitPlan(id: string, until: (p: any) => boolean, maxSeconds = 150): Promise<any> { const t0 = Date.now(); let p = await getPlan(id); while (!until(p) && Date.now() - t0 < maxSeconds * 1000) { await pump(); p = await getPlan(id); } return p; }
  const quote = async (from: string, to: string, amount: string) => { let j = (await api('POST', '/api/v1/plans/quote', { from, to, amount, slippageBps: 50 })).json;
    for (let k = 0; k < 6 && j.plans?.length === 0 && (j.skipped ?? []).some((x: any) => /rate_limited|unavailable|timeout/.test(x.message)); k++) { await sleep(8000); j = (await api('POST', '/api/v1/plans/quote', { from, to, amount, slippageBps: 50 })).json; }   // a keyless provider said "too many requests"
    return j; };
  let approvals = 0;
  /** prepare the leg that is ready and approve it with the passkey; returns the answer of the preparation */
  async function prepareAndApprove(id: string): Promise<{ status: number; json: any }> {
    let prep = await api('POST', `/api/v1/plans/${id}/prepare`, {});
    for (let k = 0; k < 12 && prep.status >= 500; k++) { await sleep(6000); prep = await api('POST', `/api/v1/plans/${id}/prepare`, {}); }   // "not now" (provider busy, fork busy): the step stays ready; ask again
    if (prep.status !== 200 || !prep.json.proposal) return prep;
    const ap = await api('POST', `/api/v1/transfers/proposals/${prep.json.proposal.id}/approve`, { assertion: pk.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    if (ap.status !== 200) throw new Error(`approve failed: ${ap.status} ${JSON.stringify(ap.json)}`);
    approvals += 1;
    return prep;
  }
  const legLine = (l: any) => `${l.label}${l.speed ? ` ${l.speed}` : ''}: ${l.from.symbol} (${l.from.networkName}) → ${l.to.symbol} (${l.to.networkName})`;
  const K = (a: string, n: string) => `${n}:${a}`;

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[A] planning');
  const caps = (await api('GET', '/api/v1/plans/capabilities')).json;
  say(`  executable legs: swap on ${Object.keys(caps.swap).join(', ')}; CCTP (USDC) between ${caps.cctp.join(', ')}; THORChain ${caps.thorchain.map((t: any) => `${t.symbol}@${t.network}${t.source ? '' : ' (destination only)'}`).join(', ')}`);
  const sol = await quote('solana:native', K(USDC_B, DST), '0.1');
  check(sol.plans.length === 0 && sol.notExecutable?.code === 'solana_evm_bridge', `SOL (Solana) → USDC (Base): no plan, reason "${sol.notExecutable?.code}" — said, not faked`);
  const tron = await quote('tron:native', K(USDC_B, DST), '10');
  check(tron.plans.length === 0 && tron.notExecutable?.code === 'network_without_execution', `TRX (Tron) → USDC (Base): no plan, reason "${tron.notExecutable?.code}" (${tron.notExecutable?.network})`);

  const q6 = await quote(K(LINK.id, SRC), K(CBBTC.id, DST), '6');
  const p6 = q6.plans[0];
  if (!p6) throw new Error(`no plan was priced: ${JSON.stringify(q6.skipped)}`);
  check(!!p6 && !p6.executable && p6.issues.some((i: any) => i.code === 'limit_per_transfer' && i.blocking), `6 LINK → cbBTC: ${q6.plans.length} plan(s) priced, none startable; issues: ${p6?.issues.filter((i: any) => i.blocking).map((i: any) => `${i.code} step ${i.leg + 1} ${i.needDisplay} ${i.symbol} > ${i.haveDisplay} on ${i.networkName}`).join('; ')}`);
  const r6 = await api('POST', '/api/v1/plans', { from: K(LINK.id, SRC), to: K(CBBTC.id, DST), amount: '6', slippageBps: 50, plan: p6.id });
  check(r6.status === 422 && r6.json.error === 'plan_not_startable' && /per-transfer limit/.test(r6.json.message), `starting it is refused at planning (${r6.status} ${r6.json.error}): "${String(r6.json.message).slice(0, 230)}"`);
  check((await api('GET', '/api/v1/plans')).json.plans.length === 0, 'nothing was stored, nothing was prepared');

  await f.rpc(DST, 'anvil_setBalance', [ME, '0x0']);
  const qGas = await quote(K(LINK.id, SRC), K(CBBTC.id, DST), '4');
  const g = qGas.plans[0]?.issues.find((i: any) => i.code === 'gas_missing');
  check(!!g && g.network === DST && qGas.plans.every((p: any) => !p.executable), `no ETH on Base: every plan is refused before anything is signed — "gas_missing": about ${g?.needDisplay} ${g?.symbol} needed on ${g?.networkName}, ${g?.haveDisplay} available`);
  await setNative(f, DST, ME, '0.05');

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[B] a full plan: 3 LINK (Arbitrum) → cbBTC (Base)');
  const q = await quote(K(LINK.id, SRC), K(CBBTC.id, DST), '3');
  for (const p of q.plans) say(`  candidate${p.executable ? '' : ' (not startable)'}: ${p.legs.map((l: any) => `${l.label}${l.speed ? ` ${l.speed}` : ''}`).join(' → ')} — expected ${p.expectedOutDisplay} cbBTC, worst case ${p.worstOutDisplay}, ~${p.seconds} s, fees outside outputs ≈ ${p.extraFeesUsd === null ? 'n/a' : p.extraFeesUsd.toFixed(4)} USD, ${p.approvals} approvals`);
  const chosen = q.plans.find((p: any) => p.executable && p.legs[1].speed === 'standard');
  if (!chosen) throw new Error(`no startable plan: ${JSON.stringify(q.plans.map((p: any) => p.issues), null, 1)} ${JSON.stringify(q.skipped)}`);
  const startable = q.plans.filter((p: any) => p.executable);
  check(startable.every((p: any, k: number) => k === 0 || BigInt(startable[k - 1].worstOut) >= BigInt(p.worstOut)), `ranked by guaranteed worst case; chosen: ${chosen.legs.map(legLine).join('  |  ')}`);
  for (const l of chosen.legs) say(`    ${legLine(l)}: in ${l.expectedInDisplay} (worst ${l.worstInDisplay}) → out ${l.expectedOutDisplay} (worst ${l.worstOutDisplay}); ${l.fees.map((x: any) => `${x.kind} ${x.display} ${x.symbol}@${x.network}${x.includedInOutput ? ' (in output)' : ''}`).join(', ')}`);
  say(`    required before starting: ${chosen.requirements.gas.map((x: any) => `${x.needDisplay} ${x.symbol} on ${x.networkName} (have ${x.haveDisplay})`).join('; ')}; limits: ${chosen.requirements.limits.map((x: any) => `step ${x.leg + 1} ${x.needDisplay}/${x.perTransferDisplay} ${x.symbol}`).join(', ')}`);
  const created = await api('POST', '/api/v1/plans', { from: K(LINK.id, SRC), to: K(CBBTC.id, DST), amount: '3', slippageBps: 50, plan: chosen.id });
  if (created.status !== 200) throw new Error(`plan creation failed: ${JSON.stringify(created.json)}`);
  const A = created.json.id as string;
  check(created.json.state === 'active' && created.json.next === 'prepare' && created.json.legs.map((l: any) => l.state).join() === 'ready,pending,pending' && (await api('GET', '/api/v1/activity')).json.items.length === 0, 'plan stored; first leg ready; no proposal exists yet (a leg is only prepared when its turn comes)');
  const dup = await api('POST', '/api/v1/plans', { from: K(LINK.id, SRC), to: K(CBBTC.id, DST), amount: '1', slippageBps: 50, plan: chosen.id });
  check(dup.status === 409 && dup.json.error === 'plan_open', 'a second plan while one is open is refused (409 plan_open)');

  say(' leg 1 — swap on Arbitrum, passkey #1');
  const link0 = await bal(SRC, LINK.id);
  const l1 = await prepareAndApprove(A);
  if (!l1.json.proposal) throw new Error(`leg 1 was not prepared: ${JSON.stringify(l1.json)}`);
  let plan = await waitPlan(A, (p) => p.current >= 1 || p.state !== 'active');
  const got1 = await bal(SRC, USDC_A);
  check(plan.current === 1 && plan.legs[0].state === 'settled' && plan.legs[1].state === 'ready' && link0 - (await bal(SRC, LINK.id)) === 3n * 10n ** 18n && BigInt(plan.holding.amount) === got1,
    `settled: planned ${plan.legs[0].planned.expectedOutDisplay} USDC (worst ${plan.legs[0].planned.worstOutDisplay}), ACTUAL ${plan.legs[0].actual.outDisplay} USDC = the wallet's balance on the fork (${formatUnits(got1, 6)}); the plan now holds USDC on Arbitrum`);
  check((await bal(SRC, USDC_A)) > 0n && (await bal(DST, USDC_B)) === 0n && plan.next === 'prepare' && plan.proposal?.state !== 'pending_approval', 'leg 2 is ready but NOT prepared: nothing moves without the owner');
  let alertSeen = false; for (let k = 0; k < 12 && !alertSeen; k++) { const al = (await api('GET', '/api/v1/alerts?limit=50')).json; alertSeen = (al.items ?? []).some((x: any) => x.kind === 'plan.step_ready' && x.subject?.id === A); if (!alertSeen) await sleep(1000); }
  check(alertSeen, 'alert "plan.step_ready" raised through the alerts layer (subject: this plan)');

  say(' restart between legs');
  child!.kill('SIGKILL'); await sleep(500);
  const pid2 = await startApi(false);
  plan = await getPlan(A);
  check(pid2 !== pid1 && plan.state === 'active' && plan.current === 1 && plan.legs[1].state === 'ready' && plan.holding.amount === got1.toString(), `API process killed (pid ${pid1}) and started again (pid ${pid2}): the plan is where it was — step 2 ready, holding ${plan.holding.amountDisplay} USDC`);

  say(' leg 2 — CCTP Arbitrum → Base, passkey #2, attestation held back');
  iris.state.hold = true;
  const l2 = await prepareAndApprove(A);
  if (!l2.json.proposal) throw new Error(`leg 2 was not prepared: ${JSON.stringify(l2.json)}`);
  check(l2.json.proposal.amount === got1.toString() && l2.json.proposal.kind === 'bridge', `the burn is sized on what leg 1 ACTUALLY delivered (${l2.json.proposal.amountDisplay} USDC), not on the estimate (${plan.legs[1].planned.expectedInDisplay})`);
  plan = await waitPlan(A, (p) => p.proposal?.bridge?.stage === 'attesting' && p.proposal.bridge.polls >= 1, 90);
  const asked = iris.state.asked;
  check(plan.state === 'active' && plan.current === 1 && plan.legs[1].state === 'in_flight' && plan.proposal?.bridge?.stage === 'attesting' && (await bal(SRC, USDC_A)) === 0n && (await bal(DST, USDC_B)) === 0n,
    `attestation not available: burned on Arbitrum, not minted on Base; the plan WAITS (step 2 in flight, bridge "${plan.proposal?.bridge?.stage}", ${asked} poll(s) answered "not found")`);
  iris.state.hold = false;
  await api('POST', `/api/v1/bridge/proposals/${l2.json.proposal.id}/finish`, {});   // the existing "finish" button: look now instead of waiting for the next poll
  plan = await waitPlan(A, (p) => p.current >= 2 || p.state !== 'active');
  const got2 = await bal(DST, USDC_B);
  check(plan.current === 2 && plan.legs[1].state === 'settled' && got2 === BigInt(plan.holding.amount) && got2 > 0n, `attestation arrived: minted on Base; planned ${plan.legs[1].planned.expectedOutDisplay}, ACTUAL ${plan.legs[1].actual.outDisplay} USDC; the plan resumes at step 3 (ready)`);

  say(' leg 3 — the market moves away from the quote after the owner approved (passkey #3): the swap is NOT sent');
  const snap = await rpc<string>(DST, 'evm_snapshot');
  // FORK ONLY. KyberSwap routes this size through proprietary market-maker venues whose price does not follow trades made
  // elsewhere on a fork, so the divergence is produced at the source: the firm calldata of THIS proposal is traced on the
  // fork, and the cbBTC inventory its venue would pay from is removed. The live quote now promises what the fork's market
  // can no longer deliver — which is what a price move between approval and inclusion looks like to the last gate.
  const tracer = privateKeyToAccount(generatePrivateKey()).address;
  await setNative(f, DST, tracer, '1'); await dealToken(f, DST, USDC_B, tracer, got2); await rpc(DST, 'anvil_impersonateAccount', [tracer]);
  await rpc(DST, 'eth_sendTransaction', [{ from: tracer, to: USDC_B, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER as Hex, got2] }) }]);
  await rpc(DST, 'anvil_stopImpersonatingAccount', [tracer]);
  const drained: string[] = []; let prep3: { status: number; json: any } = { status: 0, json: null }, signed3 = false;
  // the first trace makes the fork download the venue's state and can outlast the 75 s approval window: the request is then
  // simply prepared again (the plan withdraws the unused one) until one is traced, emptied and approved inside its window
  for (let round = 0; round < 5 && !signed3; round++) {
    prep3 = await api('POST', `/api/v1/plans/${A}/prepare`, {});
    for (let k = 0; k < 15 && prep3.status >= 500; k++) { await sleep(4000); prep3 = await api('POST', `/api/v1/plans/${A}/prepare`, {}); }   // "not now" answers leave the step ready
    if (!prep3.json?.proposal) throw new Error(`leg 3 was not prepared: ${JSON.stringify(prep3.json)}`);
    const swapData = execSync(`psql -At -d ${DB}`, { input: `select aux->>'swapData' from proposals where id = '${prep3.json.proposal.id}'`, encoding: 'utf8' }).trim();
    // the router's executor asks several venues and takes the best: every venue this calldata can draw cbBTC from is emptied,
    // until the call itself — simulated from an account that holds the same USDC and allowance — no longer succeeds on the fork
    let dead = false;
    for (let k = 0; k < 8 && !dead; k++) {
      dead = await rpc(DST, 'eth_call', [{ from: tracer, to: KYBER_ROUTER, data: swapData }, 'latest']).then(() => false, () => true);
      if (dead) break;
      const trace = await rpc<any>(DST, 'debug_traceCall', [{ from: tracer, to: KYBER_ROUTER, data: swapData }, 'latest', { tracer: 'callTracer' }]);
      const payers = new Set<string>();
      const walk = (c: any) => { if (String(c.to).toLowerCase() === CBBTC.id.toLowerCase() && /^0x(a9059cbb|23b872dd)/.test(String(c.input))) payers.add((String(c.input).startsWith('0x23b872dd') ? `0x${String(c.input).slice(34, 74)}` : String(c.from)).toLowerCase()); for (const x of c.calls ?? []) walk(x); };
      walk(trace);
      let any = false;
      for (const a of payers) { if ([tracer.toLowerCase(), ME.toLowerCase(), KYBER_ROUTER.toLowerCase()].includes(a)) continue; if ((await balanceOf(f, DST, CBBTC.id, a)) > 0n) { await dealToken(f, DST, CBBTC.id, a, 0n); drained.push(a); any = true; } }
      if (!any) break;
    }
    if (!dead) continue;   // this calldata still finds cbBTC somewhere: prepare again and look at the new one
    const ap3 = await api('POST', `/api/v1/transfers/proposals/${prep3.json.proposal.id}/approve`, { assertion: pk.assert(Buffer.from(prep3.json.options.challenge, 'base64url')) });
    if (ap3.status === 200) signed3 = true;
    else if (![409, 410].includes(ap3.status)) throw new Error(`approve failed: ${ap3.status} ${JSON.stringify(ap3.json)}`);
    else await waitPlan(A, (p) => p.next === 'prepare', 30);   // the window ran out during the trace: the step is ready again
  }
  if (!signed3) throw new Error('leg 3 could not be approved inside its window');
  approvals += 1;
  check(prep3.json.proposal.amount === got2.toString() && prep3.json.proposal.swap.needsApproval === true, `prepared on the ${prep3.json.proposal.amountDisplay} USDC actually received; approved minimum ${prep3.json.proposal.swap.minOutDisplay} cbBTC (expected ${prep3.json.proposal.swap.expectedOutDisplay}); approved with the passkey`);
  check(drained.length > 0, `[fork only] before the approval was given, the calldata of the proposal was traced on the fork and the cbBTC inventory of every venue it can draw from was removed (${[...new Set(drained)].join(', ') || '?'}): the fork's market can no longer deliver what the live quote promises`);
  plan = await waitPlan(A, (p) => p.state !== 'active', 120);
  const failed3 = (await api('GET', `/api/v1/transfers/proposals/${prep3.json.proposal.id}`)).json;
  const allowance3 = BigInt(await rpc<Hex>(DST, 'eth_call', [{ to: USDC_B, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [ME as Hex, KYBER_ROUTER as Hex] }) }, 'latest']));
  check(plan.state === 'paused' && plan.pause?.code === 'leg_failed' && failed3.state === 'failed' && /would revert now/.test(String(failed3.error)) && plan.legs[2].state === 'ready' && (await bal(DST, USDC_B)) === got2 && (await bal(DST, CBBTC.id)) === 0n,
    `leg 3 REFUSED at the last gate — the approved swap is simulated against the chain right before it is sent, and it would not deliver: proposal "${failed3.state}", plan PAUSED ("${plan.pause?.code}") — "${String(plan.pause?.message).slice(0, 170)}"; the ${plan.holding.amountDisplay} USDC are untouched on Base (only the exact-amount token approval was mined: allowance ${formatUnits(allowance3, 6)} USDC, usable by this wallet's next attempt only)`);
  const moved = true, refused = { status: 200, json: { proposal: null } };
  const noPrep = await api('POST', `/api/v1/plans/${A}/prepare`, {});
  check(noPrep.status === 409, `while paused nothing can be prepared (${noPrep.status} ${noPrep.json.error})`);
  void moved; void refused;
  await rpc(DST, 'evm_revert', [snap]);                                             // FORK ONLY: the market comes back (the fork returns to the state it had before the divergence)
  say(' re-plan from the asset held (USDC on Base), passkey #4');
  const re = await api('POST', `/api/v1/plans/${A}/replan`, {});
  check(re.status === 200 && re.json.state === 'active' && re.json.replans === 1 && re.json.legs.length === 3 && re.json.legs[2].state === 'ready' && re.json.legs[2].from.symbol === 'USDC' && re.json.legs[2].from.network === DST,
    `re-planned from ${re.json.holding?.amountDisplay} USDC on Base: the two settled legs are kept, a fresh last leg is quoted (expected ${re.json.legs?.[2]?.planned.expectedOutDisplay} cbBTC, worst ${re.json.legs?.[2]?.planned.worstOutDisplay})`);
  const cb0 = await bal(DST, CBBTC.id);
  const l3 = await prepareAndApprove(A);
  if (!l3.json.proposal) throw new Error(`leg 3 was not prepared: ${JSON.stringify(l3.json)}`);
  plan = await waitPlan(A, (p) => p.state !== 'active');
  let l3ok = l3;
  if (plan.state === 'paused') { // the swap can still fail on the fork (its venues' on-chain quotes age): "réessayer", one more approval
    say(`    this attempt failed ("${String(plan.pause?.message).slice(0, 90)}"): the plan paused again with the USDC untouched — "retry"`);
    await api('POST', `/api/v1/plans/${A}/retry`, {});
    l3ok = await prepareAndApprove(A);
    if (!l3ok.json.proposal) throw new Error(`leg 3 was not prepared again: ${JSON.stringify(l3ok.json)}`);
    plan = await waitPlan(A, (p) => p.state !== 'active');
  }
  const cb = (await bal(DST, CBBTC.id)) - cb0;
  check(plan.state === 'done' && cb > 0n && cb.toString() === plan.holding.amount && cb >= BigInt(l3ok.json.proposal.swap.minOut) && (await bal(DST, USDC_B)) === 0n,
    `plan DONE: received ${plan.receivedDisplay} cbBTC on Base = the fork balance; this leg's approved minimum was ${l3ok.json.proposal.swap.minOutDisplay}`);
  say('  planned vs actual, per leg:');
  for (const l of plan.legs) say(`    ${l.index + 1}. ${legLine(l)}: planned in ${l.planned.expectedInDisplay} → out ${l.planned.expectedOutDisplay} (worst ${l.planned.worstOutDisplay}); ACTUAL in ${l.actual.inDisplay} → out ${l.actual.outDisplay}`);
  say(`    whole plan at the start: expected ${chosen.expectedOutDisplay} cbBTC, worst case ${chosen.worstOutDisplay}; received ${plan.receivedDisplay}`);
  check(approvals >= 4 && approvals <= 5, `${approvals} passkey approvals: one per leg, plus one for each attempt of the last leg that did not go through; the signer signed nothing else for the wallet except the one CCTP mint tied to the approved burn`);
  for (const [net, token, name] of [[SRC, USDC_A, 'KyberSwap router / USDC Arbitrum'], [SRC, LINK.id, 'KyberSwap router / LINK'], [DST, USDC_B, 'KyberSwap router / USDC Base']] as const) {
    const a = BigInt(await rpc<Hex>(net, 'eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [ME as Hex, KYBER_ROUTER as Hex] }) }, 'latest']));
    if (a !== 0n) check(false, `leftover allowance ${name}: ${a}`);
  }
  check(true, 'no allowance left behind on the routers');

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[C] an overall floor: 15 USDC (Arbitrum) → cbBTC (Base), "bridge then swap", two approvals');
  await dealToken(f, SRC, USDC_A, ME, 15_000000n);
  const qb = await quote(K(USDC_A, SRC), K(CBBTC.id, DST), '15');
  const pb = qb.plans.find((p: any) => p.executable && p.legs[0].speed === 'standard');
  if (!pb) throw new Error(`no startable plan B: ${JSON.stringify(qb.plans.map((p: any) => p.issues))} ${JSON.stringify(qb.skipped)}`);
  const floor = formatUnits((BigInt(pb.expectedOut) * 97n) / 100n, CBBTC.decimals);
  const tooHigh = await api('POST', '/api/v1/plans', { from: K(USDC_A, SRC), to: K(CBBTC.id, DST), amount: '15', slippageBps: 50, plan: pb.id, floor: formatUnits(BigInt(pb.expectedOut) * 2n, CBBTC.decimals) });
  check(tooHigh.status === 422 && tooHigh.json.error === 'floor_above_estimate', 'a floor above the expected result is refused at the start');
  const cB = await api('POST', '/api/v1/plans', { from: K(USDC_A, SRC), to: K(CBBTC.id, DST), amount: '15', slippageBps: 50, plan: pb.id, floor });
  if (cB.status !== 200) throw new Error(`plan B creation failed: ${JSON.stringify(cB.json)}`);
  const B = cB.json.id as string;
  say(`  plan: ${pb.legs.map(legLine).join('  |  ')}; expected ${pb.expectedOutDisplay} cbBTC, worst ${pb.worstOutDisplay}; floor chosen by the owner: ${floor} cbBTC (97 % of expected)`);
  const b1 = await prepareAndApprove(B);
  if (!b1.json.proposal) throw new Error(`plan B leg 1 was not prepared: ${JSON.stringify(b1.json)}`);
  plan = await waitPlan(B, (p) => p.current >= 1 || p.state !== 'active', 200);
  check(plan.current === 1 && plan.legs[0].state === 'settled' && (await bal(DST, USDC_B)) === BigInt(plan.holding.amount), `leg 1 settled: ${plan.legs[0].actual.outDisplay} USDC on Base; estimate before it: expected ${plan.estimate?.expectedOutDisplay} cbBTC`);
  // between the two legs the result degrades: here, 10 % of the USDC leaves the wallet (FORK ONLY: balance slot rewritten) — the
  // estimate of the final result, made from what is REALLY held with live quotes, falls under the floor
  await dealToken(f, DST, USDC_B, ME, (BigInt(plan.holding.amount) * 90n) / 100n);
  const fl = await api('POST', `/api/v1/plans/${B}/prepare`, {});
  plan = await getPlan(B);
  check(fl.status === 200 && fl.json.proposal === null && plan.state === 'paused' && plan.pause?.code === 'floor' && (await api('GET', '/api/v1/activity')).json.items.filter((x: any) => x.state === 'pending_approval').length === 0,
    `before leg 2 the floor is checked: estimated ${plan.estimate?.expectedOutDisplay} cbBTC < floor ${plan.floorDisplay} → plan PAUSED ("${plan.pause?.code}"), nothing prepared, no passkey asked`);
  const st = await api('POST', `/api/v1/plans/${B}/stop`, {});
  check(st.status === 200 && st.json.state === 'stopped' && st.json.holding.network === DST && st.json.holding.symbol === 'USDC' && (await bal(DST, USDC_B)) > 0n, `"stop here": plan stopped; the ${formatUnits(await bal(DST, USDC_B), 6)} USDC stay on Base as an ordinary balance of the wallet's own address`);
  const after = await api('POST', `/api/v1/plans/${B}/prepare`, {});
  check(after.status === 409, 'a stopped plan prepares nothing');

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[audit]');
  const audit = (await api('GET', '/api/v1/security/audit?limit=500')).json;
  const kinds = [...new Set(audit.events.filter((e: any) => e.type.startsWith('plan.')).map((e: any) => e.type))].sort();
  check(audit.intact === true && ['plan.created', 'plan.step_prepared', 'plan.step_settled', 'plan.step_ready', 'plan.paused', 'plan.replanned', 'plan.done', 'plan.stopped'].every((k) => kinds.includes(k)), `audit chain intact; plan events: ${kinds.join(', ')}`);
  const acts = (await api('GET', '/api/v1/activity')).json.items.filter((x: any) => x.kind !== 'receive');
  say(`  activity: ${acts.map((x: any) => `${x.kind} ${x.amountDisplay} ${x.symbol} ${x.state}${x.bridge ? `/${x.bridge.stage}` : ''}`).reverse().join('; ')}`);
  await sleep(6000);   // the dispatcher tails the audit chain a moment later
  const alertsNow = (await api('GET', '/api/v1/alerts?limit=100')).json.items.filter((x: any) => x.kind.startsWith('plan.')).map((x: any) => x.kind);
  check(['plan.step_ready', 'plan.paused', 'plan.done'].every((k) => alertsNow.includes(k)), 'the three plan alert kinds were raised by the alerts layer');
  say(`  alerts raised: ${[...new Set(alertsNow)].sort().map((k) => `${k} ×${alertsNow.filter((x: string) => x === k).length}`).join(', ')}`);
  say(`  per-transfer limits in force (untouched defaults): ${formatUnits(BigInt(limits.link), 18)} LINK, ${formatUnits(BigInt(limits.usdc), 6)} USDC`);

  if (failures) throw new Error(`${failures} check(s) failed`);
  say('\nFORK PLAN TEST OK — nothing was sent to a real network; data read from outside is public (KyberSwap quotes and calldata, Circle fee schedule, prices)');
} catch (e) { console.error(`\nFORK PLAN TEST FAILED: ${(e as Error).message}`); failures += 1; }
finally { cleanup(); }
process.exit(failures ? 1 : 0);
