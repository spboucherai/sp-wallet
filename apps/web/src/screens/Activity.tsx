// V11 Activity — ONE verifiable history of every operation: transfers, receipts, swaps, bridges, plans, the unified orders of
// every venue (each labelled with its mode), agent actions, mandate events, risk denials, key and security events — a
// filterable timeline over `GET /api/v1/dashboard/activity` (activity.ts). The status of the audit hash chain is on top.
// A wallet movement keeps the detailed view it always had (bridge and THORChain progress, execution steps, explorer link);
// an order opens its state transitions. Paper items are LABELLED and filterable; this screen shows no total at all, so
// nothing can mix real money with simulated money. READ-ONLY.
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { get, inBackground } from '../api';
import { HEAD_REFRESH_MS, withHead } from '../activity';
import { activityApi, ACTIVITY_KINDS, checkKey, dayKey, defaultActivityFilters, eventKey, failedChecks, filtersActive, groupByDay, mergePages, orderStateView, PRINCIPALS, RANGES, switchKey, transitionStep,
  type ActivityFilters, type ActivityItem, type ActivityKind, type ActivityPage } from '../activity';
import { BridgeFacts, BridgePill, BridgeProgress, type BridgeV } from '../bridge';
import { ExecutionTimeline, type ExecutionV } from '../execution'; // v11
import { useNetworks, useSettings, type Net } from '../hooks';
import { lifecycleOf } from '../lifecycle';
import { LifecycleExplain, LifecycleTimeline } from '../lifecycleUi';
import { useContacts, type Contact } from '../wallet';
import { TransactionRow } from '../tx-row';
import { useFallbackInterval } from '../wallet-ui';
import { onWalletEvent } from '../feed-state';
import { counterpartyLabel, csvOf, foldInternal, isInternalDeposit, originKey, resultsOf, type WalletItem } from '../walletItems';
import { I18n, useT, type Key, hasText } from '../i18n';
import { PlanList } from '../plan'; // v7 any-to-any plans
import { propError } from '../sv';  // v11
import { Addr, Btn, Card, Chips, CopyBtn, EmptyState, ErrorState, exactAmt, Fact, Fold, Icon, inputCls, Money, Notice, PageTitle, Seg, short, SkeletonRows, Tag, testNotSent, Timeline, trimAmt, when } from '../ui';
import { XswapFacts, XswapPill, XswapProgress, type XswapV } from '../xswap';

/** a row of GET /activity, as the wallet rows of the timeline carry it (walletItems.ts) */
type Item = WalletItem;

const KIND_ICON: Record<ActivityKind, string> = { transfer: 'up', receive: 'down', swap: 'swap', bridge: 'swap', plan: 'list', order: 'chart', agent: 'robot', mandate: 'key', risk: 'shield', key: 'key', security: 'lock' };
import { venueShown } from '../venues';
/** the filter offers the venues the owner is offered (venues.ts) — a past operation on another venue stays in the unfiltered list */
const VENUES = (['hyperliquid', 'gmx', 'dydx', 'edgex', 'spot'] as const).filter((v) => v === 'spot' || venueShown(v));
const VENUE_NAME: Record<string, string> = { hyperliquid: 'Hyperliquid', gmx: 'GMX', dydx: 'dYdX', edgex: 'edgeX', spot: 'Spot' };
const selectCls = `${inputCls} min-h-11 !py-2 text-[0.875rem]`;

