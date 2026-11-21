/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mm/lifecycle.ts
 * Module           : mm
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// Going LIVE with a market-making agent: the checks, in one place, used by `startAgent` (agents/lifecycle.ts — the owner's
// routes AND the trading API's `startAgent`) and by the owner's go-live checklist (mm/routes.ts).
//
// What a live start needs, and the code each missing piece answers with (first one that applies):
//   live_unavailable (409)          the agent's venue or instrument cannot go live (one venue, pinned instruments)
//   mandate_required (409)          no quoting mandate approved for this agent, or it is revoked / expired / not yet started
//   mandate_integrity (403)         the stored mandate is not what the owner approved
//   quoting_config_changed (409)    the agent's configuration is not the one the mandate was approved for
//   mainnet_disabled / mandate_mainnet_disabled / mm_mainnet_disabled / mm_testnet_disabled / execution_disabled (403)
//                                   a server lock is off (mm/live-adapter.ts `mmOpeningLock`: ONE rule)
//   golive_incomplete (409)         a step of the owner's go-live checklist is missing (mainnet only; the steps are listed)
//   mandate_required (409)          the FIRST live start under a mandate is the owner's: a key may only resume what he started
// Nothing here creates, prepares or approves a mandate, and nothing here signs.
import { createHash } from 'node:crypto';
import { jurisdictionAck } from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { configHash, liveVerdict, type Family } from '../agent-runtime/model.ts';
import type { RuntimeAgentRow } from '../agent-runtime/store.ts';
import type { MandateService } from '../mandates/service.ts';
import { envMmLocks, mmOpeningLock, type MmLocks } from './live-adapter.ts';

/** the paper session the checklist asks for, in minutes (a setting for development stacks; never below 1) */
export const minPaperMinutes = (env: Record<string, string | undefined> = process.env): number => { const n = Number(env.SPW_MM_MIN_PAPER_MINUTES ?? 30); return Number.isFinite(n) && n >= 1 ? Math.min(n, 10_080) : 30; };

/**
 * THE EVIDENCE, AS IT IS. Both figures are NEGATIVE; the owner ticks an explicit acknowledgement of exactly this text (its
 * hash is recorded with the acknowledgement). Sources: research/studies/market_making_as (run 2026-11-15) and the simulated
 * session of the foundations (docs/V11-MARKET-MAKING.md §10).
 */
export const MM_EVIDENCE = {
  version: '2026-11-16',
  lab: { source: 'research/studies/market_making_as', ranOn: '2026-11-15', sample: '68 minutes of 5 s books; fills MODELLED, not observed', result: 'Avellaneda–Stoikov PnL NEGATIVE on BTC, ETH and SOL on Hyperliquid, under both fill rules',
    figures: { btcPnlUsd: '-9.5', btcVolumeUsd: '30000', btcBpsOfVolume: '-3.2', markout60sBps: 'between -1 and -2.7 (adverse selection)', makerFeeBps: '1.5 paid' } },
  simulation: { source: 'services/api/test/mm-engine.test.ts on the recorded public BTC tape (2026-11-16 03:06–03:42 UTC), real signer code, fake venue; fills MODELLED (queue + trade-through)',
    result: 'PnL NEGATIVE', figures: { minutes: 36, quoteBatches: 286, quotes: 495, cancels: 486, fills: 36, volumeUsd: '683', pnlUsd: '-0.125', bpsOfVolume: '-1.83', spreadCaptureUsd: '0.086', inventoryPnlUsd: '-0.108', feesUsd: '-0.102',
      markoutBps: { '1s': '-0.47', '10s': '-0.92', '60s': '-0.33' } } },
  fees: 'tier 0 on Hyperliquid perpetuals: maker 0.015 % PAID (not received), taker 0.045 %; a round trip must capture more than 3 bps net of adverse selection',
  statement: { en: 'I have read the two results above. The laboratory study and the simulation both show a NEGATIVE modelled PnL and adverse markouts, at a maker fee of 1.5 bps that I pay. Nothing here supports an expectation of profit. Running a live session is my own decision.',
    fr: 'J’ai lu les deux résultats ci-dessus. L’étude du laboratoire et la simulation montrent toutes deux un résultat modélisé NÉGATIF et des markouts défavorables, avec des frais de teneur de 1,5 pb que je paie. Rien ici ne permet d’attendre un gain. Lancer une session réelle est ma propre décision.' },
} as const;
export const evidenceSha256 = (locale: 'fr' | 'en'): string => createHash('sha256').update(JSON.stringify({ lab: MM_EVIDENCE.lab, simulation: MM_EVIDENCE.simulation, fees: MM_EVIDENCE.fees, statement: MM_EVIDENCE.statement[locale] })).digest('hex');

