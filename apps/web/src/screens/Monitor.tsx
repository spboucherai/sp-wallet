import { useQuery } from '@tanstack/react-query';
import { useContext, type ReactNode } from 'react';
import { get } from '../api';
import { useSettings } from '../hooks';
import { I18n, useT, type Key } from '../i18n';
import { AssetIcon, Card, ErrorState, Fact, fiat, Fold, Icon, NetworkIcon, PageTitle, ProviderIcon, Section, SkeletonCard, SkeletonRows, SkeletonStats, Stat, StatGrid, Tag, VenueIcon, when } from '../ui';
import { reasonText } from '../reasonTexts';
import { srvText } from '../srvText'; // v11 interface (audit B3): a server sentence without a code is translated when known, quoted as English otherwise

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
interface Connector { id: string; group: string; name: string; ok: boolean | null; lastSuccessAt: number | null; ageSec: number | null; detail: string }
interface Health {
  asOf: number; connectors: Connector[];
  loopsNote?: string | null; lab?: { mode: 'sandbox-exec' | 'off' | 'unavailable'; ok: boolean; reason: string | null } | null; capabilities?: { id: string; on: boolean; missing: string[]; why: string }[];
  loops: { name: string; everyMs: number; runs: number; lastOkAt: number | null; lastError: string | null; failures: number; ageSec: number | null; late: boolean }[];
  backup: { visible: boolean; lastAt: number | null; files: number; ageHours: number | null }; disk: { freePct: number; freeGb: number; totalGb: number } | null;
  audit: { intact: boolean; total: number; brokenAt: number | null; checkedAt: number }; signer: { reachable: boolean; halted: boolean | null };
  versions: { apiCommit: string | null; apiVersion: string; node: string; startedAt: number; signerKeyId: string | null; signerPolicyVersion: number | null };
}

