// Event rules: one function that turns an event the system ALREADY recorded (a row of audit_events, deriv_risk_events or
// research_log) into zero or more alert drafts. Nothing here writes to those tables or calls the money code; lookups are reads.
// Every draft is a kind + parameters (codes, names, formatted numbers) — the sentence is rendered where the alert is shown.
import { formatUnits, getNetwork, type AlertParams, type AlertSeverity, type AlertSubject } from '@spw/core';
import type { sql as Sql } from '../db.ts';
import type { AlertSettings } from './store.ts';

type Q = typeof Sql;
export interface AlertEvent {
  source: 'audit' | 'risk' | 'research'; id: number; ts: Date;
  /** audit: the event type; risk: the event kind; research: the log kind */
  type: string; actor?: string; code?: string | null; message?: string; title?: string; accountId?: string; agentId?: string | null;
  data: Record<string, unknown>;
}
export interface Draft {
  kind: string; params: AlertParams; subject?: AlertSubject; severity?: AlertSeverity;
  /** a second alert with the same key is not created; with `bump` its counter is incremented instead (digests) */
  dedupe?: string; bump?: boolean;
}
export interface RuleCtx { q: Q; settings: AlertSettings }

const str = (v: unknown, max = 200): string => (v === null || v === undefined ? '' : String(v).slice(0, max));
const netName = (id: unknown): string => { try { return getNetwork(String(id)).name; } catch { return str(id, 40); } };
const trim = (s: string, max = 6): string => { const [i, f = ''] = s.split('.'); const ff = f.slice(0, max).replace(/0+$/, ''); return ff ? `${i}.${ff}` : i!; };
const units = (amount: unknown, decimals: number): string => { try { return trim(formatUnits(BigInt(String(amount)), decimals)); } catch { return ''; } };
const bucket = (ts: Date, minutes: number): number => Math.floor(ts.getTime() / (minutes * 60_000));
const day = (ts: Date): string => ts.toISOString().slice(0, 10);
export const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

interface Proposal { id: string; kind: string; network: string; symbol: string; decimals: number; amount: string; error: string | null; swap: { toSymbol?: string } | null; bridge: { toNetwork?: string; phase?: string } | null; out_amount: string | null }
const proposal = async (q: Q, id: unknown): Promise<Proposal | null> => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const [p] = await q<Proposal[]>`select id, kind, network, symbol, decimals, amount::text as amount, error, swap, bridge, out_amount::text as out_amount from proposals where id = ${id}`;
  return p ?? null;
};
export const agentName = async (q: Q, id: unknown): Promise<string> => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return '';
  const [a] = await q<{ name: string }[]>`select name from agents where id = ${id}`;
  return a?.name ?? '';
};
/** label and nature of a derivatives account: paper accounts are simulated and always said to be */
export const derivAccount = async (q: Q, id: unknown): Promise<{ label: string; mode: '@paper' | '@live'; paper: boolean; baseline: Record<string, string> }> => {
  if (typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) {
    const [p] = await q<{ label: string }[]>`select label from deriv_paper_accounts where id = ${id}`;
    if (p) return { label: p.label, mode: '@paper', paper: true, baseline: {} };
    const [v] = await q<{ label: string; network: string; meta: { baseline?: Record<string, string> } }[]>`select label, network, meta from deriv_accounts where id = ${id}`;
    if (v) return { label: `${v.label}${v.network === 'testnet' ? ' (testnet)' : ''}`, mode: '@live', paper: false, baseline: v.meta?.baseline ?? {} };
  }
  return { label: '', mode: '@live', paper: false, baseline: {} };
};

// exact decimal arithmetic on the sizes of fills (strings with up to 18 decimals)
const SCALE = 18n;
const toFixed = (s: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return 0n;
  const v = BigInt(m[2]!) * 10n ** SCALE + BigInt((m[3] ?? '').slice(0, Number(SCALE)).padEnd(Number(SCALE), '0'));
  return m[1] ? -v : v;
};
const fromFixed = (v: bigint): string => { const neg = v < 0n, a = neg ? -v : v; return `${neg ? '-' : ''}${trim(`${a / 10n ** SCALE}.${(a % 10n ** SCALE).toString().padStart(Number(SCALE), '0')}`, 8)}`; };

