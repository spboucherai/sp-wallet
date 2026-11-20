/**
 * « Routeur (simulation) » — for one order intent, what each venue's execution would look like, side by side: eligibility, the
 * simulated fill, every cost with its inputs, margin, the risk view and the contract terms. Nothing here places an order.
 * Every number carries where it comes from: `venue` (read from the venue), `constant` (a documented fact) or `estimate`
 * (computed). The ranking is information — « le moins coûteux d'après ces estimations », never « le meilleur » — and the
 * only action is to open the PAPER order panel of Hyperliquid with the form pre-filled.
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Coin, Field, H, Icon, inputCls, Notice, VenueIcon } from '../ui';
import { ageText, DataTable, Empty, PaperTag, Row, Seg, VENUE_NAME, VenueBadge, type Col } from './bits';
import { D, dec, fmt, parseInput } from './dec';
import { AmountProblem } from '../amountUi';   // v8 hardening: says when a typed number is ambiguous (never guessed)
import { rapi, type CostComponent, type PaperPrefill, type Reason, type RouteAnswer, type RouteBody, type RoutedCandidate, type RouterSource, type TermKey } from './routerApi';
import type { DerivAccount, VenueId } from './types';
import type { GmxPrefill, GmxStatus } from './gmx';   // >>> v8 GMX trading <<<

const HORIZONS = ['1', '8', '24', '168', '720'] as const;
const TERMS: TermKey[] = ['structure', 'execution', 'collateral', 'settlement', 'quote', 'markPrice', 'fundingInterval', 'fundingRule', 'otherCarry', 'maxLeverage', 'marginModes', 'tick', 'lot', 'sizeUnit', 'minOrder', 'maintenance', 'liquidation', 'fees'];
interface Form { base: string; side: 'long' | 'short'; unit: 'usd' | 'base'; size: string; lev: string; horizon: string; type: 'market' | 'limit'; price: string; account: string }
const num = (s: string) => s.replace(/[^0-9.,\s ]/g, '');
const symbolOf = (id: string) => id.slice(id.indexOf(':') + 1);

/** where a number comes from — always a word, the colour only repeats it */
export function SrcTag({ source }: { source: RouterSource | 'paper' }) {
  const t = useT();
  const cls = source === 'venue' ? 'border-emerald/35 bg-emerald/8 text-emerald' : source === 'constant' ? 'border-line bg-elev text-mute' : 'border-warn/40 bg-warn/10 text-warn';
  return <span className={`ml-1.5 inline-flex shrink-0 items-center rounded-md border px-1 py-px align-middle text-[0.625rem] font-bold uppercase tracking-[0.05em] ${cls}`} title={t(`rxSrcTitle_${source}` as Key)} data-src={source}>{t(`rxSrc_${source}` as Key)}</span>;
}