export interface GoLiveAcks { evidence?: { at: number; sha256: string; locale: 'fr' | 'en' }; jurisdiction?: { at: number; sha256: string; locale: 'fr' | 'en' }; testnet?: { at: number; note: string } }
export interface GoLiveStep { id: 'paper' | 'evidence' | 'jurisdiction' | 'testnet' | 'mandate' | 'locks'; done: boolean; evidence: Record<string, unknown>; missing: string | null }
type Agent = Pick<RuntimeAgentRow, 'id' | 'family' | 'kind' | 'universe' | 'runtime' | 'config_version'>;
const rtOf = (a: Agent) => (a.runtime ?? {}) as { venues?: string[]; config?: Record<string, unknown>; mm?: { goLive?: GoLiveAcks; live?: { mandateId: string; activatedAt: number } } };

/** the go-live checklist of an agent, each step with its evidence — in the order the owner completes it */
export async function goLiveChecklist(a: Agent, mandates: MandateService, o: { now: number; locks?: MmLocks; env?: Record<string, string | undefined> } = { now: Date.now() }): Promise<{ steps: GoLiveStep[]; ready: boolean; network: 'mainnet' | 'testnet' | null }> {
  const rt = rtOf(a), acks = rt.mm?.goLive ?? {}, instrument = `hyperliquid:${a.universe[0]}`, need = minPaperMinutes(o.env);
  const [p] = await sql<{ id: string; minutes: number; fills: number; started_at: Date }[]>`select id, extract(epoch from (coalesce(ended_at, heartbeat_at) - started_at)) / 60 as minutes, coalesce((pnl->>'fills')::int, 0) as fills, started_at from mm_sessions
    where agent_id = ${a.id} and mode = 'PAPER' and instrument = ${instrument} order by (coalesce(ended_at, heartbeat_at) - started_at) desc limit 1`;
  const [t] = await sql<{ id: string; started_at: Date }[]>`select id, started_at from mm_sessions where agent_id = ${a.id} and mode = 'LIVE' and network = 'testnet' order by started_at desc limit 1`;
  const q = await mandates.quotingFor(a.id), jur = { fr: jurisdictionAck('hyperliquid', 'fr').sha256, en: jurisdictionAck('hyperliquid', 'en').sha256 };
  const network = q ? ((q.row.compiled?.venue?.mandate as { network?: 'mainnet' | 'testnet' } | undefined)?.network ?? null) : null;
  const mandateOk = !!q && q.row.state === 'active' && q.phase === 'active' && q.integrity === null && q.row.quoting!.section.engine.configSha256 === configHash(rt.config ?? {});
  const lock = network ? mmOpeningLock(network, o.locks ?? envMmLocks(o.env ?? process.env)) : null;
  const evOk = !!acks.evidence && acks.evidence.sha256 === evidenceSha256(acks.evidence.locale), jurOk = !!acks.jurisdiction && acks.jurisdiction.sha256 === jur[acks.jurisdiction.locale];
  const steps: GoLiveStep[] = [
    { id: 'paper', done: !!p && Number(p.minutes) >= need, evidence: { requiredMinutes: need, instrument, session: p ? { id: p.id, minutes: Math.floor(Number(p.minutes) * 10) / 10, fills: p.fills, startedAt: p.started_at.getTime() } : null }, missing: p && Number(p.minutes) >= need ? null : `a paper session of at least ${need} minutes on ${instrument}` },
    { id: 'evidence', done: evOk, evidence: { acknowledgedAt: acks.evidence?.at ?? null, sha256: acks.evidence?.sha256 ?? null, version: MM_EVIDENCE.version }, missing: evOk ? null : 'the acknowledgement that the modelled PnL is negative in the lab study and in the simulation' },
    { id: 'jurisdiction', done: jurOk, evidence: { acknowledgedAt: acks.jurisdiction?.at ?? null, sha256: acks.jurisdiction?.sha256 ?? null, source: 'docs/v4/venues/jurisdiction.md' }, missing: jurOk ? null : 'the Hyperliquid jurisdiction acknowledgement' },
    { id: 'testnet', done: !!t || !!acks.testnet, evidence: { session: t ? { id: t.id, startedAt: t.started_at.getTime() } : null, attestedAt: acks.testnet?.at ?? null, note: acks.testnet?.note ?? null, ownerRun: true }, missing: t || acks.testnet ? null : 'the testnet step (run by the owner with test funds), or his attestation that he ran it' },
    { id: 'mandate', done: mandateOk, evidence: { mandateId: q?.row.id ?? null, state: q?.row.state ?? null, phase: q?.phase ?? null, integrity: q?.integrity ?? null, network, expiresAt: q ? q.row.mandate.notAfter * 1000 : null }, missing: mandateOk ? null : 'a quoting mandate approved with the passkey for the agent\'s current configuration' },
    { id: 'locks', done: !!network && lock === null, evidence: { network, code: lock?.code ?? null, setting: lock?.setting ?? null }, missing: !network ? 'a mandate (the network follows from its venue account)' : lock ? `${lock.code}: ${lock.message}` : null },
  ];
  return { steps, ready: steps.every((s) => s.done || (s.id === 'testnet' && network === 'testnet')), network };
}

