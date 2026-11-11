import { useQuery } from '@tanstack/react-query';
import { useContext, type ReactNode } from 'react';
import { get } from '../api';
import { useSettings } from '../hooks';
import { I18n, useT, type Key } from '../i18n';
import { Card, fiat, H, Icon, Notice, Skeleton, when } from '../ui';

interface Pnl { abs: number; pct: number | null; partial: boolean; from: number }
interface PnlRow { id: string; name?: string; label?: string; real: boolean; kind?: string; mode?: string; today: Pnl | null; d7: Pnl | null; d30: Pnl | null; equity: number | null; asOf: number | null }
interface Capital {
  asOf: number; wallet: { usd: number | null; cad: number | null; assets: number; unpriced: number; unavailable: number };
  agents: { id: string; name: string; state: string; network: string; mode: string; real: boolean; capitalUsd: number; equityUsd: number | null; asOf: number | null; positions: number; lastBar: number | null; stopReason: string | null; mandateExpiresAt: number | null }[];
  derivatives: { id: string; label: string; venue: string; network: string; kind: 'paper' | 'venue'; real: boolean; mode: string; equity: number | null; marginUsed: number | null; asOf: number | null; halt: string | null; divergence: string | null; positions: number; openOrders: number }[];
  totals: { agentsLiveUsd: number; agentsPaperUsd: number; derivVenueUsd: number; derivPaperUsd: number; derivTestnetUsd: number };
  counts: { agents: Record<string, number>; openPositions: { agents: number; derivatives: number }; openOrders: { agents: number; derivatives: number } };
}
interface Exposure { asset: string; spotUsd: number; perpLongUsd: number; perpShortUsd: number; netUsd: number; grossUsd: number; priced: boolean }
interface Health {
  asOf: number; connectors: { id: string; group: string; name: string; ok: boolean | null; lastSuccessAt: number | null; ageSec: number | null; detail: string }[];
  loopsNote?: string | null; lab?: { mode: 'sandbox-exec' | 'off' | 'unavailable'; ok: boolean; reason: string | null } | null; capabilities?: { id: string; on: boolean; missing: string[]; why: string }[];
  loops: { name: string; everyMs: number; runs: number; lastOkAt: number | null; lastError: string | null; failures: number; ageSec: number | null; late: boolean }[];
  backup: { visible: boolean; lastAt: number | null; files: number; ageHours: number | null }; disk: { freePct: number; freeGb: number; totalGb: number } | null;
  audit: { intact: boolean; total: number; brokenAt: number | null; checkedAt: number }; signer: { reachable: boolean; halted: boolean | null };
  versions: { apiCommit: string | null; apiVersion: string; node: string; startedAt: number; signerKeyId: string | null; signerPolicyVersion: number | null };
}

/** "3 min", "2 h", "4 j" — an age, never a colour alone */
const age = (sec: number | null, fr: boolean): string => sec === null ? '—' : sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172_800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86_400)} ${fr ? 'j' : 'd'}`;
function Tag({ real }: { real: boolean }) {
  const t = useT();
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${real ? 'bg-emerald/10 text-emerald' : 'bg-elev text-mute'}`}>{t(real ? 'moReal' : 'moSimulated')}</span>;
}
function Status({ ok, children }: { ok: boolean | null; children?: ReactNode }) {
  const t = useT();
  const [cls, icon, key] = ok === null ? ['text-mute', 'clock', 'moUnknown'] as const : ok ? ['text-emerald', 'check', 'moOk'] as const : ['text-danger', 'warn', 'moDown'] as const;
  return <span className={`inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold ${cls}`}><Icon n={icon} className="h-3.5 w-3.5" />{children ?? t(key)}</span>;
}