export function RouterView({ accounts, onOpenPaper, gmx, onOpenGmx }: { accounts: DerivAccount[]; onOpenPaper: (p: PaperPrefill, accountId: string | null) => void; /* v8 GMX trading */ gmx?: GmxStatus; onOpenGmx?: (p: GmxPrefill) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [f, setF] = useState<Form>({ base: 'BTC', side: 'long', unit: 'usd', size: '25000', lev: '3', horizon: '24', type: 'market', price: '', account: '' });
  const [sent, setSent] = useState<RouteBody | null>(null);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const assets = useQuery({ queryKey: ['deriv', 'route', 'assets'], queryFn: rapi.assets, staleTime: 600_000 });
  const bases = useMemo(() => (assets.data ?? []).filter((a) => a.candidateVenues >= 1).slice(0, 60), [assets.data]);
  const asset = (assets.data ?? []).find((a) => a.base === f.base);
  const size = parseInput(f.size), lev = parseInput(f.lev), price = parseInput(f.price);
  const problem: Key | null = !size || !D.isPos(D.from(size)) ? (f.size.trim() ? 'rxErrSize' : null) : !lev || !D.isPos(D.from(lev)) ? 'rxErrLev' : f.type === 'limit' && (!price || !D.isPos(D.from(price))) ? (f.price.trim() ? 'rxErrPrice' : null) : null;
  const ready = !!size && !!lev && !problem && (f.type === 'market' || !!price);
  const body: RouteBody | null = ready ? { base: f.base, side: f.side, ...(f.unit === 'usd' ? { notionalUsd: size! } : { sizeBase: size! }), leverage: lev!, type: f.type, price: f.type === 'limit' ? price : null, reduceOnly: false,
    horizonHours: f.horizon, accountIds: f.account ? [f.account] : [] } : null;
  const q = useQuery({ queryKey: ['deriv', 'route', sent, locale], enabled: !!sent, queryFn: () => rapi.route(sent!, locale), staleTime: 0, gcTime: 0, retry: 0, refetchOnWindowFocus: false });
  const run = () => { if (!body) return; if (JSON.stringify(body) === JSON.stringify(sent)) void q.refetch(); else setSent(body); };
  const stale = !!sent && !!body && JSON.stringify(body) !== JSON.stringify(sent);
  const horizonLabel = (h: string) => t(`rxH_${h}` as Key);

  return (
    <div className="space-y-4" data-testid="router-view">
      <Card>
        <H right={<Coin sym={f.base} size={32} />}>{t('rxTitle')}</H>
        <div className="mb-3"><Notice tone="info"><b className="font-semibold">{t('rxSimOnly')}</b> {t('rxSimOnlyBody')}</Notice></div>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(); }} data-testid="router-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={t('rxAsset')} hint={asset ? asset.venues.map((v) => `${VENUE_NAME[v.venue] ?? v.name}${v.restriction ? ` (${t('rxUnavailableShort')})` : ''}`).join(' · ') : undefined}>
              <select className={inputCls} value={f.base} onChange={(e) => set({ base: e.target.value })} aria-label={t('rxAsset')}>
                {(bases.some((b) => b.base === f.base) ? bases : [{ base: f.base }, ...bases]).map((b) => <option key={b.base} value={b.base}>{b.base}</option>)}</select></Field>
            <div><span className="mb-1.5 block text-[0.8125rem] font-medium text-mute">{t('fxDirection')}</span>
              <Seg label={t('fxDirection')} value={f.side} onChange={(v) => set({ side: v })} options={[{ id: 'long', label: t('fxLong') }, { id: 'short', label: t('fxShort') }]} /></div>
            <Field label={t('fxSize')} hint={f.unit === 'usd' ? t('rxSizeUsdHint') : t('rxSizeBaseHint', { base: f.base })}>
              <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.size} onChange={(e) => set({ size: num(e.target.value) })} aria-label={t('fxSize')} />
                <Seg size="sm" label={t('rxUnit')} value={f.unit} onChange={(v) => set({ unit: v })} options={[{ id: 'usd', label: 'USD' }, { id: 'base', label: f.base }]} className="shrink-0" /></div><AmountProblem ambiguousOnly text={f.size} /></Field>
            <Field label={t('fxLeverage')} hint={t('rxLevHint')}>
              <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.lev} onChange={(e) => set({ lev: num(e.target.value) })} aria-label={t('fxLeverage')} /><span className="text-mute">×</span></div></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div><span className="mb-1.5 block text-[0.8125rem] font-medium text-mute">{t('rxHorizon')}</span>
              <Seg size="sm" label={t('rxHorizon')} value={f.horizon} onChange={(v) => set({ horizon: v })} options={HORIZONS.map((h) => ({ id: h, label: horizonLabel(h) }))} />
              <span className="mt-1.5 block text-xs text-mute">{t('rxHorizonHint')}</span></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><span className="mb-1.5 block text-[0.8125rem] font-medium text-mute">{t('fxOrderType')}</span>
                <Seg size="sm" label={t('fxOrderType')} value={f.type} onChange={(v) => set({ type: v })} options={[{ id: 'market', label: t('fxKind_market') }, { id: 'limit', label: t('fxKind_limit') }]} /></div>
              {f.type === 'limit' && <Field label={t('fxPrice')}><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.price} onChange={(e) => set({ price: num(e.target.value) })} aria-label={t('fxPrice')} /><AmountProblem ambiguousOnly text={f.price} /></Field>}
            </div>
          </div>
          <Field label={t('rxAccount')} hint={t('rxAccountHint')}><select className={inputCls} value={f.account} onChange={(e) => set({ account: e.target.value })} aria-label={t('rxAccount')}>
            <option value="">{t('rxAccountNone')}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label} — {VENUE_NAME[a.venue]}</option>)}</select></Field>
          {problem && <Notice tone="warn">{t(problem)}</Notice>}
          <Btn full type="submit" disabled={!ready} busy={q.isFetching} data-testid="router-run">{t(sent && !stale ? 'rxRefresh' : 'rxRun')}</Btn>
        </form>
      </Card>

      {!sent ? <Card className="!py-2"><Empty icon="swap" title={t('rxEmpty')} /></Card>
        : q.isLoading ? <RouterSkeleton />
        : q.isError ? <Notice tone="danger">{errText(t, q.error) || t('fxErrGeneric')}</Notice>
        : q.data ? <Results data={q.data} stale={stale} locale={locale} accounts={accounts} onOpenPaper={onOpenPaper} gmx={gmx} onOpenGmx={onOpenGmx} /> : null}
    </div>
  );
}