/** position opened / closed, from the net size the alerts layer keeps per (account, instrument) — updated once per fill event */
async function positionChange(c: RuleCtx, accountId: string, acct: Awaited<ReturnType<typeof derivAccount>>, instrument: string, signed: bigint, before: Date, pnl: string | null, subject: AlertSubject): Promise<Draft[]> {
  const key = `pos:${accountId}:${instrument}`;
  const [st] = await c.q<{ value: { net: string } }[]>`select value from alert_state where key = ${key}`;
  let prev: bigint;
  if (st) prev = toFixed(st.value.net);
  else {
    // first fill seen for this pair: start from what was recorded strictly before it (plus the venue baseline the owner accepted)
    const [s] = await c.q<{ net: string }[]>`select coalesce(sum(case when side = 'buy' then size else -size end), 0)::text as net from deriv_fills where account_id = ${accountId} and instrument = ${instrument} and ts < ${before}`;
    prev = toFixed(s?.net ?? '0') + toFixed(acct.baseline[instrument] ?? '0');
  }
  const next = prev + signed;
  await c.q`insert into alert_state (key, value, updated_at) values (${key}, ${c.q.json({ net: fromFixed(next) })}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  const base = { account: acct.label, mode: acct.mode, instrument };
  if (prev === 0n && next !== 0n) return [{ kind: 'deriv.position_opened', params: { ...base, size: fromFixed(next) }, subject }];
  if (prev !== 0n && next === 0n) return [{ kind: 'deriv.position_closed', params: { ...base, pnl: pnl ? trim(pnl, 2) : '' }, subject }];
  return [];
}

const refusedDigest = (ts: Date, reason: string): Draft => ({ kind: 'security.signer_refused', params: { reason: reason.slice(0, 160) }, dedupe: `signer_refused:${bucket(ts, 15)}`, bump: true });
/** which pinned program a refusal text is about */
export function pinOf(code: string, text: string): '@router' | '@jupiter' | '@cctp' | null {
  if (code === 'contract_changed' || /CCTP transfers are refused/.test(text)) return '@cctp';
  if (code === 'router_changed' || /router bytecode is not the reviewed|answered with another router|not the reviewed deployment/.test(text)) return /Jupiter/.test(text) ? '@jupiter' : '@router';
  return null;
}
export const pinDraft = (what: string, reason: string, ts: Date): Draft => ({ kind: 'security.pin_mismatch', params: { what, reason: reason.slice(0, 200) }, dedupe: `pin:${what}:${bucket(ts, 60)}` });

async function fromAudit(e: AlertEvent, c: RuleCtx): Promise<Draft[]> {
  const d = e.data, t = e.type;
  // V11 risk engine: the global kill switch was engaged or released (risk/service.ts writes the audit event)
  if (t === 'risk.kill_switch') return [{ kind: d.engaged === true ? 'security.kill_switch_on' : 'security.kill_switch_off', params: { what: str(d.by, 80), state: str(d.reason, 120) }, subject: { type: 'none' }, dedupe: `kill_switch:${e.id}` }];
  if (t.startsWith('transfer.')) {
    const state = t.slice('transfer.'.length);
    if (state !== 'finalized' && state !== 'failed') return [];
    const p = await proposal(c.q, d.id);
    if (!p) return [];
    const subject: AlertSubject = { type: 'proposal', id: p.id, network: p.network };
    const base = { network: netName(p.network), symbol: p.symbol, amount: units(p.amount, p.decimals) };
    if (state === 'finalized') {
      if (p.kind === 'bridge') return [];                              // the bridge is complete when the destination minted: bridge.done
      return p.kind === 'swap' ? [{ kind: 'swap.confirmed', params: { ...base, toSymbol: str(p.swap?.toSymbol, 20) }, subject }] : [{ kind: 'transfer.confirmed', params: base, subject }];
    }
    const reason = str(d.error ?? p.error, 200);
    if (p.kind === 'bridge') return [{ kind: 'bridge.failed', params: { ...base, to: netName(p.bridge?.toNetwork), reason }, subject }];
    return [{ kind: p.kind === 'swap' ? 'swap.failed' : 'transfer.failed', params: { ...base, reason }, subject }];
  }
  switch (t) {
    case 'bridge.done': {
      const p = await proposal(c.q, d.id);
      if (!p) return [];
      return [{ kind: 'bridge.confirmed', params: { network: netName(p.network), to: netName(d.to ?? p.bridge?.toNetwork), symbol: p.symbol, amount: units(d.minted ?? p.out_amount ?? p.amount, p.decimals) }, subject: { type: 'proposal', id: p.id, network: p.network } }];
    }
    case 'bridge.mint_reverted': {
      const p = await proposal(c.q, d.id);
      if (!p) return [];
      return [{ kind: 'bridge.failed', params: { network: netName(p.network), to: netName(p.bridge?.toNetwork), symbol: p.symbol, amount: units(p.amount, p.decimals), reason: 'the mint transaction reverted on the destination; the funds are not lost, finish the transfer with your passkey' }, subject: { type: 'proposal', id: p.id, network: p.network } }];
    }
    case 'deposit.seen': {
      let symbol = '', amount = '';
      try { const n = getNetwork(String(d.network)), a = d.asset === 'native' ? n.native : n.tokens.find((x) => x.id === d.asset); if (a) { symbol = a.symbol; amount = units(d.amount, a.decimals); } } catch { /* unknown network: no detail */ }
      return [{ kind: 'deposit.received', params: { network: netName(d.network), symbol, amount }, subject: { type: 'deposit', id: str(d.txid, 120), network: str(d.network, 40) } }];
    }
    case 'agent.order_filled': {
      const agent = str(d.agent, 40), n = c.settings.thresholds.agentDigestMinutes;
      const [o] = await c.q<{ from_symbol: string; to_symbol: string }[]>`select from_symbol, to_symbol from agent_orders where id = ${typeof d.id === 'string' ? d.id : '00000000-0000-0000-0000-000000000000'}`;
      return [{ kind: 'agent.order_filled', params: { agent: await agentName(c.q, agent), from: o?.from_symbol ?? '', to: o?.to_symbol ?? '', count: 1 }, subject: { type: 'agent', id: agent },
        ...(n > 0 ? { dedupe: `agent.fill:${agent}:${bucket(e.ts, n)}`, bump: true } : {}) }];
    }
    case 'agent.stopped': {
      const id = str(d.id, 40), reason = str(d.reason, 240), agent = await agentName(c.q, id), subject: AlertSubject = { type: 'agent', id };
      if (/^loss limit/.test(reason)) return [{ kind: 'agent.stopped_loss', params: { agent, reason }, subject }];
      if (/mandate expired/.test(reason)) return [{ kind: 'agent.stopped_mandate', params: { agent }, subject }];
      return [{ kind: 'agent.stopped', params: { agent, reason }, subject }];
    }
    case 'mandate.revoked': return [{ kind: 'agent.mandate_revoked', params: { agent: await agentName(c.q, d.agent) }, subject: { type: 'agent', id: str(d.agent, 40) } }];
    case 'agent.order_refused': return [refusedDigest(e.ts, str(d.reason))];
    // >>> v11 live market making (services/api/src/mm/runtime.ts writes these audit events)
    case 'mm.breaker': return [{ kind: d.halted ? 'agent.mm_halted' : 'agent.mm_breaker', params: { agent: await agentName(c.q, d.agent), mode: `@${str(d.mode, 10)}`, what: str(d.code, 60), state: str(d.action, 20) }, subject: { type: 'agent', id: str(d.agent, 40) }, dedupe: `mm.breaker:${str(d.session, 40)}:${str(d.code, 60)}:${Math.floor(e.ts.getTime() / 300_000)}` }];
    case 'mm.switch_lapse': return [{ kind: 'agent.mm_dead_man_switch', params: { agent: await agentName(c.q, d.agent), count: Number(d.lapses ?? 0) }, subject: { type: 'agent', id: str(d.agent, 40) }, dedupe: `mm.dms:${str(d.agent, 40)}:${str(d.day, 12)}:${Number(d.lapses ?? 0)}` }];
    case 'mm.signer_refusals': return [{ kind: 'agent.mm_signer_refusals', params: { agent: await agentName(c.q, d.agent), count: Number(d.count ?? 0), reason: str(d.code, 80) }, subject: { type: 'agent', id: str(d.agent, 40) }, dedupe: `mm.signer:${str(d.session, 40)}:${str(d.code, 80)}:${Math.floor(e.ts.getTime() / 900_000)}` }];
    case 'mm.rate_budget': return [{ kind: 'agent.mm_rate_budget', params: { agent: await agentName(c.q, d.agent), what: str(d.reason, 120) }, subject: { type: 'agent', id: str(d.agent, 40) }, dedupe: `mm.rate:${str(d.session, 40)}:${Math.floor(e.ts.getTime() / 900_000)}` }];
    case 'mm.session_ended': return [{ kind: 'agent.mm_session_ended', params: { agent: await agentName(c.q, d.agent), mode: `@${str(d.mode, 10)}`, reason: str(d.reason, 200) }, subject: { type: 'agent', id: str(d.agent, 40) }, dedupe: `mm.end:${str(d.session, 40)}` }];
    // <<< v11 live market making
    // >>> v7 research runtime: a job handed in a strategy (the server report is attached) / a job stopped without one
    case 'research.submitted': return [{ kind: 'agent.research_submitted', params: { name: (await agentName(c.q, d.agent)) || str(d.name, 40), count: Number(d.trials ?? 0) }, subject: d.agent ? { type: 'agent', id: str(d.agent, 40) } : { type: 'none' }, dedupe: `research:${str(d.job, 40)}` }];
    case 'research.failed': return [{ kind: 'agent.research_failed', params: { name: (await agentName(c.q, d.agent)) || str(d.name, 40), state: `@${str(d.state, 20)}`, reason: str(d.reason, 200) }, subject: d.agent ? { type: 'agent', id: str(d.agent, 40) } : { type: 'none' }, dedupe: `research:${str(d.job, 40)}` }];
    // <<< v7 research runtime
    case 'deriv.paper.fill': {
      const id = str(d.account, 40), acct = await derivAccount(c.q, id), subject: AlertSubject = { type: 'account', id };
      const [f] = await c.q<{ closed_pnl: string | null; ts: Date }[]>`select closed_pnl::text as closed_pnl, ts from deriv_fills where account_id = ${id} and fill_id = ${str(d.fill, 80)}`;
      const signed = toFixed(str(d.size, 60)) * (d.side === 'sell' ? -1n : 1n);
      return [{ kind: 'deriv.paper.filled', params: { account: acct.label, instrument: str(d.instrument, 80), side: d.side === 'sell' ? '@sell' : '@buy', size: trim(str(d.size, 60), 8), price: trim(str(d.price, 60), 8) }, subject },
        ...(await positionChange(c, id, acct, str(d.instrument, 80), signed, f?.ts ?? e.ts, f?.closed_pnl ?? null, subject))];
    }
    case 'deriv.paper.liquidation': case 'deriv.paper.reset': {
      const id = str(d.account, 40);
      await c.q`delete from alert_state where key like ${`pos:${id}:%`}`;   // every position of the account is gone
      if (t === 'deriv.paper.reset') return [];
      return [{ kind: 'deriv.paper.liquidation', params: { account: (await derivAccount(c.q, id)).label, positions: Number(d.positions ?? 0) }, subject: { type: 'account', id } }];
    }
    case 'deriv.paper.halt': {
      const id = str(d.account, 40);
      return [{ kind: 'deriv.loss_limit', severity: 'warning', params: { account: (await derivAccount(c.q, id)).label, mode: '@paper', scope: d.code === 'daily_loss_exceeded' ? '@daily' : '@total' }, subject: { type: 'account', id } }];
    }
    case 'deriv.live.halt': {
      const id = str(d.account, 40);
      return [{ kind: 'deriv.halt', params: { account: (await derivAccount(c.q, id)).label, reason: str(d.reason, 200) }, subject: { type: 'account', id } }];
    }
    case 'deriv.live.order_rejected': {
      const id = str(d.account, 40), acct = await derivAccount(c.q, id);
      return [{ kind: 'deriv.order_rejected', params: { account: acct.label, mode: acct.mode, reason: str(d.reason, 200), count: 1 }, subject: { type: 'account', id }, dedupe: `deriv.rejected:${id}:${bucket(e.ts, 10)}`, bump: true }];
    }
    case 'deriv.paper.policy_replaced': case 'deriv.live.policy_replaced': {
      const id = str(d.account, 40), acct = await derivAccount(c.q, id);
      return [{ kind: 'security.policy_changed', params: { what: '@derivatives', name: acct.label, detail: `${acct.label}${d.maxLeverage !== undefined ? `, max leverage ${str(d.maxLeverage, 10)}` : ''}` }, subject: { type: 'account', id } }];
    }
    case 'device.added': return [{ kind: 'security.passkey_added', params: { label: str(d.label, 40) }, subject: { type: 'none' } }];
    case 'login.failed': return [{ kind: 'security.login_failed', params: { ip: str(d.ip, 60), count: 1 }, dedupe: `login_failed:${bucket(e.ts, 15)}`, bump: true }];
    case 'login.ok': return newDevice(e, c);
    // v7 any-to-any plans: the plan saga records these itself (services/api/src/plan-exec.ts); every parameter comes from the event
    case 'plan.step_ready': return [{ kind: 'plan.step_ready', params: { what: str(d.what, 60), step: Number(d.step) || 0, steps: Number(d.steps) || 0, network: netName(d.network) }, subject: { type: 'plan', id: str(d.id, 40) }, dedupe: `plan_ready:${str(d.id, 40)}:${Number(d.step) || 0}:${e.id}` }];
    case 'plan.paused': return [{ kind: 'plan.paused', params: { what: str(d.what, 60), step: Number(d.step) || 0, steps: Number(d.steps) || 0, network: netName(d.network), reason: str(d.reason, 200) }, subject: { type: 'plan', id: str(d.id, 40) } }];
    case 'plan.done': {
      const [pl] = /^[0-9a-f-]{36}$/.test(str(d.id, 40)) ? await c.q<{ meta: { to?: { network: string; asset: string } } }[]>`select meta from plans where id = ${str(d.id, 40)}` : [];
      let symbol = '', amount = '';
      try { const to = pl?.meta.to; if (to) { const n = getNetwork(to.network), a = to.asset === 'native' ? n.native : n.tokens.find((x) => x.id.toLowerCase() === to.asset.toLowerCase()); if (a) { symbol = a.symbol; amount = units(d.received, a.decimals); } } } catch { /* no detail */ }
      return [{ kind: 'plan.done', params: { what: str(d.what, 60), steps: Number(d.steps) || 0, amount, symbol }, subject: { type: 'plan', id: str(d.id, 40) } }];
    }
    default:
  }
  if (t.startsWith('deriv.live.order_') && d.final === true) {
    // a venue order reached a final state: an alert when it filled, and the position it leaves behind
    const id = str(d.account, 40), filled = toFixed(str(d.filled, 60) || '0');
    const [o] = await c.q<{ instrument: string; side: string }[]>`select instrument, side from deriv_orders where account_id = ${id} and client_id = ${str(d.clientId, 80)}`;
    if (!o) return [];
    const acct = await derivAccount(c.q, id), subject: AlertSubject = { type: 'account', id }, out: Draft[] = [];
    if (t === 'deriv.live.order_filled') out.push({ kind: 'deriv.live.filled', params: { account: acct.label, instrument: o.instrument, side: o.side === 'sell' ? '@sell' : '@buy', size: trim(str(d.filled, 60), 8), price: trim(str(d.avgFillPrice, 60), 8) }, subject });
    if (filled !== 0n) out.push(...(await positionChange(c, id, acct, o.instrument, o.side === 'sell' ? -filled : filled, e.ts, null, subject)));
    return out;
  }
  if (t.endsWith('.denied')) return [refusedDigest(e.ts, str(d.reason ?? t))];
  return [];
}

/** a sign-in whose browser was never seen: the set of known user agents lives in alert_state and starts from the sessions on record */
async function newDevice(e: AlertEvent, c: RuleCtx): Promise<Draft[]> {
  const [s] = await c.q<{ ua: string; ip: string }[]>`select ua, ip from sessions where ip = ${str(e.data.ip, 80)} order by created_at desc limit 1`;
  if (!s) return [];
  const key = 'known_devices';
  const [st] = await c.q<{ value: { ua: string[] } }[]>`select value from alert_state where key = ${key}`;
  let known: string[];
  if (st) known = st.value.ua;
  else {
    // first use: the browsers that opened a session before this sign-in are known; on a brand-new wallet the first device is not "new"
    known = (await c.q<{ ua: string }[]>`select distinct ua from sessions where created_at < ${new Date(e.ts.getTime() - 2000)}`).map((r) => r.ua);
    if (known.length === 0) known = [s.ua];
  }
  const fresh = !known.includes(s.ua);
  if (fresh || !st) await c.q`insert into alert_state (key, value, updated_at) values (${key}, ${c.q.json({ ua: [...new Set([...known, s.ua])].slice(-50) })}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return fresh ? [{ kind: 'security.new_device', params: { device: describeUa(s.ua), ip: s.ip }, subject: { type: 'none' } }] : [];
}
export function describeUa(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 40) || '?';
}

