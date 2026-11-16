/**
 * V11 Dashboard — the consolidated panels of Home, under the wallet's own cards: derivative accounts and positions per venue,
 * agents, P&L, risk, system status, price freshness. A chunk of its own (Home stays in the first chunk and mounts it lazily).
 *
 * READ-ONLY: one read, `GET /api/v1/dashboard/summary` (dashboard.ts), whose sections fail on their own — a source that
 * cannot be read shows « Indisponible » with its reason in its own panel, and the others show. Every figure is the
 * server's; nothing is computed here except which position is the closest to its liquidation price.
 * Three books, never added: « Réel », « Testnet », « Simulation » each have their own block, tag and figures.
 * Marks tick from the quote engine (`LiveCell`: only the cell re-renders on a tick) and say how old they are (`QuoteDot`).
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useMemo, type ReactNode } from 'react';
import type { Nav } from '../App';
import { BOOKS, bookEmpty, bpsToFraction, dashboardApi, errKey, liquidationNear, nearestLiquidation, quoteIds, riskLevel, systemLevel,
  type AgentMode, type Book, type BookId, type BookPosition, type Section as Sec, type Summary } from '../dashboard';
import { fmt, pct, priceDp, usd } from '../derivatives/dec';
import { PriceFreshness } from '../freshness';
import { usePortfolio } from '../hooks';
import { I18n, useT, type Key } from '../i18n';
import { HUB_VENUES } from '../markets';
import { LiveCell, LiveStatus, QuoteDot } from '../quotes-ui';
import { ago } from '../sv';
import { Btn, Card, EmptyState, ErrorState, Fact, Fold, Icon, Notice, Section, SkeletonCard, SkeletonStats, Stat, StatGrid, Tag, VenueIcon, type Tone } from '../ui';

const VENUE: Record<string, string> = { hyperliquid: 'Hyperliquid', dydx: 'dYdX v4', gmx: 'GMX v2', edgex: 'edgeX' };
const venueName = (v: string): string => VENUE[v] ?? v;
const symbolOf = (instrument: string): string => instrument.slice(instrument.indexOf(':') + 1);
const MODE_TONE: Record<BookId, Tone> = { live: 'warn', liveTestnet: 'info', paper: 'mute' };
const MODE_ICON: Record<BookId, string> = { live: 'bolt', liveTestnet: 'clock', paper: 'chart' };
const AGENT_MODES: readonly AgentMode[] = ['live', 'paper', 'research'];

// the locale without threading it through every helper (a hook, called unconditionally by the components below)
const useLocale = (): string => useContext(I18n).locale;
/** which money a block is about: icon + word, on every block */
function ModeBadge({ book }: { book: BookId }) { const t = useT(); return <Tag tone={MODE_TONE[book]} icon={MODE_ICON[book]} testid={`db-mode-${book}`}>{t(`v11DbMode_${book}` as Key)}</Tag>; }
/** a source that could not be read: said in the panel, in the screen's language, never the server's sentence */
function Unavailable({ code }: { code: string }) { const t = useT(); return <div data-testid="db-unavailable" data-code={code}><Notice tone="warn">{t('v11DbUnavailable', { reason: t(errKey(code) as Key) })}</Notice></div>; }
const signed = (x: string): 'ok' | 'danger' | undefined => { const n = Number(x); return n > 0 ? 'ok' : n < 0 ? 'danger' : undefined; };
const signCls = (x: string): string => { const n = Number(x); return n > 0 ? 'text-emerald' : n < 0 ? 'text-danger' : ''; };