/** "3 min", "2 h", "4 j" — an age, never a colour alone */
const age = (sec: number | null, fr: boolean): string => sec === null ? '—' : sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172_800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86_400)} ${fr ? 'j' : 'd'}`;
/** real money or simulated: the word is always written */
function RealTag({ real }: { real: boolean }) {
  const t = useT();
  return <Tag tone={real ? 'ok' : 'mute'}>{t(real ? 'moReal' : 'moSimulated')}</Tag>;
}
/** a state as icon + word: answering (check), down (warning sign), not measured (clock) */
function Status({ ok, children }: { ok: boolean | null; children?: ReactNode }) {
  const t = useT();
  const [cls, icon, key] = ok === null ? ['text-mute', 'clock', 'moUnknown'] as const : ok ? ['text-emerald', 'check', 'moOk'] as const : ['text-danger', 'warn', 'moDown'] as const;
  return <span className={`inline-flex min-w-0 items-center gap-1 text-[12.5px] font-semibold ${cls}`} data-ok={String(ok)}><Icon n={icon} className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0">{children ?? t(key)}</span></span>;
}
/** one part of the system on the board: what it is, its state (icon + word), and what that means when it is not well */
function Tile({ icon, label, ok, state, children, testid }: { icon: string; label: string; ok: boolean | null; state: ReactNode; children?: ReactNode; testid?: string }) {
  const bad = ok === false;
  return <div className={`rounded-[18px] border p-3.5 ${bad ? 'border-danger/40 bg-danger/[0.07]' : 'border-transparent bg-elev/70'}`} data-testid={testid} data-ok={String(ok)}>
    <div className="flex items-center gap-2 text-[12.5px] text-mute"><Icon n={icon} className="h-4 w-4 shrink-0" /><span className="min-w-0">{label}</span></div>
    <div className={`mt-1.5 flex items-start gap-1.5 text-[15.5px] font-semibold leading-snug ${bad ? 'text-danger' : ok ? 'text-emerald' : ''}`}>{ok !== null && <Icon n={bad ? 'warn' : 'check'} className="mt-[3px] h-4 w-4 shrink-0" />}<span className="min-w-0 break-words">{state}</span></div>
    {children && <div className={`mt-1 break-words text-[12.5px] leading-snug ${bad ? 'text-ink/85' : 'text-mute'}`}>{children}</div>}</div>;
}
const GROUP_ICON: Record<string, string> = { signer: 'key', database: 'list', market: 'chart', bridge: 'swap', venue: 'bars', swap: 'swap' };

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
  const groups = ['signer', 'database', 'market', 'venue', 'swap', 'bridge'] as const;
  const down = h?.connectors.filter((x) => x.ok === false) ?? [];
  // the verdict only sums up flags this screen already shows below (a connector down, the audit chain, a failing or late loop,
  // the strategy sandbox, the signer, an old backup): nothing is measured here
  const loopBad = (l: Health['loops'][number]) => l.failures > 0 || l.late;
  const badLoops = h?.loops.filter(loopBad) ?? [], signerOk = !!h && h.signer.reachable && !h.signer.halted, backupOld = !!h && h.backup.visible && h.backup.lastAt !== null && (h.backup.ageHours ?? 0) > 36;
  const allOk = !!h && down.length === 0 && h.audit.intact && badLoops.length === 0 && (!h.lab || h.lab.ok) && signerOk && !backupOld;
  const nets = h?.connectors.filter((x) => x.group === 'rpc') ?? [];
  const logo = (x: Connector) => { const [g, id] = x.id.split(':'); return g === 'venue' && id ? <VenueIcon venue={id} size={30} /> : g === 'swap' && id ? <ProviderIcon provider={id} size={30} /> : g === 'bridge' ? <ProviderIcon provider="cctp" size={30} />
    : <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-elev text-mute" aria-hidden="true"><Icon n={GROUP_ICON[x.group] ?? 'list'} className="h-4 w-4" /></span>; };
  return (
    <div className="space-y-5" data-testid="monitor-screen">
      <PageTitle right={<button type="button" onClick={() => open('/risk')} className="row-press flex min-h-11 items-center gap-1.5 rounded-full bg-elev px-3.5 text-[13.5px] font-semibold" data-testid="mon-risk"><Icon n="shield" className="h-4 w-4" />{t('rkTitle')}</button>}>{t('moTitle')}</PageTitle>{/* v11 Risk */}

      {/* one overall status: an icon and a sentence */}
      {!h ? (health.isError ? <ErrorState title={t('dzMoLoadFailed')} onRetry={() => void health.refetch()}>{t('dzMoLoadFailedBody')}</ErrorState> : <SkeletonCard lines={1} />)
        : <section className={`card flex items-start gap-4 p-5 ${allOk ? '' : '!border-danger/40'}`} role={allOk ? 'status' : 'alert'} data-testid="monitor-verdict" data-ok={allOk}>
          <span className={`grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full ${allOk ? 'bg-emerald/12 text-emerald' : 'bg-danger/10 text-danger'}`} aria-hidden="true"><Icon n={allOk ? 'check' : 'warn'} className="h-7 w-7" /></span>
          <div className="min-w-0 flex-1"><h2 className={`text-[20px] font-semibold leading-tight tracking-[-0.02em] ${allOk ? '' : 'text-danger'}`}>{t(allOk ? 'dzMoAllWell' : 'dzMoAttention')}</h2>
            {allOk ? <p className="mt-1 text-[14px] leading-snug text-mute">{t('moAllOk', { n: h.connectors.filter((x) => x.ok).length })}</p>
              : <ul className="mt-1.5 space-y-1 text-[14px] leading-snug">
                {!h.audit.intact && <li>{t('moAuditBroken')}</li>}
                {down.length > 0 && <li>{`${t('moSomeDown')} ${down.map((x) => x.name).join(', ')}`}</li>}
                {badLoops.length > 0 && <li>{t('dzMoLoopsBad', { n: badLoops.length })} <span className="font-mono text-[13px]">{badLoops.map((l) => l.name).join(', ')}</span></li>}
                {h.lab && !h.lab.ok && <li>{t('hdMoLab')} : {h.lab.mode === 'off' ? t('hdMoLabOff') : t('hdMoLabDown')}</li>}
                {!signerOk && <li>{t('moSigner')} : {!h.signer.reachable ? t('moDown') : t('moHalted')}</li>}
                {backupOld && <li>{t('dzMoBackupOld')}</li>}</ul>}
            <p className="mt-2 text-xs text-mute">{t('dzMoAsOf', { when: when(new Date(h.asOf), locale) })}</p></div></section>}

      <div className="space-y-5" data-testid="monitor-connectors">
        {/* networks: each with its logo, its state as icon + word, and what was measured */}
        <Section title={t('moGroup_rpc')} right={h && nets.length > 0 && (() => { const bad = nets.filter((x) => x.ok === false).length, unknown = nets.filter((x) => x.ok === null).length;
          return <Status ok={bad > 0 ? false : unknown === nets.length ? null : true}>{bad > 0 ? t('moNDown', { n: bad }) : unknown === nets.length ? t('moUnknown') : `${nets.length - unknown}/${nets.length} ${t('moOk')}`}</Status>; })()}>
          {!h ? <SkeletonStats n={6} /> : <Card className="!p-3">
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">{[...nets].sort((a, b) => Number(a.ok !== false) - Number(b.ok !== false)).map((x) =>
              <li key={x.id} className={`flex min-w-0 items-center gap-2.5 rounded-2xl border px-2.5 py-2.5 ${x.ok === false ? 'border-danger/40 bg-danger/[0.07]' : 'border-transparent bg-elev/60'}`} data-ok={String(x.ok)}>
                <NetworkIcon net={x.id.slice(4)} size={30} />
                <span className="min-w-0 flex-1"><span className="block break-words text-[13.5px] font-semibold leading-tight">{x.name}</span>
                  <span className="mt-0.5 block"><Status ok={x.ok} /></span>
                  {x.ok === false && <span className="mt-0.5 block break-words text-[11.5px] leading-snug text-ink/85">{srvText(t, locale, x.detail)}</span>}</span></li>)}</ul>
            {/* every measurement, as before: what was checked and when it last answered (open when a network is down) */}
            <Fold className="mt-1 px-1.5" summary={t('dzMoNetDetail')} open={nets.some((x) => x.ok === false)}><ul className="divide-y divide-line">{nets.map((x) => <li key={x.id} className="flex items-baseline justify-between gap-3 py-2 text-[12.5px]">
              <span className="min-w-0"><span className="font-medium">{x.name}</span> <span className="break-words text-mute">· {srvText(t, locale, x.detail)}</span></span><span className="shrink-0 whitespace-nowrap text-mute">{x.ageSec === null ? t('moUnknown') : `${t('moLastSuccess')} ${age(x.ageSec, fr)}`}</span></li>)}</ul></Fold>
          </Card>}
        </Section>

        <Section title={t('moConnectors')}>
          {!h ? <SkeletonRows n={4} /> : <Card className="!px-4 !py-1.5"><div className="divide-y divide-line">{groups.map((g) => { const rows = h.connectors.filter((x) => x.group === g); if (!rows.length) return null;
            const bad = rows.filter((x) => x.ok === false).length, unknown = rows.filter((x) => x.ok === null).length;
            return <div key={g} className="py-2.5">
              <div className="flex min-h-7 items-center justify-between gap-3"><span className="text-[12.5px] font-semibold text-mute">{t(`moGroup_${g}` as Key)}{rows.length > 1 ? ` (${rows.length})` : ''}</span>
                {rows.length > 1 && <Status ok={bad > 0 ? false : unknown === rows.length ? null : true}>{bad > 0 ? t('moNDown', { n: bad }) : unknown === rows.length ? t('moUnknown') : t('moOk')}</Status>}</div>
              <ul>{rows.map((x) => <li key={x.id} className="flex min-h-[52px] items-center gap-3 py-1.5" data-ok={String(x.ok)}>{logo(x)}
                <span className="min-w-0 flex-1"><span className="block break-words text-[14.5px] font-medium leading-snug">{reasonText(x.name, locale)}</span><span className="block break-words text-xs text-mute">{srvText(t, locale, x.detail)}{x.ageSec !== null ? ` · ${t('moLastSuccess')} ${age(x.ageSec, fr)}` : ''}</span></span>
                <span className="shrink-0"><Status ok={x.ok} /></span></li>)}</ul></div>; })}</div></Card>}
        </Section>
      </div>

      {/* background loops and their last heartbeat: a failing or late loop stands out, with its error in full */}
      <Section title={t('moSystem')}>
        {!h ? <SkeletonRows n={2} /> : <Card className="!px-4 !py-1.5">
          <ul className="divide-y divide-line" data-testid="monitor-loops">{h.loops.length === 0 ? <li className="py-3 text-[13.5px] text-mute">{t('moNoLoops')}</li> : h.loops.map((l) => { const bad = loopBad(l);
            return <li key={l.name} className={`py-2.5 ${bad ? '-mx-4 bg-danger/[0.07] px-4' : ''}`} data-ok={String(!bad)}>
              <div className="flex min-h-10 items-center gap-3">
                <span className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full ${bad ? 'bg-danger/12 text-danger' : 'bg-elev text-mute'}`} aria-hidden="true"><Icon n={bad ? 'warn' : 'refresh'} className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1"><span className="block break-words font-mono text-[13.5px] font-semibold">{l.name}</span><span className="block text-xs text-mute">{t('moEvery')} {age(Math.round(l.everyMs / 1000), fr)} · {t('moLastSuccess')} {age(l.ageSec, fr)}</span></span>
                <span className="shrink-0"><Status ok={l.lastOkAt === null && l.failures === 0 ? null : l.failures === 0 && !l.late}>{l.failures > 0 ? t('moNFailures', { n: l.failures }) : l.late ? t('moLate') : undefined}</Status></span></div>
              {l.lastError && l.failures > 0 && <p className="mt-1.5 break-words pl-[42px] font-mono text-[12px] leading-snug text-danger" lang="en">{srvText(t, locale, l.lastError)}</p>}</li>; })}</ul>
          {h.loopsNote && <p className="border-t border-line py-3 text-xs leading-snug text-mute">{t('moLoopsNote')}</p>}</Card>}
      </Section>

      {/* signer, strategy sandbox, audit chain, backup, disk */}
      <Section title={t('dzMoGuards')}>
        {!h ? <SkeletonStats n={4} /> : <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Tile icon="key" label={t('moSigner')} ok={signerOk} state={!h.signer.reachable ? t('moDown') : h.signer.halted ? t('moHalted') : t('moOk')} testid="monitor-signer" />
          {/* v8 hardening: the strategy sandbox — off means strategy code runs unconfined, unavailable means agents hold */}
          {h.lab && <Tile icon="shield" label={t('hdMoLab')} ok={h.lab.ok} state={h.lab.mode === 'sandbox-exec' ? t('hdMoLabOk') : h.lab.mode === 'off' ? t('hdMoLabOff') : t('hdMoLabDown')} testid="monitor-lab">
            {!h.lab.ok && <>{h.lab.mode === 'off' ? t('hdMoLabOffNote') : t('hdMoLabDownNote')}{h.lab.reason ? ` (${srvText(t, locale, h.lab.reason)})` : ''}</>}</Tile>}
          <Tile icon="list" label={t('moAudit')} ok={h.audit.intact} state={h.audit.intact ? t('moAuditOk', { n: h.audit.total }) : t('moAuditBroken')} />
          <Tile icon="clock" label={t('moBackup')} ok={!h.backup.visible || h.backup.lastAt === null ? null : (h.backup.ageHours ?? 0) <= 36} state={!h.backup.visible ? t('moBackupInvisible') : h.backup.lastAt === null ? t('moBackupNone') : when(new Date(h.backup.lastAt), locale)} />
          <Tile icon="bars" label={t('moDisk')} ok={null} state={h.disk ? `${h.disk.freePct} %` : '—'}>{h.disk && `${h.disk.freeGb} / ${h.disk.totalGb} ${fr ? 'Go' : 'GB'}`}</Tile>
        </div>}
      </Section>

      {/* the optional capabilities of the server: an OFF one names the variables that are missing (names only) */}
      {h?.capabilities && <Section title={t('dzMoCapabilities')}><Card className="!px-4 !py-1.5">
        <ul className="divide-y divide-line" data-testid="monitor-capabilities">{h.capabilities.map((c) => <li key={c.id} className="flex min-h-[52px] items-center gap-3 py-2.5" data-on={c.on}>
          <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-medium leading-snug">{t((c.id.startsWith('deriv_mm_') ? `mmCap_${c.id}` : `hdCap_${c.id}`) as Key)}</span>{!c.on && c.missing.length > 0 && <span className="mt-0.5 block break-all font-mono text-xs text-mute">{c.missing.join(' + ')}</span>}</span>
          <span className="shrink-0"><Status ok={c.on ? true : c.id === 'research_readonly_db' || c.id === 'web_app' || c.id === 'deriv_live_mainnet' || c.id === 'deriv_mandate_mainnet' || c.id === 'research_runner' || c.id === 'trading_api_execution' || c.id.startsWith('deriv_mm_') ? null : false}>{c.on ? t('hdCapOn') : t('hdCapOff')}</Status></span></li>)}</ul></Card></Section>}

      {h && <Section title={t('dzMoVersions')}><Card className="!py-2"><dl>
        <Fact k={t('moApiVersion')} mono>{h.versions.apiVersion}{h.versions.apiCommit ? ` · ${h.versions.apiCommit}` : ''}</Fact>
        <Fact k={t('moStarted')}>{when(new Date(h.versions.startedAt), locale)}</Fact>
        <Fact k={t('moSignerKey')} mono>{h.versions.signerKeyId ?? '—'}{h.versions.signerPolicyVersion !== null ? ` · v${h.versions.signerPolicyVersion}` : ''}</Fact>
        <Fact k="Node" mono>{h.versions.node}</Fact></dl></Card></Section>}

      <Section title={t('moCapital')}>
        {!c ? <SkeletonCard lines={4} /> : <Card>
          <p className="mb-2 text-[12.5px] leading-snug text-mute">{t('moCapitalNote')}</p>
          <dl className="divide-y divide-line text-[14.5px]" data-testid="monitor-capital">
            <div className="flex items-center justify-between gap-3 py-3"><dt className="min-w-0"><span className="block font-semibold">{t('moWallet')}</span><span className="block text-xs text-mute">{t('moWalletSub', { n: c.wallet.assets })}{c.wallet.unpriced ? ` · ${t('moUnpriced', { n: c.wallet.unpriced })}` : ''}{c.wallet.unavailable ? ` · ${t('moUnavailable', { n: c.wallet.unavailable })}` : ''}</span></dt>
              <dd className="flex shrink-0 items-center gap-2 font-semibold"><RealTag real />{c.wallet.usd === null ? '—' : settings.currency === 'CAD' && c.wallet.cad !== null ? fiat(c.wallet.cad, 'CAD', locale) : usd(c.wallet.usd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-3"><dt className="min-w-0"><span className="block font-semibold">{t('moAgentVaults')}</span><span className="block text-xs text-mute">{t('moAgentVaultsSub')}</span></dt><dd className="flex shrink-0 items-center gap-2 font-semibold"><RealTag real />{usd(c.totals.agentsLiveUsd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-3"><dt className="min-w-0"><span className="block font-semibold">{t('moDerivVenue')}</span><span className="block text-xs text-mute">{t('moDerivVenueSub')}</span></dt><dd className="flex shrink-0 items-center gap-2 font-semibold"><RealTag real />{usd(c.totals.derivVenueUsd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-3 text-mute"><dt className="min-w-0">{t('moAgentsPaper')}</dt><dd className="flex shrink-0 items-center gap-2"><RealTag real={false} />{usd(c.totals.agentsPaperUsd)}</dd></div>
            <div className="flex items-center justify-between gap-3 py-3 text-mute"><dt className="min-w-0">{t('moDerivPaper')}</dt><dd className="flex shrink-0 items-center gap-2"><RealTag real={false} />{usd(c.totals.derivPaperUsd)}</dd></div>
            {c.totals.derivTestnetUsd > 0 && <div className="flex items-center justify-between gap-3 py-3 text-mute"><dt className="min-w-0">{t('moDerivTestnet')}</dt><dd className="flex shrink-0 items-center gap-2"><RealTag real={false} />{usd(c.totals.derivTestnetUsd)}</dd></div>}
          </dl>
          <StatGrid cols={4} className="mt-3">{([['moOpenPositions', c.counts.openPositions.agents + c.counts.openPositions.derivatives], ['moOpenOrders', c.counts.openOrders.agents + c.counts.openOrders.derivatives],
            ['moAgentsActive', (c.counts.agents.LIVE ?? 0) + (c.counts.agents.PAPER_TRADING ?? 0)], ['moAgentsStopped', c.counts.agents.STOPPED ?? 0]] as const).map(([k, n]) => <Stat key={k} label={t(k)} value={n} />)}</StatGrid>
        </Card>}
      </Section>

      {c && (c.agents.length > 0 || c.derivatives.length > 0) && <Section title={t('moAccounts')}><Card className="!p-0 overflow-hidden">
        <ul className="divide-y divide-line">{c.agents.map((a) => <li key={a.id}><button className="row-press flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left" onClick={() => open(`/agents/${a.id}`)}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-elev text-mute" aria-hidden="true"><Icon n="robot" className="h-[18px] w-[18px]" /></span>
          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-words text-[14.5px] font-semibold">{a.name}</span><RealTag real={a.real} /></span>
            <span className="mt-0.5 block break-words text-xs text-mute">{t('moAgent')} · {a.state}{a.lastBar ? ` · ${t('moLastBar')} ${when(new Date(a.lastBar), locale)}` : ''}{a.stopReason && a.state === 'STOPPED' ? ` · ${srvText(t, locale, a.stopReason)}` : ''}</span></span>
          <span className="shrink-0 text-right text-[14.5px] font-semibold">{usd(a.equityUsd)}<span className="block text-xs font-normal text-mute">{t('moAllocated')} {usd(a.capitalUsd)}</span></span></button></li>)}
        {c.derivatives.map((a) => <li key={a.id}><button className="row-press flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left" onClick={() => open('/futures?v=accounts')}>
          <VenueIcon venue={a.venue} size={36} />
          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-words text-[14.5px] font-semibold">{a.label}</span><RealTag real={a.real} /></span>
            <span className="mt-0.5 block break-words text-xs text-mute">{a.venue} {a.network} · {a.mode} · {a.positions} {t('moPositionsShort')} · {a.openOrders} {t('moOrdersShort')}{a.halt ? ` · ${t('moHalted')}` : ''}{a.divergence ? ` · ${t('moDivergence')}` : ''}</span></span>
          <span className="shrink-0 text-right text-[14.5px] font-semibold">{usd(a.equity)}</span></button></li>)}</ul></Card></Section>}

      <Section title={t('moPnl')}>
        {!pnl.data ? <SkeletonCard lines={3} /> : <Card>{pnlRows.length === 0 ? <p className="text-[13.5px] text-mute">{t('moNoSeries')}</p> : <>
          <ul className="divide-y divide-line" data-testid="monitor-pnl">{pnlRows.map((r) => <li key={r.id} className="py-3 first:pt-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-words text-[14.5px] font-semibold leading-tight">{r.title}</span><RealTag real={r.real} /><span className="text-xs text-mute">{r.sub}</span></div>
            <dl className="mt-2 grid grid-cols-3 gap-2">{([['moToday', r.today], ['mo7d', r.d7], ['mo30d', r.d30]] as const).map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-mute">{t(k)}</dt><dd className="mt-0.5 text-[13.5px] font-semibold tabular-nums [overflow-wrap:anywhere]">{signed(v)}</dd></div>)}</dl></li>)}</ul>
          <p className="mt-3 text-[12.5px] leading-snug text-mute">{t('moPnlNote')}{anyPartial ? ` ${t('moPartialNote')}` : ''}</p></>}</Card>}
      </Section>

      <Section title={t('moExposure')}>
        {!exp.data ? <SkeletonCard lines={3} /> : <Card>
          {([['moReal', exp.data.real], ['moSimulated', exp.data.simulated]] as const).map(([k, rows]) => <div key={k} className="mb-4 border-b border-line pb-4 last:mb-0 last:border-0 last:pb-0"><div className="mb-1.5"><RealTag real={k === 'moReal'} /></div>
            {rows.length === 0 ? <p className="text-[13.5px] text-mute">{t('moNoExposure')}</p> : <ul className="divide-y divide-line">{rows.map((r) => <li key={r.asset} className="py-3 first:pt-1">
              <div className="flex items-center gap-2 text-[14.5px] font-semibold"><AssetIcon sym={r.asset} size={24} /><span>{r.asset}{!r.priced && <sup title={t('moUnpricedRow')}>†</sup>}</span></div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">{([['moSpot', usd(r.spotUsd), false], ['moPerp', `${r.perpLongUsd - r.perpShortUsd < 0 ? '−' : ''}${usd(Math.abs(r.perpLongUsd - r.perpShortUsd))}`, false], ['moNet', `${r.netUsd < 0 ? '−' : ''}${usd(Math.abs(r.netUsd))}`, true], ['moGross', usd(r.grossUsd), false]] as const).map(([k, v, strong]) =>
                <div key={k} className="min-w-0"><dt className="text-xs text-mute">{t(k)}</dt><dd className={`mt-0.5 text-[13.5px] tabular-nums [overflow-wrap:anywhere] ${strong ? 'font-semibold' : ''}`}>{v}</dd></div>)}</dl></li>)}</ul>}</div>)}
          <p className="mt-3 text-[12.5px] leading-snug text-mute">{t('moExposureNote')}</p></Card>}
      </Section>
    </div>
  );
}