async function fromRisk(e: AlertEvent, c: RuleCtx): Promise<Draft[]> {
  const id = e.accountId ?? '', acct = await derivAccount(c.q, id), subject: AlertSubject = { type: 'account', id }, base = { account: acct.label, mode: acct.mode };
  switch (e.type) {
    case 'margin_warning': return [{ kind: 'deriv.margin_warning', params: { ...base, reason: str(e.message, 240) }, subject, dedupe: `margin:${id}:${bucket(e.ts, 60)}` }];
    case 'order_refused':
      if (String(e.code ?? '').startsWith('signer')) return [refusedDigest(e.ts, str(e.message))];
      return [{ kind: 'deriv.order_rejected', params: { ...base, reason: str(e.message, 200), count: 1 }, subject, dedupe: `deriv.rejected:${id}:${bucket(e.ts, 10)}`, bump: true }];
    case 'divergence': return [{ kind: 'deriv.divergence', params: { account: acct.label, reason: str(e.message, 300) }, subject }];
    case 'divergence_cleared': return [{ kind: 'deriv.divergence_cleared', params: { account: acct.label }, subject }];
    default: return [];                                              // liquidation, loss limit and halt come from the audit chain
  }
}

async function fromResearch(e: AlertEvent, c: RuleCtx): Promise<Draft[]> {
  if (e.type !== 'hold' || !e.agentId) return [];
  const text = str(e.message, 300);
  if (e.title === 'Order not placed') {
    const what = pinOf('', text);
    return what ? [pinDraft(what, text, e.ts)] : [];
  }
  if (e.title !== 'No valid signal: holding') return [];
  // one such entry is written per bar at most: N of them inside N bars are N failures in a row
  const n = c.settings.thresholds.signalFailures;
  const [a] = await c.q<{ name: string; interval: string }[]>`select name, interval from agents where id = ${e.agentId}`;
  if (!a) return [];
  const span = (INTERVAL_MS[a.interval] ?? 3_600_000) * n + 120_000;
  const [r] = await c.q<{ n: number }[]>`select count(*)::int as n from research_log where agent_id = ${e.agentId} and kind = 'hold' and title = 'No valid signal: holding' and id <= ${e.id} and ts > ${new Date(e.ts.getTime() - span)}`;
  if ((r?.n ?? 0) < n) return [];
  return [{ kind: 'agent.signal_failures', params: { agent: a.name, count: r!.n }, subject: { type: 'agent', id: e.agentId }, dedupe: `sigfail:${e.agentId}:${day(e.ts)}` }];
}

export async function deriveAlerts(e: AlertEvent, c: RuleCtx): Promise<Draft[]> {
  return e.source === 'audit' ? fromAudit(e, c) : e.source === 'risk' ? fromRisk(e, c) : fromResearch(e, c);
}