export function Activity({ open: openId }: { /** NEXT: the id of one movement to open (from the dashboard, an asset page, the search) */ open?: string } = {}) {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings(); const nets = useNetworks(); const qc = useQueryClient();
  const [f, setF] = useState<ActivityFilters>(defaultActivityFilters), [open, setOpen] = useState(''); const contacts = useContacts();
  const set = (patch: Partial<ActivityFilters>) => { setOpen(''); setF((x) => ({ ...x, ...patch })); };
  const q = useInfiniteQuery({ queryKey: ['activity', 'timeline', f], queryFn: ({ pageParam }) => activityApi.page(f, pageParam), initialPageParam: null as string | null,
    getNextPageParam: (last: ActivityPage) => last.nextCursor, refetchOnWindowFocus: false });
  // NEXT: the periodic refresh reads the FIRST page only (an infinite query re-reads every page it holds, one after the other:
  // after « load more » ×10 that was ten requests every 20 s). The fresh head is laid over the pages read so far (an item is shown
  // once, in its freshest version); a pull-to-refresh or the retry button still re-reads everything.
  const [head, setHead] = useState<{ f: ActivityFilters; page: ActivityPage; at: number } | null>(null);
  // NEXT live sync: a wallet event about a transfer or a deposit re-reads the head at once; the timed re-read is the fallback
  // (slow while the stream is connected). Both are background reads: they never count as an interaction of the owner (api.ts).
  const headMs = useFallbackInterval(HEAD_REFRESH_MS, 120_000);
  useEffect(() => { const tick = () => { if (document.visibilityState !== 'visible') return; void inBackground(() => activityApi.page(f, null)).then((page) => setHead({ f, page, at: Date.now() }), () => { /* the next tick tries again; a failed load is said by the list itself */ }); };
    const h = setInterval(tick, headMs); document.addEventListener('visibilitychange', tick);
    const off = onWalletEvent((e) => { if (e.type.startsWith('transfer.') || e.type.startsWith('deposit.') || e.type === 'reset') tick(); });
    return () => { clearInterval(h); document.removeEventListener('visibilitychange', tick); off(); }; }, [f, headMs]);
  const pages = useMemo(() => withHead<ActivityPage>(q.data?.pages ?? [], head && head.f === f ? head : null, q.dataUpdatedAt), [q.data, head, f, q.dataUpdatedAt]), merged = useMemo(() => mergePages(pages), [pages]);
  // NEXT: a deposit that is the result of one of the wallet's own operations is shown INSIDE that operation, not as « received »
  const walletRows = useMemo(() => merged.flatMap((i) => (i.wallet ? [i.wallet as unknown as Item] : [])), [merged]);
  const items = useMemo(() => { const kept = new Set(foldInternal(walletRows).map((w) => w.id)); return merged.filter((i) => !i.wallet || kept.has((i.wallet as unknown as Item).id)); }, [merged, walletRows]);
  // the movement asked for by the address (`/activity?tx=<id>`): opened once it is in the list, and brought into view
  const asked = useRef(false);
  useEffect(() => { if (!openId || asked.current) return; const hit = items.find((i) => i.id === openId || (i.wallet as { id?: string } | undefined)?.id === openId || i.ref.id === openId); if (!hit) return;
    asked.current = true; setOpen(hit.id); requestAnimationFrame(() => document.querySelector(`[data-item="${CSS.escape(hit.id)}"]`)?.scrollIntoView({ block: 'center' })); }, [openId, items]);
  const openMissing = !!openId && !asked.current && !q.isLoading && items.length > 0;
  const first = pages[0], audit = first?.audit ?? null, errors = first?.errors ?? [], active = filtersActive(f);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['activity'] });
  // grouped by calendar day (the device's own): "Aujourd'hui", "Hier", then the date in full
  const loc = locale === 'fr' ? 'fr-CA' : 'en-CA';
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86_400_000);
  const dayLabel = (k: string, at: string) => k === today ? t('dsToday') : k === yesterday ? t('dsYesterday') : new Date(at).toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', ...(k.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
  const groups = groupByDay(items);
  const time = (d: string) => new Date(d).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  const netName = (id: string | null) => (id ? (nets.data ?? []).find((n) => n.id === id)?.name ?? id : '');
  const place = (i: ActivityItem) => (i.venue ? VENUE_NAME[i.venue] ?? i.venue : netName(i.network));
  const who = (p: ActivityItem['principal']): string => (!p ? '' : p.kind === 'owner' ? t('v11AcPrincipal_owner') : `${t(`v11AcPrincipal_${(PRINCIPALS as readonly string[]).includes(p.kind) ? p.kind : 'system'}` as Key)} · ${p.id.length > 14 ? short(p.id) : p.id}`);
  const modeTag = (i: ActivityItem): ReactNode => i.mode === 'paper' ? <Tag tone="mute" icon="chart" testid="ac-mode">{t('v11AcTagPaper')}</Tag> : i.mode === 'research' ? <Tag tone="mute" icon="search" testid="ac-mode">{t('v11AcTagResearch')}</Tag>
    : i.kind === 'order' || i.kind === 'risk' ? <Tag tone="warn" icon="bolt" testid="ac-mode">{t('v11AcTagLive')}</Tag> : null;
  /** the sentence of a non-wallet item, from its code */
  const title = (i: ActivityItem): string => {
    if (i.kind === 'order') return `${i.side ? t(i.side === 'sell' ? 'fxSide_sell' : 'fxSide_buy') : t('v11AcKind_order')} · ${(i.instrument ?? '').split(':').pop()}`;
    if (i.kind === 'plan') return t('v11AcPlanTitle', { from: String(i.params.from ?? ''), to: String(i.params.to ?? '') });
    if (i.code === 'risk.denied') return `${t('v11AcRiskDenied')}${i.instrument ? ` · ${i.instrument}` : ''}`;
    const k = switchKey(i) ?? eventKey(i.code);
    return k && hasText(k) ? t(k as Key) : t(`v11AcEvGeneric_${i.kind}` as Key);
  };
  /** an audit event without a sentence of its own: its code is shown next to the generic sentence, so two such rows can be told apart */
  const bare = (i: ActivityItem): boolean => i.source === 'audit' && !switchKey(i) && !eventKey(i.code);

  return (
    <div className="space-y-4" data-testid="activity">
      <PageTitle>{t('activity')}</PageTitle>
      {/* the audit journal is a hash chain: its verdict is the server's own (the same as on Security) */}
      <div data-testid="ac-audit" data-intact={audit ? String(audit.intact) : 'unknown'}>
        {audit && !audit.intact ? <Notice tone="danger"><b className="block font-semibold">{t('v11AcAuditBroken', { seq: audit.brokenAt ?? '—' })}</b>{t('v11AcAuditBrokenBody')}</Notice>
          : <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1"><Tag tone={audit ? 'ok' : 'mute'} icon={audit ? 'check' : 'clock'}>{t(audit ? 'v11AcAuditOk' : 'v11AcAuditUnknown')}</Tag>
            {audit && <span className="text-[0.78125rem] text-mute">{t('v11AcAuditSub', { date: when(new Date(audit.checkedAt), locale) })}</span>}</div>}
      </div>

      <Chips label={t('v11AcKinds')} value={f.kind} onChange={(kind) => set({ kind })} options={[{ id: '' as const, label: t('all') }, ...ACTIVITY_KINDS.map((k) => ({ id: k, label: t(`v11AcKind_${k}` as Key) }))]} />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="ac-filters">
        <div className="col-span-2 lg:col-span-1"><Seg label={t('v11AcMode')} value={f.mode} onChange={(mode) => set({ mode })} options={[['', t('all')], ['live', t('v11AcMode_live')], ['paper', t('v11AcMode_paper')]] as const} /></div>
        <select aria-label={t('v11AcVenue')} data-testid="ac-venue" className={selectCls} value={f.venue} onChange={(e) => set({ venue: e.target.value })}><option value="">{t('v11AcVenueAll')}</option>
          <optgroup label={t('v11AcVenues')}>{VENUES.map((v) => <option key={v} value={v}>{VENUE_NAME[v]}</option>)}</optgroup>
          <optgroup label={t('networks')}>{(nets.data ?? []).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</optgroup></select>
        <select aria-label={t('v11AcPrincipal')} data-testid="ac-principal" className={selectCls} value={f.principal} onChange={(e) => set({ principal: e.target.value as ActivityFilters['principal'] })}><option value="">{t('v11AcPrincipal_all')}</option>
          {PRINCIPALS.map((p) => <option key={p} value={p}>{t(`v11AcPrincipal_${p}` as Key)}</option>)}</select>
        <select aria-label={t('v11AcRange')} data-testid="ac-range" className={`${selectCls} col-span-2 lg:col-span-1`} value={f.range} onChange={(e) => set({ range: e.target.value as ActivityFilters['range'] })}>
          {RANGES.map((r) => <option key={r} value={r}>{t(`v11AcRange_${r}` as Key)}</option>)}</select>
        {f.range === 'custom' && <><label className="block min-w-0"><span className="mb-1 block text-[0.75rem] text-mute">{t('v11AcFrom')}</span><input type="date" data-testid="ac-from" className={selectCls} value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className="block min-w-0"><span className="mb-1 block text-[0.75rem] text-mute">{t('v11AcTo')}</span><input type="date" data-testid="ac-to" className={selectCls} value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label></>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <p className="min-w-0 flex-1 text-[0.78125rem] leading-snug text-mute">{t('v11AcNoTotals')}</p>
        <div className="flex flex-wrap items-center gap-1">
          {active && <button type="button" onClick={() => { setOpen(''); setF(defaultActivityFilters()); }} data-testid="ac-reset" className="press inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[0.875rem] font-medium text-accent"><Icon n="x" className="h-4 w-4" />{t('v11AcReset')}</button>}
          <a href={activityApi.csvHref(f)} data-testid="ac-csv" className="link press px-3"><Icon n="down" className="h-4 w-4" />{t('v11AcCsv')}</a>
          {walletRows.length > 0 && <a data-testid="ac-csv-wallet" className="link press px-3" download="sp-wallet-mouvements.csv" title={t('nwAcCsvWalletHint')}
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(csvOf(foldInternal(walletRows), contacts.data, (i) => lifecycleOf(i)))}`}><Icon n="down" className="h-4 w-4" />{t('nwAcCsvWallet')}</a>}
        </div>
      </div>

      {openMissing && <OpenedMovement id={openId!} hidden={settings.hideBalances} contacts={contacts.data} nets={nets.data ?? []} time={time} refresh={refresh} />}
      {errors.length > 0 && <div data-testid="ac-source-errors"><Notice tone="warn">{t('v11AcSourceError', { sources: errors.map((e) => t(`v11AcSrc_${e.source}` as Key)).join(', ') })}</Notice></div>}
      {(f.kind === '' || f.kind === 'plan') && f.mode !== 'paper' && <PlanList />}
      {q.isLoading ? <SkeletonRows n={6} />
        : q.isError && items.length === 0 ? <ErrorState title={t('v11AcLoadError')} onRetry={() => void q.refetch()}>{t('v11AcLoadErrorBody')}</ErrorState>
        : items.length === 0 ? (active
          ? <div data-testid="ac-empty-filtered"><EmptyState icon="search" title={t('v11AcEmptyFiltered')} action={<Btn kind="soft" onClick={() => setF(defaultActivityFilters())}>{t('v11AcReset')}</Btn>}>{t('v11AcEmptyFilteredBody')}</EmptyState></div>
          : <div data-testid="ac-empty"><EmptyState icon="clock" title={t('noActivity')}>{t('v11AcEmptyBody')}</EmptyState></div>)
        : groups.map((g) => { const label = dayLabel(g.key, g.items[0]!.at); return <section key={g.key} aria-label={label}><h2 className="t-eyebrow mb-2 px-1">{label}</h2>
          <Card className="!p-0 overflow-hidden"><ul className="divide-y divide-line">{g.items.map((it) => { const isOpen = open === it.id, toggle = () => setOpen(isOpen ? '' : it.id), w = it.wallet as unknown as Item | undefined;
            return <li key={it.id} data-testid="ac-item" data-item={it.id} data-kind={it.kind} data-mode={it.mode ?? ''} data-status={it.status ?? ''} data-code={it.code} data-lifecycle={w ? lifecycleOf(w) : undefined}>
              {w ? <WalletRow i={w} isOpen={isOpen} toggle={toggle} time={time} hidden={settings.hideBalances} refresh={refresh} contacts={contacts.data} results={resultsOf(walletRows, w.id)} net={(nets.data ?? []).find((n) => n.id === w.network)} />
                : <><button className="row-press flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={isOpen} onClick={toggle}>
                  <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-elev text-mute" aria-hidden="true"><Icon n={KIND_ICON[it.kind]} className="h-5 w-5" /></span>
                  <span className="min-w-0 flex-1"><span className="block break-words font-medium leading-snug">{title(it)}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-mute"><span>{[place(it), time(it.at)].filter(Boolean).join(' · ')}</span>{bare(it) && <span className="break-all font-mono text-[0.71875rem]">{it.code}</span>}{modeTag(it)}</span></span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-right">
                    {it.kind === 'order' && it.amount && <span className="block font-semibold"><Money hidden={settings.hideBalances}>{trimAmt(it.amount.value, 6)} {it.amount.symbol ?? ''}</Money></span>}
                    {it.kind === 'plan' && it.amount && <span className="block font-semibold"><Money hidden={settings.hideBalances}>{trimAmt(it.amount.value)} {it.amount.symbol ?? ''}</Money></span>}
                    {it.kind === 'order' ? <OrderState state={it.status} /> : it.code === 'risk.denied' ? <Tag tone="danger" icon="x">{t('v11AcDenied')}</Tag> : it.kind === 'plan' && it.status ? <Tag tone={it.status === 'done' ? 'ok' : it.status === 'paused' ? 'warn' : it.status === 'stopped' ? 'mute' : 'info'}>{t(`v11AcPlan_${['active', 'paused', 'done', 'stopped'].includes(it.status) ? it.status : 'active'}` as Key)}</Tag> : null}
                  </span></button>
                  {isOpen && <div className="space-y-2.5 border-t border-line bg-bg/60 px-4 py-3 text-[0.8125rem]" data-testid="ac-detail"><Detail i={it} who={who} place={place} /></div>}</>}
            </li>; })}</ul></Card></section>; })}
      {q.hasNextPage && <Btn kind="soft" full busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} data-testid="ac-more">{t('v11AcMore')}</Btn>}
      {!q.hasNextPage && items.length > 0 && first && <p className="px-1 pb-1 text-center text-[0.75rem] leading-snug text-mute" data-testid="ac-end">{t('v11AcBound', { n: first.bounds.perSource })}</p>}
    </div>
  );
}

/** a unified order state: icon + word. UNKNOWN reads « en vérification auprès de la plateforme » and is never drawn as a failure. */
function OrderState({ state }: { state: string | null }) {
  const t = useT(); const v = orderStateView(state);
  return <span data-testid="ac-order-state" data-state={state ?? ''} data-tone={v.tone}><Tag tone={v.tone} icon={v.icon}>{v.key ? t(v.key as Key) : state ?? '—'}</Tag></span>;
}

/** the detail of an order, a plan, a risk denial or an audit event */
function Detail({ i, who, place }: { i: ActivityItem; who: (p: ActivityItem['principal']) => string; place: (i: ActivityItem) => string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const p = i.params, has = (k: string) => p[k] !== null && p[k] !== undefined && p[k] !== '';
  const common = <>{place(i) && <Fact k={t(i.venue ? 'v11AcVenueOne' : 'network')}>{place(i)}</Fact>}{i.principal && <Fact k={t('v11AcBy')}>{who(i.principal)}</Fact>}<Fact k={t('time')}>{new Date(i.at).toISOString()}</Fact></>;
  if (i.kind === 'order') return <>
    <dl>
      <Fact k={t('v11AcMode')}>{t(i.mode === 'paper' ? 'v11AcModePaperLong' : 'v11AcModeLiveLong')}</Fact>
      {i.amount && <Fact k={t('v11AcSize')}>{exactAmt(i.amount.value)} {i.amount.symbol ?? ''}</Fact>}
      {has('type') && <Fact k={t('v11AcOrderType')} mono>{String(p.type)}{p.reduceOnly === true ? ` · ${t('v11AcReduceOnly')}` : ''}</Fact>}
      {has('price') && <Fact k={t('v11AcPrice')}>{exactAmt(String(p.price))}</Fact>}
      {has('triggerPrice') && <Fact k={t('v11AcTrigger')}>{exactAmt(String(p.triggerPrice))}</Fact>}
      {has('filled') && Number(p.filled) > 0 && <Fact k={t('v11AcFilled')}>{exactAmt(String(p.filled))}{has('avgFillPrice') ? ` @ ${exactAmt(String(p.avgFillPrice))}` : ''}</Fact>}
      {i.status === 'UNKNOWN' && <Fact k={t('status')}><span className="text-accent" data-testid="ac-unknown-note">{t('v11AcUnknownNote')}</span></Fact>}
      {has('rejectCode') && <Fact k={t('v11AcReason')} mono>{String(p.rejectCode)}</Fact>}
      {has('engineStatus') && <Fact k={t('v11AcEngine')} mono>{String(p.engineStatus)}</Fact>}
      {has('mandateId') && <Fact k={t('v11AcMandate')} mono><span className="break-all">{String(p.mandateId)}</span></Fact>}
      {common}
      <Fact k={t('v11AcRef')} mono><span className="break-all">{i.ref.id}</span></Fact>
    </dl>
    <OrderHistory id={i.ref.id} /></>;
  if (i.kind === 'plan') return <><dl>{i.amount && <Fact k={t('amount')}>{exactAmt(i.amount.value)} {i.amount.symbol ?? ''}</Fact>}{typeof p.steps === 'number' && <Fact k={t('v11AcSteps')}>{Math.min(Number(p.current ?? 0) + (i.status === 'done' ? 0 : 1), p.steps)} / {p.steps}</Fact>}{common}</dl>
    <a className="inline-flex min-h-11 items-center gap-1.5 text-accent" href={`/plan/${i.ref.id}`} data-testid="ac-open-plan"><Icon n="chev" className="h-4 w-4" />{t('v11AcOpenPlan')}</a></>;
  if (i.code === 'risk.denied') { const failed = failedChecks(i); return <><dl>{common}{p.reducing === true && <Fact k={t('v11AcOrderType')}>{t('v11AcReduceOnly')}</Fact>}</dl>
    <div data-testid="ac-failed"><div className="text-[0.71875rem] uppercase tracking-wide text-mute">{t('v11AcFailed')}</div>
      <ul className="mt-1.5 space-y-1">{failed.map((id) => { const k = checkKey(id); return <li key={id} className="rounded-xl bg-elev px-3 py-2 leading-snug">{k ? t(k as Key) : ''} <span className="font-mono text-[0.71875rem] text-mute">{id}</span></li>; })}</ul></div></>; }
  const entries = Object.entries(p).filter(([, v]) => v !== null && v !== '');
  return <><dl>{common}<Fact k={t('v11AcEvent')} mono>{i.code}</Fact><Fact k={t('v11AcAuditSeq')} mono>{i.ref.id}</Fact></dl>
    {entries.length > 0 && <Fold summary={t('v11AcTechnical')} testid="ac-params"><dl>{entries.map(([k, v]) => <Fact key={k} k={<span className="font-mono text-[0.75rem]">{k}</span>} mono><span className="break-all">{typeof v === 'number' && k.toLowerCase().endsWith('at') && v > 1e12 ? when(new Date(v), locale) : String(v)}</span></Fact>)}</dl></Fold>}</>;
}

/** the state transitions of one order, oldest first (GET /trading/orders/:id → history), read when the row opens */
function OrderHistory({ id }: { id: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['activity', 'order', id], queryFn: () => activityApi.order(id), staleTime: 5000 });
  const h = q.data?.history ?? [];
  return <div data-testid="ac-history"><div className="mb-1.5 text-[0.71875rem] uppercase tracking-wide text-mute">{t('v11AcHistory')}</div>
    {q.isLoading ? <div className="space-y-2" aria-busy="true"><div className="skel h-4 w-48 !rounded-md" /><div className="skel h-4 w-40 !rounded-md" /></div>
      : q.isError ? <p className="text-caution">{t('v11AcHistoryError')} <button type="button" className="font-medium text-accent underline" onClick={() => void q.refetch()}>{t('retry')}</button></p>
      : h.length === 0 ? <p className="text-mute">{t('v11AcHistoryEmpty')}</p>
      : <Timeline label={t('v11AcHistory')} items={h.map((e, k) => { const v = orderStateView(e.to); return { key: String(e.seq), state: transitionStep(e.to, k === h.length - 1), testid: 'ac-transition',
          title: v.key ? t(v.key as Key) : e.to, children: <span>{when(new Date(e.at), locale)}{e.reason ? <span className="font-mono text-[0.71875rem]"> · {e.reason}</span> : null}</span> }; })} />}
  </div>;
}

/** a wallet movement: the shared transaction row (life-cycle pill, contact label) and its detail — every field, in full */
function WalletRow({ i, isOpen, toggle, time, hidden, refresh, contacts, results, net }: { i: Item; isOpen: boolean; toggle: () => void; time: (d: string) => string; hidden: boolean; refresh: () => void; contacts?: readonly Contact[]; results: Item[]; net?: Net }) {
  const t = useT();
  const pill = testNotSent(i) ? undefined : i.kind === 'bridge' && i.bridge ? <BridgePill b={i.bridge} /> : i.xswap ? <XswapPill x={i.xswap} /> : undefined;
  return <>
    <TransactionRow i={i} contacts={contacts} hidden={hidden} time={time(i.at)} onOpen={toggle} expanded={isOpen} right={pill} />
    {isOpen && <div className="space-y-3 border-t border-line bg-bg/60 px-[var(--card-padding)] py-4" data-testid="ac-detail"><WalletDetail i={i} hidden={hidden} refresh={refresh} contacts={contacts} results={results} net={net} />
      <span className="sr-only">{t('nwAcDetailEnd')}</span></div>}
  </>;
}
/**
 * The detail of a movement (design system §4): every field, the hash with copy and explorer, confirmations, the fee PAID
 * (once the chain has said it) told from the fee ESTIMATE, the life-cycle timeline with its times, and the explanation of a
 * transfer that was dropped, replaced or expired. The counterparty shows its contact label AND its full address.
 */
function WalletDetail({ i, hidden, refresh, contacts, results, net }: { i: Item; hidden: boolean; refresh: () => void; contacts?: readonly Contact[]; results: Item[]; net?: Net }) {
  const t = useT(); const { locale } = useContext(I18n);
  const l = lifecycleOf(i), who = counterpartyLabel(i, contacts), plain = i.kind === 'send' || i.kind === 'receive', notSent = testNotSent(i);
  return <>
    {i.kind !== 'receive' && !notSent && <LifecycleExplain of={i} />}
    {isInternalDeposit(i) && <Notice tone="info" testid="ac-internal">{t('nwAcInternal', { what: t(originKey(i.origin) as Key) })}</Notice>}
    <dl data-testid="ac-facts">
      <Fact k={t('amount')}><Money hidden={hidden}>{exactAmt(i.amountDisplay)} {i.symbol}</Money><span className="t-footnote block font-normal text-mute">{i.amount} {t('baseUnits')}</span></Fact>
      {i.xswap && <XswapFacts x={i.xswap} symbol={i.symbol} fromName={i.networkName} />}
      {i.kind === 'swap' && i.swap && !i.xswap && <Fact k={i.swap.receivedDisplay ? t('swReceived') : t('swMinGuaranteed')}>{exactAmt(i.swap.receivedDisplay ?? i.swap.minOutDisplay)} {i.swap.toSymbol}</Fact>}
      {i.kind === 'bridge' && i.bridge && <BridgeFacts b={i.bridge} symbol={i.symbol} />}
      {i.kind === 'gmx' && <Fact k={t('svKind_gmx')}><span className="font-normal text-mute">{t('svKindSub_gmx')}</span></Fact>}
      {results.map((r) => <Fact key={r.id} k={t('nwAcResult')} testid="ac-result"><Money hidden={hidden}>+{exactAmt(r.amountDisplay)} {r.symbol}</Money><span className="t-footnote block font-normal text-mute">{r.networkName} · {when(r.at, locale)}</span></Fact>)}
      {plain && who && <Fact k={t('nwAcContact')} testid="ac-contact">{who}</Fact>}
      {i.to && plain && i.kind === 'send' && <Fact stack k={t('to')} testid="ac-to"><Addr value={i.to} /></Fact>}
      {i.from && i.kind === 'receive' && <Fact stack k={t('from')} testid="ac-from"><Addr value={i.from} /></Fact>}
      {i.memo && <Fact stack k={t('memo')}><span className="t-mono break-all">{i.memo}</span></Fact>}
      <Fact k={t('network')}>{i.networkName}</Fact>
      <Fact k={t('status')}>{notSent ? <span className="text-caution">{t('qaTestNotSent')}</span> : <span data-testid="ac-lifecycle" data-lifecycle={l}>{t(`nwLc_${l}` as Key)}</span>}</Fact>
      {/* NEXT W5: the confirmations the server counted */}
      {typeof i.confirmations === 'number' && i.kind !== 'receive' && ['pending', 'confirming', 'confirmed'].includes(l) && !notSent && <Fact k={t('nxConfirmations')}><span data-testid="ac-confirmations">{net?.minConf ? t('nwLcConfOf', { n: i.confirmations, of: net.minConf }) : i.confirmations}</span></Fact>}
      {/* the fee: what was PAID once the chain has said it; before that, the estimate made before signing — each labelled as what it is */}
      {i.feePaidDisplay ? <Fact k={t('nwAcFeePaid')} testid="ac-fee-paid">{exactAmt(i.feePaidDisplay)} {i.feeSymbol}</Fact> : null}
      {i.feeDisplay && <Fact k={t(i.feePaidDisplay ? 'nwAcFeeEstimateWas' : 'nwAcFeeEstimate')} testid="ac-fee-estimate"><span className={i.feePaidDisplay ? 'font-normal text-mute' : ''}>≈ {trimAmt(i.feeDisplay, 9)} {i.feeSymbol}</span></Fact>}
      {i.maxFeeDisplay && i.kind !== 'receive' && <Fact k={t('feeMax')}><span className="font-normal text-mute">{trimAmt(i.maxFeeDisplay, 9)} {i.feeSymbol}</span></Fact>}
      <Fact k={t('time')}>{when(i.at, locale)}<span className="t-footnote block font-normal text-mute">{new Date(i.at).toISOString()}</span></Fact>
      {i.note && <Fact k={t('note')}>{i.note}</Fact>}
      {i.txid && <Fact stack k={t(i.txidIsBlock ? 'nwAcBlockHash' : 'txid')}><span className="t-mono break-all" data-testid="ac-txid">{i.txid}</span>
        <div className="mt-2 flex flex-wrap gap-2"><CopyBtn small text={i.txid} label={t('nxCopyHash')} />
          {i.explorer && !notSent && <a className="btn press inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-line px-5 text-[0.84375rem] font-medium" href={i.explorer} target="_blank" rel="noreferrer noopener" data-testid="ac-explorer"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}</div></Fact>}
    </dl>
    {i.xswap && <XswapProgress id={i.id} x={i.xswap} symbol={i.symbol} onUpdate={refresh} />}
    {i.kind === 'bridge' && i.bridge && !notSent && <BridgeProgress id={i.id} b={i.bridge} onUpdate={refresh} />}
    {notSent ? null : i.error && !['dropped', 'replaced', 'expired', 'failed'].includes(l) && <p className="t-callout text-negative" data-testid="activity-error">{propError(t, i)}</p>}
    {/* the life cycle with its times (a deposit has none: it is seen, then final) */}
    {i.kind !== 'receive' && !notSent && l !== 'draft' && <section aria-label={t('nwLcTitle')}><h3 className="t-eyebrow mb-2">{t('nwLcTitle')}</h3><LifecycleTimeline of={i} minConf={net?.minConf} /></section>}
    {/* v11: the same steps as on the review sheet — a CCTP transfer and a THORChain swap keep their own, richer progress above */}
    {i.execution && i.kind !== 'receive' && i.kind !== 'bridge' && !i.xswap && !notSent && l !== 'awaiting_confirmation' && i.kind !== 'send' && <ExecutionTimeline exec={i.execution} />}
  </>;
}
/** a movement opened by its id that the pages read so far do not hold: read on its own (a transfer; a deposit has no route of its own) */
function OpenedMovement({ id, hidden, contacts, nets, time, refresh }: { id: string; hidden: boolean; contacts?: readonly Contact[]; nets: Net[]; time: (d: string) => string; refresh: () => void }) {
  const t = useT();
  const uuid = /^[0-9a-f-]{36}$/i.test(id);
  const q = useQuery({ queryKey: ['proposal', id], enabled: uuid, retry: 0, queryFn: async () => { const p = await get<Record<string, unknown>>(`/transfers/proposals/${id}`); const k = String(p.kind ?? 'transfer'); return { ...p, kind: k === 'transfer' ? 'send' : k === 'xswap' ? 'swap' : k, at: p.createdAt } as unknown as Item; } });
  if (!uuid || q.isError) return <Notice tone="info" testid="ac-opened-missing">{t('nwAcOpenedMissing')}</Notice>;
  if (!q.data) return <SkeletonRows n={1} />;
  return <section aria-label={t('nwAcOpened')} data-testid="ac-opened"><h2 className="t-eyebrow mb-2 px-1">{t('nwAcOpened')}</h2>
    <Card className="!p-0 overflow-hidden"><WalletRow i={q.data} isOpen toggle={() => {}} time={time} hidden={hidden} refresh={refresh} contacts={contacts} results={[]} net={nets.find((n) => n.id === q.data!.network)} /></Card></section>;
}