/** the results while the estimate runs: the ranking card, then two candidate cards */
function RouterSkeleton() {
  const card = (k: number) => <div key={k} className="card space-y-4 p-5"><div className="flex items-center gap-3"><div className="skel h-10 w-10 !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-4 w-32 !rounded-md" /><div className="skel h-3 w-20 !rounded-md" /></div><div className="skel h-6 w-24 !rounded-full" /></div>
    {[88, 72, 80, 64, 76].map((w) => <div key={w} className="flex justify-between gap-6"><div className="skel h-3.5 !rounded-md" style={{ width: `${w / 2}%` }} /><div className="skel h-3.5 w-20 !rounded-md" /></div>)}<div className="skel h-16 !rounded-2xl" /></div>;
  return <div className="space-y-4" aria-hidden="true"><div className="card space-y-3 p-5"><div className="skel h-5 w-48 !rounded-md" /><div className="skel h-4 w-[80%] !rounded-md" /><div className="skel h-14 !rounded-2xl" /><div className="skel h-24 !rounded-2xl" /></div>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{[0, 1].map(card)}</div></div>;
}
function usdT(x: string | null | undefined, locale: string, sign = false): string {
  const d = dec(x);
  if (!d) return '—';
  const small = D.lt(D.abs(d), D.one) && !D.isZero(d);
  return `${fmt(d, { dp: small ? 4 : 2, locale, sign })} USD`;
}
const bpsT = (x: string | null | undefined, locale: string, sign = false) => (dec(x) ? `${fmt(x, { dp: 2, locale, sign })} ${locale === 'en' ? 'bps' : 'pb'}` : '—');
const priceT = (x: string | null | undefined, locale: string) => { const d = dec(x); if (!d) return '—'; const n = D.toNumber(d); return fmt(d, { dp: n >= 1000 ? 2 : n >= 1 ? 4 : 6, locale }); };