export function Monitor({ open }: { open: (path: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings(); const fr = locale === 'fr';
  const cap = useQuery({ queryKey: ['mon-capital'], queryFn: () => get<Capital>('/monitor/capital'), refetchInterval: 30_000 });
  const pnl = useQuery({ queryKey: ['mon-pnl'], queryFn: () => get<{ agents: PnlRow[]; derivatives: PnlRow[]; tz: string }>('/monitor/pnl'), refetchInterval: 60_000 });
  const exp = useQuery({ queryKey: ['mon-exposure'], queryFn: () => get<{ real: Exposure[]; simulated: Exposure[] }>('/monitor/exposure'), refetchInterval: 60_000 });
  const health = useQuery({ queryKey: ['mon-health'], queryFn: () => get<Health>('/monitor/health'), refetchInterval: 20_000 });
  const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : fiat(n, 'USD', locale));
  const signed = (p: Pnl | null) => p === null ? <span className="text-mute">—</span>
    : <span className={p.abs > 0 ? 'text-emerald' : p.abs < 0 ? 'text-danger' : ''}>{p.abs > 0 ? '+' : p.abs < 0 ? '−' : ''}{fiat(Math.abs(p.abs), 'USD', locale)}{p.partial && <sup title={t('moPartial')}>*</sup>}</span>;
  const c = cap.data, h = health.data;
  const pnlRows = [...(pnl.data?.agents ?? []).map((r) => ({ ...r, title: r.name ?? '', sub: t('moAgent') })), ...(pnl.data?.derivatives ?? []).map((r) => ({ ...r, title: r.label ?? '', sub: t('moDerivAccount') }))];
  const anyPartial = pnlRows.some((r) => r.today?.partial || r.d7?.partial || r.d30?.partial);
  const groups = ['signer', 'database', 'rpc', 'market', 'venue', 'swap', 'bridge'] as const;
  const down = h?.connectors.filter((x) => x.ok === false) ?? [];
  return (
    <div className="space-y-4" data-testid="monitor-screen">
      <h1 className="pt-2 text-[30px] font-semibold tracking-[-0.02em]">{t('moTitle')}</h1>
      {h && (down.length === 0 && h.audit.intact
        ? <Notice tone="ok">{t('moAllOk', { n: h.connectors.filter((x) => x.ok).length })}</Notice>
        : <Notice tone="danger">{!h.audit.intact ? `${t('moAuditBroken')} ` : ''}{down.length > 0 ? `${t('moSomeDown')} ${down.map((x) => x.name).join(', ')}` : ''}</Notice>)}

      <Card><H>{t('moCapital')}</H>
        {!c ? <Skeleton h="h-32" /> : <>
          <p className="mb-3 text-[12.5px] text-mute">{t('moCapitalNote')}</p>
          <dl className="divide-y divide-line text-[14.5px]" data-testid="monitor-capital">
            <div className="flex items-center justify-between gap-3 py-2.5"><dt className="min-w-0"><span className="block font-semibold">{t('moWallet')}</span><span className="block text-xs text-mute">{t('moWalletSub', { n: c.wallet.assets })}{c.wallet.unpriced ? ` · ${t('moUnpriced', { n: c.wallet.unpriced })}` : ''}{c.wallet.unavailable ? ` · ${t('moUnavailable', { n: c.wallet.unavailable })}` : ''}</span></dt>
              <dd className="flex items-center gap-2 font-semibold"><Tag real />{c.wallet.usd === null ? '—' : settings.currency === 'CAD' && c.wallet.cad !== null ? fiat(c.wallet.cad, 'CAD', locale) : usd(c.wallet.usd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-2.5"><dt className="min-w-0"><span className="block font-semibold">{t('moAgentVaults')}</span><span className="block text-xs text-mute">{t('moAgentVaultsSub')}</span></dt><dd className="flex items-center gap-2 font-semibold"><Tag real />{usd(c.totals.agentsLiveUsd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-2.5"><dt className="min-w-0"><span className="block font-semibold">{t('moDerivVenue')}</span><span className="block text-xs text-mute">{t('moDerivVenueSub')}</span></dt><dd className="flex items-center gap-2 font-semibold"><Tag real />{usd(c.totals.derivVenueUsd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-2.5 text-mute"><dt>{t('moAgentsPaper')}</dt><dd className="flex items-center gap-2"><Tag real={false} />{usd(c.totals.agentsPaperUsd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-2.5 text-mute"><dt>{t('moDerivPaper')}</dt><dd className="flex items-center gap-2"><Tag real={false} />{usd(c.totals.derivPaperUsd)}</dd></div>
            {c.totals.derivTestnetUsd > 0 && <div className="flex items-center justify-between gap-3 py-2.5 text-mute"><dt>{t('moDerivTestnet')}</dt><dd className="flex items-center gap-2"><Tag real={false} />{usd(c.totals.derivTestnetUsd)}</dd></div>}
          </dl>
          <div className="mt-4 grid grid-cols-2 gap-2.5 text-center sm:grid-cols-4">{([['moOpenPositions', c.counts.openPositions.agents + c.counts.openPositions.derivatives], ['moOpenOrders', c.counts.openOrders.agents + c.counts.openOrders.derivatives],
            ['moAgentsActive', (c.counts.agents.LIVE ?? 0) + (c.counts.agents.PAPER_TRADING ?? 0)], ['moAgentsStopped', c.counts.agents.STOPPED ?? 0]] as const).map(([k, n]) =>
            <div key={k} className="rounded-2xl bg-elev px-2 py-3"><div className="text-[22px] font-semibold leading-none">{n}</div><div className="mt-1 text-[11.5px] text-mute">{t(k)}</div></div>)}</div>
        </>}
      </Card>

      {c && (c.agents.length > 0 || c.derivatives.length > 0) && <Card><H>{t('moAccounts')}</H>
        <ul className="divide-y divide-line">{c.agents.map((a) => <li key={a.id}><button className="flex w-full items-center justify-between gap-3 py-3 text-left" onClick={() => open(`/agents/${a.id}`)}>
          <span className="min-w-0"><span className="flex items-center gap-2"><span className="truncate text-[14.5px] font-semibold">{a.name}</span><Tag real={a.real} /></span>
            <span className="block truncate text-xs text-mute">{t('moAgent')} · {a.state}{a.lastBar ? ` · ${t('moLastBar')} ${when(new Date(a.lastBar), locale)}` : ''}{a.stopReason && a.state === 'STOPPED' ? ` · ${a.stopReason}` : ''}</span></span>
          <span className="shrink-0 text-right text-[14.5px] font-semibold">{usd(a.equityUsd)}<span className="block text-xs font-normal text-mute">{t('moAllocated')} {usd(a.capitalUsd)}</span></span></button></li>)}
        {c.derivatives.map((a) => <li key={a.id}><button className="flex w-full items-center justify-between gap-3 py-3 text-left" onClick={() => open('/futures?v=accounts')}>
          <span className="min-w-0"><span className="flex items-center gap-2"><span className="truncate text-[14.5px] font-semibold">{a.label}</span><Tag real={a.real} /></span>
            <span className="block truncate text-xs text-mute">{a.venue} {a.network} · {a.mode} · {a.positions} {t('moPositionsShort')} · {a.openOrders} {t('moOrdersShort')}{a.halt ? ` · ${t('moHalted')}` : ''}{a.divergence ? ` · ${t('moDivergence')}` : ''}</span></span>
          <span className="shrink-0 text-right text-[14.5px] font-semibold">{usd(a.equity)}</span></button></li>)}</ul></Card>}

      <Card><H>{t('moPnl')}</H>
        {!pnl.data ? <Skeleton h="h-24" /> : pnlRows.length === 0 ? <p className="text-[13.5px] text-mute">{t('moNoSeries')}</p> : <>
          <div className="-mx-1 overflow-x-auto"><table className="w-full min-w-[340px] text-[13.5px]" data-testid="monitor-pnl">
            <thead><tr className="text-left text-xs text-mute"><th className="px-1 py-1.5 font-medium">{t('moAccount')}</th><th className="px-1 py-1.5 text-right font-medium">{t('moToday')}</th><th className="px-1 py-1.5 text-right font-medium">{t('mo7d')}</th><th className="px-1 py-1.5 text-right font-medium">{t('mo30d')}</th></tr></thead>
            <tbody className="divide-y divide-line">{pnlRows.map((r) => <tr key={r.id}><td className="px-1 py-2"><span className="block font-semibold leading-tight">{r.title}</span><span className="text-xs text-mute">{r.sub} · {t(r.real ? 'moReal' : 'moSimulated')}</span></td>
              <td className="px-1 py-2 text-right font-medium tabular-nums">{signed(r.today)}</td><td className="px-1 py-2 text-right font-medium tabular-nums">{signed(r.d7)}</td><td className="px-1 py-2 text-right font-medium tabular-nums">{signed(r.d30)}</td></tr>)}</tbody></table></div>
          <p className="mt-3 text-[12.5px] text-mute">{t('moPnlNote')}{anyPartial ? ` ${t('moPartialNote')}` : ''}</p></>}
      </Card>

      <Card><H>{t('moExposure')}</H>
        {!exp.data ? <Skeleton h="h-24" /> : <>
          {([['moReal', exp.data.real], ['moSimulated', exp.data.simulated]] as const).map(([k, rows]) => <div key={k} className="mb-4 last:mb-0"><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-mute">{t(k)}</div>
            {rows.length === 0 ? <p className="text-[13.5px] text-mute">{t('moNoExposure')}</p> : <div className="-mx-1 overflow-x-auto"><table className="w-full min-w-[340px] text-[13.5px]">
              <thead><tr className="text-left text-xs text-mute"><th className="px-1 py-1.5 font-medium">{t('moAsset')}</th><th className="px-1 py-1.5 text-right font-medium">{t('moSpot')}</th><th className="px-1 py-1.5 text-right font-medium">{t('moPerp')}</th><th className="px-1 py-1.5 text-right font-medium">{t('moNet')}</th><th className="px-1 py-1.5 text-right font-medium">{t('moGross')}</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.asset}><td className="px-1 py-2 font-semibold">{r.asset}{!r.priced && <sup title={t('moUnpricedRow')}>†</sup>}</td><td className="px-1 py-2 text-right tabular-nums">{usd(r.spotUsd)}</td>
                <td className="px-1 py-2 text-right tabular-nums">{r.perpLongUsd - r.perpShortUsd < 0 ? '−' : ''}{usd(Math.abs(r.perpLongUsd - r.perpShortUsd))}</td><td className="px-1 py-2 text-right font-medium tabular-nums">{r.netUsd < 0 ? '−' : ''}{usd(Math.abs(r.netUsd))}</td><td className="px-1 py-2 text-right tabular-nums">{usd(r.grossUsd)}</td></tr>)}</tbody></table></div>}</div>)}
          <p className="mt-3 text-[12.5px] text-mute">{t('moExposureNote')}</p></>}
      </Card>

      <Card><H right={h && <span className="text-xs text-mute">{when(new Date(h.asOf), locale)}</span>}>{t('moConnectors')}</H>
        {!h ? <Skeleton h="h-40" /> : <div className="space-y-4" data-testid="monitor-connectors">{groups.map((g) => { const rows = h.connectors.filter((x) => x.group === g); if (!rows.length) return null;
          const bad = rows.filter((x) => x.ok === false).length, unknown = rows.filter((x) => x.ok === null).length;
          return <details key={g} open={bad > 0 || rows.length <= 4}><summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3">
            <span className="text-[14.5px] font-semibold">{t(`moGroup_${g}` as Key)} <span className="font-normal text-mute">({rows.length})</span></span>
            <Status ok={bad > 0 ? false : unknown === rows.length ? null : true}>{bad > 0 ? t('moNDown', { n: bad }) : unknown === rows.length ? t('moUnknown') : t('moOk')}</Status></summary>
            <ul className="mt-1 space-y-2">{rows.map((x) => <li key={x.id} className="flex items-center justify-between gap-3 text-[13px]"><span className="min-w-0"><span className="block truncate font-medium">{x.name}</span><span className="block truncate text-xs text-mute">{x.detail}</span></span>
              <span className="shrink-0 text-right"><Status ok={x.ok} /><span className="block text-xs text-mute">{t('moLastSuccess')} {age(x.ageSec, fr)}</span></span></li>)}</ul></details>; })}</div>}
      </Card>

      <Card><H>{t('moSystem')}</H>
        {!h ? <Skeleton h="h-32" /> : <>
          <ul className="space-y-2 text-[13px]" data-testid="monitor-loops">{h.loops.length === 0 ? <li className="text-mute">{t('moNoLoops')}</li> : h.loops.map((l) => <li key={l.name} className="flex items-center justify-between gap-3">
            <span className="min-w-0"><span className="block font-medium">{l.name}</span><span className="block truncate text-xs text-mute">{t('moEvery')} {age(Math.round(l.everyMs / 1000), fr)}{l.lastError && l.failures > 0 ? ` · ${l.lastError}` : ''}</span></span>
            <span className="shrink-0 text-right"><Status ok={l.lastOkAt === null && l.failures === 0 ? null : l.failures === 0 && !l.late}>{l.failures > 0 ? t('moNFailures', { n: l.failures }) : l.late ? t('moLate') : undefined}</Status><span className="block text-xs text-mute">{t('moLastSuccess')} {age(l.ageSec, fr)}</span></span></li>)}</ul>
          {h.loopsNote && <p className="mt-2 text-xs text-mute">{t('moLoopsNote')}</p>}
          {/* v8 hardening: the strategy sandbox and the optional capabilities of the server (variable names only) */}
          {h.lab && <div className="mt-4 border-t border-line pt-4 text-[13px]" data-testid="monitor-lab"><div className="flex items-center justify-between gap-3"><span className="font-medium">{t('hdMoLab')}</span>
            <Status ok={h.lab.ok}>{h.lab.mode === 'sandbox-exec' ? t('hdMoLabOk') : h.lab.mode === 'off' ? t('hdMoLabOff') : t('hdMoLabDown')}</Status></div>
            {!h.lab.ok && <p className="mt-1 text-xs text-mute">{h.lab.mode === 'off' ? t('hdMoLabOffNote') : t('hdMoLabDownNote')}{h.lab.reason ? ` (${h.lab.reason})` : ''}</p>}</div>}
          {h.capabilities && <ul className="mt-4 space-y-2 border-t border-line pt-4 text-[13px]" data-testid="monitor-capabilities">{h.capabilities.map((c) => <li key={c.id} className="flex items-start justify-between gap-3">
            <span className="min-w-0"><span className="block font-medium">{t(`hdCap_${c.id}` as Key)}</span>{!c.on && c.missing.length > 0 && <span className="block truncate font-mono text-xs text-mute">{c.missing.join(' + ')}</span>}</span>
            <Status ok={c.on ? true : c.id === 'research_readonly_db' || c.id === 'web_app' || c.id === 'deriv_live_mainnet' || c.id === 'deriv_mandate_mainnet' || c.id === 'research_runner' ? null : false}>{c.on ? t('hdCapOn') : t('hdCapOff')}</Status></li>)}</ul>}
          <dl className="mt-4 space-y-2 border-t border-line pt-4 text-[13px]">
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('moBackup')}</dt><dd className="text-right font-medium">{!h.backup.visible ? t('moBackupInvisible') : h.backup.lastAt === null ? t('moBackupNone') : <><Status ok={(h.backup.ageHours ?? 0) <= 36}>{when(new Date(h.backup.lastAt), locale)}</Status></>}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('moDisk')}</dt><dd className="font-medium">{h.disk ? `${h.disk.freePct} % · ${h.disk.freeGb} / ${h.disk.totalGb} ${fr ? 'Go' : 'GB'}` : '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('moAudit')}</dt><dd><Status ok={h.audit.intact}>{h.audit.intact ? t('moAuditOk', { n: h.audit.total }) : t('moAuditBroken')}</Status></dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('moSigner')}</dt><dd><Status ok={h.signer.reachable && !h.signer.halted}>{!h.signer.reachable ? t('moDown') : h.signer.halted ? t('moHalted') : t('moOk')}</Status></dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('moApiVersion')}</dt><dd className="font-mono">{h.versions.apiVersion}{h.versions.apiCommit ? ` · ${h.versions.apiCommit}` : ''}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('moStarted')}</dt><dd>{when(new Date(h.versions.startedAt), locale)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('moSignerKey')}</dt><dd className="truncate font-mono">{h.versions.signerKeyId ?? '—'}{h.versions.signerPolicyVersion !== null ? ` · v${h.versions.signerPolicyVersion}` : ''}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">Node</dt><dd className="font-mono">{h.versions.node}</dd></div>
          </dl></>}
      </Card>
    </div>
  );
}