function Panel({ id, title, right, children, wide }: { id: string; title: string; right?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <div data-testid={id} className={wide ? 'lg:col-span-2' : ''}><Section title={title} right={right}>{children}</Section></div>;
}
/** one block per book, in the order real → testnet → simulation; `render` draws a readable book */
function PerBook({ s, render, empty, equity }: { s: Summary; render: (b: Book, id: BookId) => ReactNode; empty: Key; /** the accounts panel alone carries the value of the book's accounts */ equity?: boolean }) {
  const t = useT(); const locale = useLocale();
  return <div className="space-y-3">{BOOKS.map((id) => { const x = s.books[id];
    // a testnet book with nothing in it says nothing at all: most wallets never open a testnet account
    if (id === 'liveTestnet' && x.ok && bookEmpty(x.data)) return null;
    return <Card key={id} className="space-y-3 !p-4"><div data-book={id} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><ModeBadge book={id} />{equity && x.ok && !bookEmpty(x.data) && <span className="text-[12.5px] text-mute" data-testid="db-equity">{t('v11DbEquity')} <b className="font-semibold text-ink">{usd(x.data.equity, locale)}</b></span>}</div>
      {!x.ok ? <Unavailable code={x.error.code} /> : bookEmpty(x.data) ? <p className="text-[13.5px] text-mute" data-testid="db-book-empty">{t(empty)}</p> : render(x.data, id)}
      {x.ok && x.data.errors.length > 0 && <Notice tone="warn">{t('v11DbUnreadable', { n: x.data.errors.length })}</Notice>}
    </div></Card>; })}</div>;
}

function Accounts({ b }: { b: Book }) {
  const t = useT(); const locale = useLocale();
  return <dl>{b.collateral.map((a) => <Fact key={a.accountId} k={<span className="inline-flex items-center gap-2"><VenueIcon venue={a.venue} size={20} />{venueName(a.venue)}</span>} testid="db-account">
    {usd(a.equity, locale)}<span className="mt-0.5 block text-[12.5px] text-mute">{t('v11DbFree')} {usd(a.freeCollateral, locale)} · {t('v11DbMargin')} {usd(a.marginUsed, locale)}</span></Fact>)}</dl>;
}
function PositionRow({ p }: { p: BookPosition }) {
  const t = useT(); const locale = useLocale();
  const dp = priceDp(null, p.markPrice), near = liquidationNear(p.liquidationDistanceBps);
  return <li className="flex items-start justify-between gap-3 py-2.5" data-testid="db-position" data-instrument={p.instrument} data-side={p.side}>
    <span className="min-w-0"><span className="flex items-center gap-2 text-[15px] font-semibold"><VenueIcon venue={p.venue} size={20} /><span className="truncate">{symbolOf(p.instrument)}</span></span>
      <span className="mt-0.5 block text-[12.5px] text-mute">{t(p.side === 'long' ? 'v11DbLong' : 'v11DbShort')} · {fmt(p.size, { locale, trim: true })} · {fmt(p.leverage, { dp: 1, locale, trim: true })}× · {venueName(p.venue)}</span>
      <span className="mt-0.5 block"><QuoteDot id={p.instrument} /></span></span>
    <span className="shrink-0 text-right"><span className={`block text-[15px] font-semibold tabular-nums ${signCls(p.unrealizedPnl)}`}>{usd(p.unrealizedPnl, locale, true)}</span>
      <span className="mt-0.5 block text-[12.5px] tabular-nums text-mute">{t('v11DbMark')} <LiveCell id={p.instrument} flash={(q) => q.mark ?? q.mid} render={(q) => { const m = q.mark ?? q.mid; return m ? fmt(m, { dp, locale }) : null; }}>{fmt(p.markPrice, { dp, locale })}</LiveCell></span>
      <span className={`mt-0.5 block text-[12.5px] ${near ? 'font-semibold text-danger' : 'text-mute'}`}>{p.liquidationDistanceBps === null ? t('v11DbNoLiq') : <>{near && <Icon n="warn" className="mr-1 inline h-3 w-3" />}{t('v11DbLiqAway', { pct: pct(bpsToFraction(p.liquidationDistanceBps), 1, locale) })}</>}</span></span></li>;
}
function Pnl({ b }: { b: Book }) {
  const t = useT(); const locale = useLocale();
  return <StatGrid cols={3}>
    <Stat label={t('v11DbRealizedToday')} value={usd(b.pnl.realizedToday, locale, true)} tone={signed(b.pnl.realizedToday)} testid="db-pnl-today" />
    <Stat label={t('v11DbUnrealized')} value={usd(b.pnl.unrealizedToday, locale, true)} tone={signed(b.pnl.unrealizedToday)} testid="db-pnl-unrealized" />
    <Stat label={t('v11DbRealizedInception')} value={usd(b.pnl.realizedInception, locale, true)} tone={signed(b.pnl.realizedInception)} testid="db-pnl-inception" /></StatGrid>;
}
function Exposure({ b }: { b: Book }) {
  const t = useT(); const locale = useLocale();
  const near = nearestLiquidation(b.positions);
  return <div className="space-y-2.5">
    <StatGrid cols={3}><Stat label={t('v11DbGross')} value={usd(b.grossExposure, locale)} /><Stat label={t('v11DbLeverage')} value={b.leverage ? `${fmt(b.leverage, { dp: 2, locale, trim: true })}×` : '—'} />
      <Stat label={t('v11DbNearestLiq')} testid="db-nearest-liq" tone={near && liquidationNear(near.liquidationDistanceBps) ? 'danger' : undefined} value={near ? pct(bpsToFraction(near.liquidationDistanceBps!), 1, locale) : '—'} sub={near ? symbolOf(near.instrument) : t('v11DbNoLiq')} /></StatGrid>
    <Fold summary={t('v11DbExposureDetail')} testid="db-exposure-detail"><dl>
      {b.byAsset.map((a) => <Fact key={`a${a.asset}`} k={a.asset}>{t('v11DbNet')} {usd(a.net, locale, true)}<span className="mt-0.5 block text-[12.5px] text-mute">{t('v11DbLong')} {usd(a.long, locale)} · {t('v11DbShort')} {usd(a.short, locale)}</span></Fact>)}
      {b.byVenue.map((v) => <Fact key={`v${v.venue}`} k={venueName(v.venue)}>{usd(v.gross, locale)}</Fact>)}</dl></Fold>
  </div>;
}

export function DashboardPanels({ nav }: { nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: dashboardApi.summary, refetchInterval: 20_000, placeholderData: (prev) => prev });
  const pf = usePortfolio();
  const ids = useMemo(() => quoteIds(q.data), [q.data]);
  const link = (label: string, onClick: () => void, testid: string) => <button type="button" onClick={onClick} data-testid={testid} className="press -my-2 inline-flex min-h-11 items-center gap-1 text-[13.5px] font-semibold text-blue">{label}<Icon n="chev" className="h-4 w-4" /></button>;

  if (q.isLoading) return <div className="grid gap-4 lg:grid-cols-2" data-testid="dashboard" aria-busy="true"><SkeletonCard lines={3} /><SkeletonCard lines={3} /><SkeletonStats n={4} /><SkeletonCard lines={2} /></div>;
  if (!q.data) return <div data-testid="dashboard" data-state="error"><ErrorState title={t('v11DbLoadError')} offline={(q.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void q.refetch()}>{t('v11DbLoadErrorBody')}</ErrorState></div>;
  const s = q.data, r = s.risk, a = s.agents, ap = s.agentsPnl, h = s.health, au = s.audit;
  const level = r.ok ? riskLevel(r.data) : null, sys = systemLevel(h, au);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="dashboard" data-state="ready">
      <Panel id="db-accounts" title={t('v11DbAccounts')} right={link(t('v11DbOpenTrade'), () => nav({ tab: 'futures', view: 'accounts' }), 'db-open-accounts')}>
        <PerBook s={s} equity empty="v11DbNoAccounts" render={(b) => (b.collateral.length === 0 ? <p className="text-[13.5px] text-mute">{t('v11DbNoAccounts')}</p> : <Accounts b={b} />)} />
      </Panel>

      <Panel id="db-positions" title={t('v11DbPositions')}>
        <PerBook s={s} empty="v11DbNoPositions" render={(b) => (b.positions.length === 0 ? <p className="text-[13.5px] text-mute" data-testid="db-book-empty">{t('v11DbNoPositions')}</p>
          : <ul className="divide-y divide-line">{b.positions.map((p) => <PositionRow key={`${p.accountId}${p.instrument}${p.side}`} p={p} />)}</ul>)} />
      </Panel>

      <Panel id="db-pnl" title={t('v11DbPnl')}>
        <PerBook s={s} empty="v11DbNoPnl" render={(b) => <Pnl b={b} />} />
        <p className="mt-2 px-1 text-[12px] leading-snug text-mute">{t('v11DbPnlNote')}</p>
      </Panel>

      <Panel id="db-risk" title={t('v11DbRisk')} right={link(t('v11DbOpenRisk'), () => nav({ tab: 'risk' }), 'db-open-risk')}>
        <div className="space-y-3">
          <Card className="space-y-3 !p-4">{!r.ok ? <Unavailable code={r.error.code} /> : <>
            <div className="flex flex-wrap gap-2" data-testid="db-risk-state" data-level={level}>
              <Tag tone={r.data.switches.killSwitch.on ? 'danger' : 'ok'} icon={r.data.switches.killSwitch.on ? 'stop' : 'check'} testid="db-kill">{t(r.data.switches.killSwitch.on ? 'v11DbKillOn' : 'v11DbKillOff')}</Tag>
              <Tag tone={r.data.switches.readOnly.on ? 'warn' : 'ok'} icon={r.data.switches.readOnly.on ? 'lock' : 'check'} testid="db-readonly">{t(r.data.switches.readOnly.on ? 'v11DbReadOnlyOn' : 'v11DbReadOnlyOff')}</Tag>
              {r.data.live.ownerOrdersRefused ? <Tag tone="warn" icon="warn" testid="db-limits">{t('v11DbLimitsMissing', { n: r.data.live.missing.length })}</Tag>
                : r.data.live.automationOrdersRefused ? <Tag tone="warn" icon="warn" testid="db-limits">{t('v11DbLimitsMissingAuto', { n: r.data.live.missingForAutomation.length })}</Tag>
                : <Tag tone="ok" icon="check" testid="db-limits">{t('v11DbLimitsSet')}</Tag>}
            </div>
            {level === 'halted' && <p className="text-[13.5px] leading-snug">{t('v11DbKillBody')}</p>}
            {level === 'read_only' && <p className="text-[13.5px] leading-snug">{t('v11DbReadOnlyBody')}</p>}
            {level === 'limits_missing' && <p className="text-[13.5px] leading-snug text-mute">{t('v11DbLimitsBody')}</p>}</>}
          </Card>
          <PerBook s={s} empty="v11DbNoExposure" render={(b) => (b.positions.length === 0 ? <p className="text-[13.5px] text-mute">{t('v11DbNoExposure')}</p> : <Exposure b={b} />)} />
        </div>
      </Panel>

      <Panel id="db-agents" title={t('v11DbAgents')} right={link(t('v11DbOpenAgents'), () => nav({ tab: 'agents' }), 'db-open-agents')}>
        {!a.ok ? <Card className="!p-4"><Unavailable code={a.error.code} /></Card> : a.data.count === 0 ? <EmptyState icon="robot" title={t('v11DbNoAgents')}>{t('v11DbNoAgentsBody')}</EmptyState> : <Card className="space-y-3 !p-4">
          <StatGrid cols={3}><Stat label={t('v11DbAgentsActive')} value={a.data.total.active} testid="db-agents-active" /><Stat label={t('v11DbAgentsPaused')} value={a.data.total.paused} testid="db-agents-paused" /><Stat label={t('v11DbAgentsStopped')} value={a.data.total.stopped} /></StatGrid>
          <dl>{AGENT_MODES.filter((m) => a.data.byMode[m].active + a.data.byMode[m].paused + a.data.byMode[m].stopped > 0).map((m) => { const c = a.data.byMode[m], p = ap.ok ? ap.data.today[m] : null; return (
            <Fact key={m} k={<Tag tone={m === 'live' ? 'warn' : m === 'paper' ? 'mute' : 'info'} icon={m === 'live' ? 'bolt' : m === 'paper' ? 'chart' : 'search'}>{t(`v11DbAgentMode_${m}` as Key)}</Tag>} testid={`db-agents-${m}`}>
              {t('v11DbAgentCounts', { active: c.active, paused: c.paused })}
              <span className="mt-0.5 block text-[12.5px] text-mute">{t('v11DbPnlToday')} {!ap.ok ? t('v11DbUnavailable', { reason: t(errKey(ap.error.code) as Key) })
                : p && p.abs !== null ? <><b className={`font-semibold ${signCls(String(p.abs))}`}>{usd(p.abs.toFixed(2), locale, true)}</b>{p.partial ? ` · ${t('v11DbPartial')}` : ''}</> : t(`v11DbPnlWhy_${p?.reason ?? 'no_snapshot'}` as Key)}</span></Fact>); })}</dl>
          <p className="text-[12px] leading-snug text-mute">{t('v11DbAgentsNote')}</p></Card>}
      </Panel>

      <Panel id="db-system" title={t('v11DbSystem')} right={link(t('v11DbOpenMonitor'), () => nav({ tab: 'monitor' }), 'db-open-monitor')}>
        <Card className="space-y-3 !p-4"><div data-testid="db-system-state" data-level={sys} className="space-y-3">
          {!h.ok ? <Unavailable code={h.error.code} /> : <dl>
            <Fact k={t('v11DbSigner')} testid="db-signer"><Tag tone={!h.data.signer.reachable ? 'danger' : h.data.signer.halted ? 'warn' : 'ok'} icon={!h.data.signer.reachable ? 'cloudOff' : h.data.signer.halted ? 'stop' : 'check'}>
              {t(!h.data.signer.reachable ? 'v11DbSignerDown' : h.data.signer.halted ? 'v11DbSignerHalted' : 'v11DbSignerOk')}</Tag></Fact>
            <Fact k={t('v11DbConnectors')} testid="db-connectors">{h.data.connectors.failing.length === 0 ? <Tag tone="ok" icon="check">{t('v11DbConnectorsOk', { ok: h.data.connectors.ok, n: h.data.connectors.total })}</Tag>
              : <><Tag tone="warn" icon="warn">{t('v11DbConnectorsFailing', { n: h.data.connectors.failing.length })}</Tag><span className="mt-1 block break-words text-[12.5px] text-mute">{h.data.connectors.failing.map((c) => c.name).join(', ')}</span></>}
              {h.data.loops.late.length > 0 && <span className="mt-1 block text-[12.5px] text-warn">{t('v11DbLoopsLate', { n: h.data.loops.late.length })}</span>}</Fact></dl>}
          {!au.ok ? <Unavailable code={au.error.code} /> : <dl><Fact k={t('v11DbAudit')} testid="db-audit"><Tag tone={au.data.intact ? 'ok' : 'danger'} icon={au.data.intact ? 'check' : 'x'}>{t(au.data.intact ? 'v11DbAuditOk' : 'v11DbAuditBroken')}</Tag>
            <span className="mt-1 block text-[12.5px] text-mute">{t('v11DbAuditEvents', { n: au.data.total })}</span></Fact></dl>}
          <div><h3 className="mb-1.5 text-[13px] text-mute">{t('v11DbStreams')}</h3><LiveStatus venues={[...HUB_VENUES]} names={VENUE} /></div>
        </div></Card>
      </Panel>

      <Panel id="db-freshness" title={t('v11DbFreshness')} wide>
        <Card className="!p-4"><dl>
          <Fact k={t('v11DbFreshWallet')}>{pf.data?.prices && pf.data.pricesAsOf ? <PriceFreshness at={pf.data.pricesAsOf} stale={pf.data.pricesStale} /> : <span className="text-mute">{t('v11DbFreshNone')}</span>}</Fact>
          <Fact k={t('v11DbFreshSummary')}><Tag tone="mute" icon="clock">{t('v11DbReadAgo', { age: ago(t, s.ts) })}</Tag></Fact>
          {ids.length === 0 ? <Fact k={t('v11DbFreshMarks')}><span className="text-mute">{t('v11DbFreshNoMarks')}</span></Fact>
            : ids.map((id) => <Fact key={id} k={<span className="break-all">{t('v11DbFreshMark', { symbol: symbolOf(id), venue: venueName(id.slice(0, id.indexOf(':'))) })}</span>}><QuoteDot id={id}><span className="text-[12.5px] text-mute">{t('v11DbFreshPolled')}</span></QuoteDot></Fact>)}
        </dl></Card>
      </Panel>
    </div>
  );
}