function Results({ data, stale, locale, accounts, onOpenPaper, gmx, onOpenGmx }: { data: RouteAnswer; stale: boolean; locale: string; accounts: DerivAccount[]; onOpenPaper: (p: PaperPrefill, accountId: string | null) => void; /* v8 GMX trading */ gmx?: GmxStatus; onOpenGmx?: (p: GmxPrefill) => void }) {
  const t = useT();
  const bps = locale === 'en' ? 'bps' : 'pb', fix = (s: string) => s;
  const rows = data.ranking.rows, first = rows[0];
  const name = (id: string) => { const c = data.candidates.find((x) => x.instrument === id); return c ? `${VENUE_NAME[c.venue]} · ${c.symbol}` : id; };
  const unknown = [...new Set(data.candidates.flatMap((c) => c.allIn?.unknown ?? []))];
  const restricted = data.candidates.filter((c) => c.eligibility.reasons.some((r) => r.code === 'venue_restricted'));
  const cols: Col<(typeof rows)[number]>[] = [
    { id: 'rank', label: t('rxRank'), head: true, cell: (r) => <span className="tabular-nums">{r.rank}</span> },
    { id: 'inst', label: t('fxInstrument'), head: true, cell: (r) => <span className="inline-flex flex-wrap items-center gap-1.5"><VenueBadge venue={r.venue} /><span className="font-semibold">{symbolOf(r.instrument)}</span></span> },
    { id: 'usd', label: t('rxAllIn'), num: true, cell: (r) => <>{usdT(r.allInUsd, locale)}<SrcTag source="estimate" /></> },
    { id: 'bps', label: t('rxAllInBps'), num: true, cell: (r) => fix(bpsT(r.allInBps, locale)) },
    { id: 'unc', label: t('rxUncertainty'), num: true, cell: (r) => `± ${usdT(r.uncertaintyUsd, locale)}` },
    { id: 'tie', label: t('rxTie'), cell: (r) => (r.tiedWith.length ? t('rxTieExact', { n: r.tiedWith.length }) : r.nearTieWith.length ? t('rxTieNear', { n: r.nearTieWith.length }) : t('rxTieNone')) },
    { id: 'trip', label: t('rxRoundTrip'), num: true, cell: (r) => (r.roundTripUsd ? <>{usdT(r.roundTripUsd, locale)}{r.roundTripRank !== null && r.roundTripRank !== r.rank ? <span className="block text-[0.71875rem] text-warn">{t('rxRoundTripRank', { n: r.roundTripRank })}</span> : null}</> : '—') },
    { id: 'now', label: t('rxExecutable'), cell: (r) => (r.executableNow ? <span className="inline-flex items-center gap-1.5">{t('rxExecPaper')}<PaperTag /></span> : <span className="text-mute">{t('rxExecNo')}</span>) },
  ];
  const diffCols: Col<(typeof data.differences.fields)[number]>[] = [
    { id: 'f', label: t('rxTerm'), head: true, cell: (d) => t(`rxTerm_${d.field}` as Key) },
    ...data.candidates.map((c): Col<(typeof data.differences.fields)[number]> => ({ id: c.instrument, label: <span className="inline-flex flex-wrap items-center gap-1"><VenueBadge venue={c.venue} /><span>{symbolOf(c.instrument)}</span></span>,
      cell: (d) => { const v = d.values.find((x) => x.instrument === c.instrument); return v ? <span className="block max-w-[300px] whitespace-normal text-[0.78125rem] leading-snug md:w-[230px]">{v.value}<SrcTag source={v.source} /></span> : '—'; } })),
  ];

  return (
    <div className={`space-y-4 ${stale ? 'opacity-60' : ''}`} data-testid="router-results" data-stale={stale ? '1' : '0'}>
      {stale && <Notice tone="warn">{t('rxStale')}</Notice>}
      <Card>
        <H right={<span className="text-[0.75rem] text-mute">{t('rxAsOf', { age: ageText(Date.now() - data.ts) })}</span>}>{t('rxRankingTitle')}</H>
        <div className="mb-3 space-y-2">
          {first ? <p className="rounded-2xl bg-elev/70 px-4 py-3 text-[0.90625rem] leading-snug" data-testid="router-least"><b className="font-semibold">{t('rxLeast')}</b> {name(first.instrument)} — {usdT(first.allInUsd, locale)} ({fix(bpsT(first.allInBps, locale))}).{' '}
            {first.tiedWith.length ? t('rxLeastTied', { n: first.tiedWith.length }) : first.nearTieWith.length ? t('rxLeastNear', { n: first.nearTieWith.length }) : ''}</p>
            : <Notice tone="warn">{t('rxNoEligible')}</Notice>}
          <Notice tone="warn"><b className="font-semibold">{t('rxNotBest')}</b> {t('rxNotBestBody')}</Notice>
          {data.ranking.orderChangesWithExit && <Notice tone="warn">{t('rxOrderChanges')}</Notice>}
          {unknown.length > 0 && <Notice tone="warn">{t('rxUnknownCosts', { list: unknown.map((u) => t(`rxCost_${u}` as Key)).join(', ') })}</Notice>}
          {restricted.length > 0 && <Notice tone="info">{t('rxRestrictedNote', { venues: [...new Set(restricted.map((c) => VENUE_NAME[c.venue]))].join(', ') })}</Notice>}
          {data.errors.length > 0 && <Notice tone="warn">{t('fxVenueErrors', { venues: data.errors.map((e) => VENUE_NAME[e.venue as VenueId] ?? e.venue).join(', ') })}</Notice>}
        </div>
        <DataTable label={t('rxRankingTitle')} cols={cols} rows={rows} rowKey={(r) => r.instrument} empty={t('rxNoEligible')} />
        <p className="mt-3 text-[0.75rem] leading-snug text-mute">{t('rxRankingNote', { bps })}</p>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="router-cards">
        {data.candidates.map((c) => <Candidate key={c.instrument} c={c} locale={locale} account={accounts.find((a) => a.venue === c.venue && a.kind === 'paper') ?? null} onOpenPaper={onOpenPaper} gmx={gmx} onOpenGmx={onOpenGmx} />)}
      </div>

      <Card>
        <H>{t('rxDiffTitle')}</H>
        <div className="mb-3"><Notice tone="warn"><b className="font-semibold">{t('fxNotInterchangeable')}</b> {t('rxDiffBody', { n: data.candidates.length, base: data.intent.base.toUpperCase(), k: data.differences.fields.length })}</Notice></div>
        <DataTable label={t('rxDiffTitle')} cols={diffCols} rows={data.differences.fields} rowKey={(d) => d.field} empty={t('rxDiffEmpty')} />
        <ul className="mt-4 list-disc space-y-1.5 pl-5 text-[0.8125rem] leading-snug">{(['fxNever1', 'fxNever2', 'fxNever3', 'fxNever4'] as const).map((k) => <li key={k}>{t(k)}</li>)}</ul>
        <details className="mt-3"><summary className="flex min-h-11 cursor-pointer items-center text-[0.78125rem] font-medium text-blue">{t('hdEngineNotes', { n: data.warnings.length })}</summary>
          <ul className="list-disc space-y-1 pb-1 pl-5 text-[0.78125rem] leading-snug text-mute">{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
      </Card>
    </div>
  );
}

function Status({ c }: { c: RoutedCandidate }) {
  const t = useT();
  const restricted = c.eligibility.reasons.some((r) => r.code === 'venue_restricted');
  const [key, tone, icon]: [Key, string, string] = restricted ? ['rxStRestricted', 'warn', 'warn'] : !c.eligibility.eligible ? ['rxStNotEligible', 'danger', 'x']
    : c.eligibility.executableNow ? ['rxStPaper', 'ok', 'check'] : ['rxStSetup', 'mute', 'gear'];
  return <span className="tag !whitespace-normal !px-2.5 !py-1 !text-[0.75rem]" data-tone={tone} data-testid="router-status" data-status={restricted ? 'restricted' : !c.eligibility.eligible ? 'not_eligible' : c.eligibility.executableNow ? 'paper' : 'setup'}><Icon n={icon} className="h-3 w-3 shrink-0" />{t(key)}</span>;
}
function ReasonLine({ r }: { r: Reason }) {
  const t = useT();
  const k = `rxReason_${r.code}`, known = t(k as Key), text = known.startsWith('rxReason') || known === r.code.replace(/_/g, ' ') ? r.message : known;
  const tone = r.kind === 'blocker' ? 'text-danger' : r.kind === 'setup' ? 'text-warn' : 'text-mute';
  return <li className="text-[0.8125rem] leading-snug" data-reason={r.code}><span className={`font-semibold ${tone}`}>{t(`rxKind_${r.kind}` as Key)}</span> — {text}
    {text !== r.message && r.kind !== 'note' && <span className="mt-0.5 block break-words font-mono text-[0.6875rem] text-mute">{r.code} — {r.message}</span>}</li>;
}
function Sub({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-t border-line pt-3.5"><h3 className="t-eyebrow mb-1.5">{title}</h3>{children}</section>;
}
function CostRow({ k, locale }: { k: CostComponent; locale: string }) {
  const t = useT(); const fix = (s: string) => s;
  return <li className="py-1.5" data-cost={k.id}>
    <details>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-[0.84375rem]">
        <span className="min-w-0"><span className="font-medium">{t(`rxCost_${k.id}` as Key)}</span><span className="block text-[0.71875rem] text-mute">{t(`rxTiming_${k.timing}` as Key)}</span></span>
        <span className="shrink-0 text-right tabular-nums">{k.usd === null ? <span className="font-semibold text-warn">{t('rxUnknown')}</span> : <><span className="font-semibold">{usdT(k.usd, locale, true)}</span><SrcTag source="estimate" /><span className="block text-[0.71875rem] text-mute">{fix(bpsT(k.bps, locale, true))} · ± {usdT(k.uncertaintyUsd, locale)}</span></>}</span>
      </summary>
      <div className="space-y-1.5 pb-2 text-[0.78125rem] leading-snug text-mute">
        <p><b className="font-semibold text-ink">{t('rxBasis')}</b> {k.basis}</p>
        <p><b className="font-semibold text-ink">{t('rxUncertainty')}</b> {k.uncertainty}</p>
        {k.inputs.length > 0 && <ul className="space-y-0.5">{k.inputs.map((i) => <li key={i.name} className="break-words"><span className="text-ink">{i.name}</span> : {i.value ?? t('rxUnknown')}<SrcTag source={i.source} /></li>)}</ul>}
      </div>
    </details>
  </li>;
}

function Candidate({ c, locale, account, onOpenPaper, gmx, onOpenGmx }: { c: RoutedCandidate; locale: string; account: DerivAccount | null; onOpenPaper: (p: PaperPrefill, accountId: string | null) => void; /* v8 GMX trading */ gmx?: GmxStatus; onOpenGmx?: (p: GmxPrefill) => void }) {
  const t = useT(); const fix = (s: string) => s;
  const fl = c.fill, o = c.order, g = fl?.gmx ?? null, base = symbolOf(c.instrument).split(/[-/ ]/)[0]!;
  const restricted = c.eligibility.reasons.some((r) => r.code === 'venue_restricted');
  const canOpen = c.venue === 'hyperliquid' && c.eligibility.eligible && !!o && o.sizeUnit === 'base' && D.isPos(D.from(o.sizeBase)) && !!c.margin;
  // >>> v8 GMX trading
  const gxMarket = c.venue === 'gmx' && gmx?.tradable ? gmx.markets.find((m) => m.instrument === c.instrument && m.allowed) ?? null : null;
  // <<< v8 GMX trading
  const open = () => { if (!o || !c.margin) return; onOpenPaper({ instrument: c.instrument, side: o.side, kind: o.type, unit: 'base', size: o.sizeBase, lev: Math.max(1, Math.floor(Number(c.margin.leverage))), price: o.limitPrice ?? '', reduceOnly: o.reduceOnly }, account?.id ?? null); };
  return (
    <Card className={restricted ? '!border-warn/40' : ''}>
      <div data-testid="router-card" data-venue={c.venue} data-instrument={c.instrument} className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5"><div className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-3.5"><VenueIcon venue={c.venue} size={44} />
          <div className="min-w-0 flex-1"><h3 className="text-[1.0625rem] font-semibold leading-tight tracking-[-0.015em]">{c.symbol}</h3><p className="mt-0.5 text-[0.8125rem] text-mute">{VENUE_NAME[c.venue]}</p></div></div>
          <Status c={c} /></div>
        {restricted && <Notice tone="warn"><b className="font-semibold">{t('rxRestrictedTitle', { venue: VENUE_NAME[c.venue] })}</b> {t('rxRestrictedBody')}</Notice>}
        <ul className="space-y-1.5" data-testid="router-reasons">{c.eligibility.reasons.filter((r) => !(restricted && r.code !== 'venue_restricted' && r.kind !== 'blocker')).map((r) => <ReasonLine key={r.code + r.message.slice(0, 20)} r={r} />)}</ul>

        {fl && o && <Sub title={t('rxFillTitle')}>
          <Row label={t('fxSize')}>{o.sizeUnit === 'usd' ? usdT(o.sizeUsd, locale) : <>{fmt(o.sizeBase, { locale, trim: true })} {base}<span className="text-mute"> ≈ {usdT(o.sizeUsd, locale)}</span></>}<SrcTag source="estimate" /></Row>
          {o.rounding && <p className="text-[0.71875rem] leading-snug text-mute">{o.sizeUnit === 'usd' ? t('rxRoundUsd') : t('rxRoundLot')}</p>}
          <Row label={t(fl.method === 'order_book_walk' ? 'rxRefBook' : 'rxRefOracle')}>{priceT(fl.referencePrice, locale)}<SrcTag source="venue" /></Row>
          <Row label={t('rxAvgPrice')}>{priceT(fl.avgPrice, locale)}<SrcTag source="estimate" /></Row>
          {fl.method === 'order_book_walk' && <>
            <Row label={t('rxWorstPrice')}>{priceT(fl.worstPrice, locale)}<SrcTag source="venue" /></Row>
            <Row label={t('rxSlippage')}>{fix(bpsT(fl.slippageBps, locale, true))}<SrcTag source="estimate" /></Row>
            <Row label={t('rxLevels')}>{fl.levelsConsumed} / {fl.snapshotLevels}<span className="text-mute"> · {fmt(fl.depthConsumedPct, { dp: 2, locale })} %</span><SrcTag source="venue" /></Row>
            {dec(fl.unfilledBase) && D.isPos(D.from(fl.unfilledBase)) && <div className="mt-1.5"><Notice tone="danger"><b className="font-semibold">{t('rxBookEnds')}</b> {t('rxBookEndsBody', { left: fmt(fl.unfilledBase, { locale, trim: true }), base })}</Notice></div>}
            {dec(fl.restingBase) && D.isPos(D.from(fl.restingBase)) && <div className="mt-1.5"><Notice tone="warn">{t('rxResting', { size: fmt(fl.restingBase, { locale, trim: true }), base })}</Notice></div>}
          </>}
          {g && <>
            <Row label={t('rxOracleRange')}>{priceT(g.oracleMin, locale)} – {priceT(g.oracleMax, locale)}<SrcTag source="venue" /></Row>
            <Row label={t('rxImpact')}><span className={D.isNeg(D.from(g.impactCappedUsd)) ? 'text-danger' : ''}>{usdT(g.impactCappedUsd, locale, true)}</span>{g.capped ? ` (${t('rxCapped')})` : ''}<SrcTag source="estimate" /></Row>
            <Row label={t('rxImpactCaps')}>+{usdT(g.capPositiveUsd, locale)} / −{usdT(g.capNegativeUsd, locale)}<SrcTag source="venue" /></Row>
            <Row label={t('rxImbalance')}>{usdT(g.imbalanceBeforeUsd, locale)} → {usdT(g.imbalanceAfterUsd, locale)}<SrcTag source="estimate" /></Row>
            <Row label={t('rxCapacityUsed')}>{fmt(fl.depthConsumedPct, { dp: 3, locale })} %<SrcTag source="venue" /></Row>
            <p className="mt-1 text-[0.71875rem] leading-snug text-mute">{t('rxGmxImpactNote')} {t(`rxVirtual_${g.virtualInventory}` as Key)}</p>
          </>}
        </Sub>}

        {c.costs.length > 0 && <Sub title={t('rxCostsTitle')}>
          <ul className="divide-y divide-line/70" data-testid="router-costs">{c.costs.map((k) => <CostRow key={k.id} k={k} locale={locale} />)}</ul>
          {c.allIn && <div className="mt-2 rounded-2xl bg-elev px-4 py-3.5" data-testid="router-allin">
            <div className="flex items-baseline justify-between gap-3"><span className="text-[0.84375rem] font-semibold">{t('rxAllInOver', { h: t(`rxH_${c.allIn.horizonHours}` as Key) })}</span>
              <span className="text-right"><span className="t-num text-[1.1875rem]">{usdT(c.allIn.usd, locale, true)}</span><SrcTag source="estimate" /></span></div>
            <div className="mt-0.5 flex items-baseline justify-between gap-3 text-[0.75rem] text-mute"><span>{c.allIn.complete ? t('rxComplete') : c.allIn.unknown.length ? t('rxIncomplete', { list: c.allIn.unknown.map((u) => t(`rxCost_${u}` as Key)).join(', ') }) : t('rxPartial')}</span>
              <span className="shrink-0 tabular-nums">{fix(bpsT(c.allIn.bps, locale, true))} · ± {usdT(c.allIn.uncertaintyUsd, locale)}</span></div>
            {c.exit && <p className="mt-2 border-t border-line pt-2 text-[0.75rem] leading-snug text-mute">{t('rxExit', { exit: usdT(c.exit.usd, locale, true), trip: usdT(c.exit.roundTripUsd, locale), bps: fix(bpsT(c.exit.roundTripBps, locale)) })}</p>}
          </div>}
        </Sub>}

        {c.margin && <Sub title={t('rxMarginTitle')}>
          <Row label={t('rxInitialMargin', { lev: fmt(c.margin.leverage, { locale, trim: true }) })}>{usdT(c.margin.initialMarginUsd, locale)}<SrcTag source="estimate" /></Row>
          <Row label={t('rxMaintenance')}>{c.margin.maintenanceFraction ? `${fmt(D.mul(D.from(c.margin.maintenanceFraction), D.from(100n)), { dp: 3, locale, trim: true })} %` : t('rxUnknown')}<SrcTag source={c.margin.maintenanceSource} /></Row>
          <Row label={t('rxLiq')}>{c.margin.liquidationPrice.value ? <>{priceT(c.margin.liquidationPrice.value, locale)}<span className="text-mute"> · {fix(bpsT(c.margin.liquidationDistanceBps, locale))}</span></> : t('rxUnknown')}<SrcTag source="estimate" /></Row>
          <details><summary className="flex min-h-11 cursor-pointer items-center text-[0.78125rem] font-medium text-blue">{t('rxMethod')}</summary>
            <p className="pb-1 text-[0.78125rem] leading-snug text-mute">{c.margin.maintenanceRule}</p><p className="pb-1 text-[0.78125rem] leading-snug text-mute">{c.margin.liquidationPrice.method}</p></details>
        </Sub>}

        <Sub title={t('rxRiskTitle')}>
          <Row label={t('rxVenueLimits')}>{c.risk.venue.accepted ? <span className="inline-flex items-center gap-1 text-emerald"><Icon n="check" className="h-3.5 w-3.5" />{t('rxAccepted')}</span> : <span className="text-danger"><Icon n="x" className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />{t('rxRefused')} — <span className="font-mono text-[0.75rem]">{c.risk.venue.codes.join(', ')}</span></span>}</Row>
          {c.risk.accounts.length === 0 ? <p className="text-[0.75rem] leading-snug text-mute">{t('rxNoAccountAsked')}</p>
            : c.risk.accounts.map((a) => <div key={a.accountId} data-testid="router-policy" data-accepted={String(a.accepted)}>
              <Row label={<span className="inline-flex items-center gap-1.5">{a.label}{a.kind === 'paper' && <PaperTag />}</span>}>{a.accepted === true ? <span className="inline-flex items-center gap-1 text-emerald"><Icon n="check" className="h-3.5 w-3.5" />{t('rxAccepted')}</span> : a.accepted === false ? <span className="text-danger"><Icon n="x" className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />{t('rxRefused')} — <span className="font-mono text-[0.75rem]">{a.code}</span></span> : <span className="text-mute">{t('rxNotAsked')}</span>}</Row>
              {a.accepted === false && a.code && <p className="text-[0.75rem] leading-snug text-mute">{(() => { const s = t(`rk_${a.code}` as Key); return s.startsWith('rk ') || s === a.code!.replace(/_/g, ' ') ? a.reason : s; })()}</p>}
              {a.accepted === null && a.reason && <p className="text-[0.75rem] leading-snug text-mute">{a.reason}</p>}</div>)}
        </Sub>

        <details className="fold border-t border-line" data-testid="router-terms"><summary>{t('rxTermsTitle')}</summary>
          <dl className="space-y-2.5 pb-1">{TERMS.map((k) => <div key={k}><dt className="t-eyebrow">{t(`rxTerm_${k}` as Key)}</dt><dd className="mt-0.5 text-[0.8125rem] leading-snug">{c.terms[k].value}<SrcTag source={c.terms[k].source} /></dd></div>)}</dl></details>

        {c.venue === 'hyperliquid' && <div className="space-y-1.5 border-t border-line pt-3">
          <Btn full kind="soft" disabled={!canOpen} onClick={open} data-testid="router-open-paper">{t('rxOpenPaper')}</Btn>
          <p className="text-[0.75rem] leading-snug text-mute">{t(canOpen ? 'rxOpenPaperHint' : 'rxOpenPaperOff')}</p></div>}
        {/* >>> v8 GMX trading: only when GMX is tradable and this pool is a market of the venue policy — it pre-fills the GMX order panel, nothing is sent */}
        {gxMarket && onOpenGmx && o && c.margin && !o.reduceOnly && <div className="space-y-1.5 border-t border-line pt-3">
          <Btn full kind="soft" onClick={() => { const size = D.div(D.from(c.margin!.notionalUsd), D.one, 2, 'down'), l = D.from(c.margin!.leverage);
            onOpenGmx({ instrument: c.instrument, side: o.positionSide, sizeUsd: D.str(size), leverage: D.str(D.div(l, D.one, 1, 'down')), collateral: D.isPos(l) ? D.str(D.div(size, l, 2, 'up')) : '' }); }} data-testid="router-open-gmx">{t('gxRouterOpen')}</Btn>
          <p className="text-[0.75rem] leading-snug text-mute">{t('gxRouterOpenHint')}</p></div>}
        {/* <<< v8 GMX trading */}
      </div>
    </Card>
  );
}