/** the owner records an acknowledgement of the checklist (the text he ticked is identified by its hash) */
export async function acknowledge(agentId: string, step: 'evidence' | 'jurisdiction' | 'testnet', body: { locale: 'fr' | 'en'; note?: string }, now: number): Promise<GoLiveAcks> {
  const [a] = await sql<{ runtime: { mm?: { goLive?: GoLiveAcks } } | null }[]>`select runtime from agents where id = ${agentId}`;
  if (!a) throw new UserError('not_found', 'agent not found', 404);
  const acks: GoLiveAcks = { ...(a.runtime?.mm?.goLive ?? {}) };
  if (step === 'evidence') acks.evidence = { at: now, sha256: evidenceSha256(body.locale), locale: body.locale };
  else if (step === 'jurisdiction') acks.jurisdiction = { at: now, sha256: jurisdictionAck('hyperliquid', body.locale).sha256, locale: body.locale };
  else { if (!body.note || body.note.trim().length < 10) throw new UserError('bad_request', 'say in a sentence what was run on testnet and what was observed', 400); acks.testnet = { at: now, note: body.note.trim().slice(0, 500) }; }
  await sql`update agents set runtime = jsonb_set(coalesce(runtime, '{}'::jsonb), '{mm}', coalesce(runtime->'mm', '{}'::jsonb) || ${sql.json({ goLive: acks } as never)}, true), updated_at = now() where id = ${agentId}`;
  return acks;
}

/** May this agent be started LIVE now, by this actor? Throws the UserError to answer with; returns what the start records. */
export async function assertLiveStart(a: Agent, actor: { kind: 'owner' | 'api_key' | 'agent' }, mandates: MandateService, o: { now: number; locks?: MmLocks; env?: Record<string, string | undefined>; mandateRequired: (why: string) => Error }): Promise<{ mandateId: string; network: 'mainnet' | 'testnet' }> {
  const rt = rtOf(a), lv = liveVerdict((a.family ?? 'custom') as Family, 'stream', a.universe, rt.venues ?? []);
  if (!lv.capable) throw new UserError('live_unavailable', lv.reason, 409);
  const q = await mandates.quotingFor(a.id);
  if (!q) throw o.mandateRequired('this market-making agent has no quoting mandate (Risk → quoting mandate: the owner creates it and approves it with the passkey)');
  if (q.row.state !== 'active' || q.phase !== 'active') throw o.mandateRequired(`the quoting mandate of this agent is ${q.row.state === 'active' ? q.phase : q.row.state}: a new one must be approved`);
  if (q.integrity) throw new UserError('mandate_integrity', `the quoting mandate of this agent cannot be used: ${q.integrity}`, 403);
  if (q.row.quoting!.section.engine.configSha256 !== configHash(rt.config ?? {})) throw new UserError('quoting_config_changed', 'the agent\'s configuration changed since its quoting mandate was approved: a new mandate must be approved for the current configuration', 409);
  const network = (q.row.compiled!.venue!.mandate as { network: 'mainnet' | 'testnet' }).network;
  const lock = mmOpeningLock(network, o.locks ?? envMmLocks(o.env ?? process.env));
  if (lock) throw new UserError(lock.code, `${lock.message}. Nothing was started; cancels and reductions are never behind this setting.`, 403);
  const list = await goLiveChecklist(a, mandates, o);
  if (!list.ready) throw Object.assign(new UserError('golive_incomplete', `the go-live checklist is not complete: ${list.steps.filter((s) => !s.done && !(s.id === 'testnet' && network === 'testnet')).map((s) => s.missing).join('; ')}`, 409), { data: { steps: list.steps } });
  if (actor.kind !== 'owner' && rt.mm?.live?.mandateId !== q.row.id) throw o.mandateRequired('the first live session under a quoting mandate is started by the owner; a key may resume it afterwards');
  return { mandateId: q.row.id, network };
}
