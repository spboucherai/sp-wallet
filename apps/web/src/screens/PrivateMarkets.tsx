// V11 Private Markets — synthetic contracts on private companies, venue by venue, with what can and cannot be derived from
// their price. Display only: nothing here is tradable from the wallet. Model and pure helpers: ../privateMarkets.ts.
// Design system: docs/v9/DESIGN.md (ui.tsx primitives; a state is always an icon or a word, never a colour alone).
import { useQuery } from '@tanstack/react-query';
import { useContext, useState, type ReactNode } from 'react';
import { get } from '../api';
import type { Nav } from '../App';
import { Spark } from '../chart';
import { I18n, useT, type Key } from '../i18n';
import {
  ageText, caveatKey, compactUsd, freshness, fundingText, groupByCompany, hostOf, noValuationKey, orderCaveats, pmDetailQuery, pmListQuery, premiumText, priceText, quantities, referenceKindKey, sizeParam, unitBadge,
  type Datum, type PmCompany, type PmDetail, type PmList, type PmMarket, type PmPosition, type PmReference, type PmValuation, type PmVenue,
} from '../privateMarkets';
import { Btn, Card, EmptyState, ErrorState, Fact, Field, Fold, Icon, inputCls, Notice, PageTitle, Section, Seg, SkeletonCard, SkeletonRows, Stat, StatGrid, Tag, when } from '../ui';

type T = ReturnType<typeof useT>;
const useLocale = () => useContext(I18n).locale;
/** an external source: host shown, opens in a new tab, never passes the referrer */
function Src({ url, children }: { url: string; children?: ReactNode }) {
  return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-blue underline decoration-blue/30 underline-offset-2">{children ?? hostOf(url)}<Icon n="ext" className="h-3 w-3 shrink-0" /></a>;
}
/** where a figure comes from and when it was read */
function Provenance({ d, now }: { d: Pick<Datum, 'source' | 'ts' | 'stale'>; now: number }) {
  const t = useT(), locale = useLocale(), age = ageText(d.ts, now, locale);
  return <span className="block text-[12px] leading-snug text-mute" data-testid="pm-provenance">{t('pmSource')} : {d.source}{age ? ` · ${age}` : ''}{d.stale ? ` · ${t('pmStale')}` : ''}</span>;
}

/** The standing notice: information only, trading disabled, and why. */
export function PmNotice({ compact }: { compact?: boolean }) {
  const t = useT();
  return <Notice tone="warn"><p className="font-semibold" data-testid="pm-notice">{t('pmNoticeTitle')}</p>{!compact && <><p className="mt-1">{t('pmNoticeBody')}</p>
    <ul className="mt-1.5 list-disc space-y-0.5 pl-4"><li>{t('pmNoticeJurisdiction')}</li><li>{t('pmNoticeDefinition')}</li></ul></>}</Notice>;
}

function UnitTag({ m }: { m: PmMarket }) { const t = useT(), b = unitBadge(m); return <Tag tone={b.tone} testid="pm-unit">{t(b.key)}</Tag>; }
function FreshTag({ m, now }: { m: PmMarket; now: number }) {
  const t = useT(), locale = useLocale(), f = freshness(m), age = ageText(m.market.price.ts, now, locale);
  return <Tag tone={f.tone} icon={f.tone === 'ok' ? 'check' : f.tone === 'mute' ? 'clock' : 'warn'} testid="pm-fresh">{t(f.key)}{age && !m.market.frozen ? ` · ${age}` : ''}</Tag>;
}

/** One contract of one venue, in the list: price with its unit, funding, open interest, volume, freshness, and the implied valuation or why there is none. */
export function ContractRow({ m, now, onOpen }: { m: PmMarket; now: number; onOpen: (id: string) => void }) {
  const t = useT(), locale = useLocale(), v = m.valuation.impliedValuation;
  return <button type="button" onClick={() => onOpen(m.id)} data-testid={`pm-row-${m.id}`} aria-label={`${m.platform} ${m.symbol} — ${t('pmOpenDetail')}`}
    className="row-press block w-full px-5 py-4 text-left">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-[15px] font-semibold leading-snug">{m.platform}</p><p className="break-all font-mono text-[12.5px] text-mute">{m.symbol}</p></div>
      <div className="shrink-0 text-right"><p className="t-num text-[20px]">{priceText(m.market.price.value, locale)}</p><p className="text-[11.5px] text-mute">{m.contract.quoteCurrency}</p></div>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-1.5"><UnitTag m={m} /><FreshTag m={m} now={now} />{m.status === 'delisted' && <Tag tone="mute" icon="stop" testid="pm-delisted">{t('pmDelisted')}</Tag>}
      {m.valuation.caveats.some((c) => c.code === 'thin_market') && <Tag tone="warn" icon="warn">{t('pmThin')}</Tag>}</div>
    {m.error ? <p className="mt-2 text-[13px] text-danger" role="status">{t('pmVenueError')} — {m.error}</p> : <dl className="mt-2 grid grid-cols-3 gap-2 text-[12.5px]">
      <div><dt className="text-mute">{t('pmFunding')}</dt><dd className="font-medium">{fundingText(m.market.funding, locale)}</dd></div>
      <div><dt className="text-mute">{t('pmOpenInterest')}</dt><dd className="font-medium">{compactUsd(m.market.openInterestUsd.value, locale)}</dd></div>
      <div><dt className="text-mute">{t('pmVolume')}</dt><dd className="font-medium">{compactUsd(m.market.volume24h.value, locale)}</dd></div></dl>}
    <p className="mt-2 text-[13px] leading-snug" data-testid="pm-row-valuation">{v.value !== null
      ? <><span className="text-mute">{t('pmImpliedShort')} : </span><span className="font-semibold">{compactUsd(v.value, locale)}</span><span className="text-mute"> — {t('pmEstimate')}</span></>
      : <><span className="font-semibold">{t('pmNotDeducible')}</span><span className="text-mute"> — {t(noValuationKey(v.reasonCode))}</span></>}</p>
  </button>;
}

function CompanyHead({ c }: { c: PmCompany | null }) {
  const t = useT(), locale = useLocale(), ref = c?.lastPrivateValuation ?? null;
  return <div className="px-5 pb-3 pt-4">
    <h2 className="text-[18px] font-semibold tracking-[-0.015em]">{c ? c.name : t('pmUnidentified')}</h2>
    {c && <p className="mt-0.5 text-[13px] text-mute" data-testid="pm-company-ref">{ref
      ? <>{t('pmQ5')} : <span className="font-semibold text-ink">{compactUsd(ref.value, locale)}</span> · {t(referenceKindKey(ref.kind))} · {ref.date} · <Src url={ref.sourceUrl} /></>
      : t('pmNoReference')}</p>}
    {c?.note && <p className="mt-1 text-[12.5px] leading-snug text-warn">{c.note}</p>}
    {c && c.contracts.length > 1 && <p className="mt-1 text-[12.5px] leading-snug text-mute">{t('pmNeverAveraged')}</p>}
  </div>;
}

function VenueLine({ v, now }: { v: PmVenue; now: number }) {
  const t = useT(), locale = useLocale();
  const [tone, icon, key] = v.status === 'ok' ? ['ok', 'check', 'pmVenueOk'] as const : v.status === 'stale' ? ['warn', 'clock', 'pmStale'] as const : ['danger', 'warn', 'pmVenueDown'] as const;
  return <div className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[13.5px]" data-testid={`pm-venue-${v.venue}`}><span className="min-w-0 font-medium">{v.name}</span>
    <span className="flex items-center gap-2"><Tag tone={tone} icon={icon}>{t(key)}</Tag><span className="text-[12px] text-mute">{ageText(v.ts, now, locale) ?? ''}</span></span>
    {v.error && <p className="w-full text-[12.5px] text-danger">{v.error}</p>}</div>;
}

/** The list: companies, then each venue's contract for the company — side by side, never merged. */
export function PmListView({ data, onOpen }: { data: PmList; onOpen: (id: string) => void }) {
  const t = useT(), groups = groupByCompany(data);
  return <div className="space-y-4">
    {groups.length === 0 && <EmptyState icon="list" title={t(data.filter.delisted ? 'pmEmptyDelisted' : 'pmEmpty')}>{t('pmEmptyBody')}</EmptyState>}
    {groups.map((g) => <section key={g.company?.slug ?? '_'} className="card overflow-hidden" data-testid={`pm-company-${g.company?.slug ?? 'none'}`}>
      <CompanyHead c={g.company} /><div className="divide-y divide-line border-t border-line">{g.markets.map((m) => <ContractRow key={m.id} m={m} now={data.ts} onOpen={onOpen} />)}</div></section>)}
    <Section title={t('pmVenues')}><Card className="!py-3">{data.venues.map((v) => <VenueLine key={v.venue} v={v} now={data.ts} />)}
      <Fold summary={t('pmNoAdapter')} testid="pm-no-adapter"><ul className="space-y-1.5 text-[13px] text-mute">{data.venuesWithoutAdapter.map((v) => <li key={v.venue}><span className="font-semibold text-ink">{v.venue}</span> — {v.note}</li>)}</ul>
        <p className="mt-2 text-[12.5px] text-mute">{t('pmNoAdapterBody')}</p></Fold></Card></Section>
    {data.excluded.length > 0 && <Fold summary={`${t('pmExcluded')} (${data.excluded.length})`} testid="pm-excluded"><ul className="space-y-2 text-[13px]">{data.excluded.map((e) =>
      <li key={e.id}><span className="font-semibold">{e.company}</span> <span className="break-all font-mono text-[12px] text-mute">{e.id}</span><p className="text-mute">{e.reason}</p></li>)}</ul></Fold>}
  </div>;
}

/** a long term of the contract (a sentence of the venue's documentation): label above, text below, full width */
function Long({ k, children }: { k: string; children: ReactNode }) {
  return <div className="border-t border-line py-2.5 first:border-t-0"><dt className="text-[12.5px] text-mute">{k}</dt><dd className="m-0 mt-0.5 text-[13.5px] leading-snug [overflow-wrap:anywhere]">{children}</dd></div>;
}
function Row({ n, label, children, testid }: { n: number; label: string; children: ReactNode; testid: string }) {
  return <li className="flex gap-3 py-3.5" data-testid={testid}><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-elev text-[13px] font-semibold" aria-hidden="true">{n}</span>
    <div className="min-w-0 flex-1"><h3 className="text-[13px] font-medium text-mute">{label}</h3>{children}</div></li>;
}
const Null = ({ t, reason, why }: { t: T; reason: string | null; why?: Key }) => <><p className="text-[16px] font-semibold" data-testid="pm-null">{t('pmNotDeducible')}</p>
  {why && <p className="text-[13.5px] leading-snug">{t(why)}</p>}{reason && <p className="mt-0.5 text-[12.5px] leading-snug text-mute"><span className="sr-only">{t('pmSourceText')} : </span>{reason}</p>}</>;

/** The valuation panel: five distinct quantities, each with its value or the reason it cannot be derived, its formula and its sources. */
export function ValuationPanel({ v, now, quote }: { v: PmValuation; now: number; quote: string }) {
  const t = useT(), locale = useLocale(), q = quantities(v), has = (id: string) => q.find((x) => x.id === id)!.has;
  const pos = v.notionalExposure.position, iv = v.impliedValuation, ref = v.lastPrivateValuation, prem = v.premiumDiscount;
  return <Card className="!pb-2" ><h2 className="text-[17px] font-semibold tracking-[-0.015em]">{t('pmPanelTitle')}</h2><p className="mt-0.5 text-[13px] text-mute">{t('pmPanelLead')}</p>
    <ol className="mt-1 divide-y divide-line" data-testid="pm-valuation">
      <Row n={1} label={t('pmQ1')} testid="pm-q-price"><p className="t-num text-[22px]">{priceText(v.syntheticPrice.value, locale, 6)} <span className="text-[13px] font-medium text-mute">{quote}</span></p>
        <p className="text-[13px] leading-snug">{v.syntheticPrice.unitLabel}{v.syntheticPrice.priceKind === 'frozen mark' ? ` — ${t('pmFrozenPrice')}` : ''}</p><Provenance d={v.syntheticPrice} now={now} /></Row>
      <Row n={2} label={t('pmQ2')} testid="pm-q-contract">{has('contract')
        ? <><p className="text-[16px] font-semibold">{compactUsd(v.contractMarketValue.value, locale)} <span className="text-[13px] font-medium text-mute">{t('pmPerContract')}</span></p><p className="text-[12.5px] leading-snug text-mute">{v.contractMarketValue.formula}</p></>
        : <Null t={t} reason={v.contractMarketValue.reason} />}</Row>
      <Row n={3} label={t('pmQ3')} testid="pm-q-exposure">{has('exposure')
        ? <><p className="text-[16px] font-semibold">{compactUsd(v.notionalExposure.value, locale)}</p><p className="text-[12.5px] leading-snug text-mute">{t('pmHypothetical', { side: t(pos.side === 'long' ? 'pmLong' : 'pmShort'), size: priceText(pos.size, locale, 8) })} — {v.notionalExposure.formula}</p></>
        : <Null t={t} reason={v.notionalExposure.reason} />}</Row>
      <Row n={4} label={t('pmQ4')} testid="pm-q-implied">{iv.value !== null
        ? <><p className="t-num text-[22px]">{compactUsd(iv.value, locale)}</p><p className="text-[13px] leading-snug"><Tag tone="info">{t('pmEstimate')}</Tag> <span className="text-mute">{t('pmImpliedLabel')}</span></p>
            <dl className="mt-1.5"><Fact k={t('pmFormula')}>{iv.formula}</Fact>
              {iv.formulaSource && <Fact k={t('pmFormulaSource')}><Src url={iv.formulaSource.url} /> · {t('pmReadOn', { date: iv.formulaSource.readAt })}</Fact>}
              <Fact k={t('pmAsOf')}>{iv.asOf ? when(new Date(iv.asOf), locale) : '—'}</Fact></dl>
            {iv.formulaSource && <blockquote className="mt-1 border-l-2 border-line pl-3 text-[12.5px] italic leading-snug text-mute">« {iv.formulaSource.quote} »</blockquote>}</>
        : <Null t={t} reason={iv.reason} why={noValuationKey(iv.reasonCode)} />}</Row>
      <Row n={5} label={t('pmQ5')} testid="pm-q-private">{ref
        ? <><p className="text-[16px] font-semibold">{compactUsd(ref.value, locale)}</p><p className="text-[13px] leading-snug">{t(referenceKindKey(ref.kind))} · {ref.date} · {t('pmConfidence')} : {t(`pmConf_${ref.confidence}` as Key)}</p>
            <p className="text-[12.5px] leading-snug text-mute">{ref.detail}</p><p className="text-[12.5px]"><Src url={ref.sourceUrl} /></p></>
        : <><p className="text-[16px] font-semibold">{t('pmNoReference')}</p><p className="text-[12.5px] leading-snug text-mute">{v.lastPrivateValuationReason}</p></>}</Row>
    </ol>
    <div className="border-t border-line py-3.5" data-testid="pm-premium"><h3 className="text-[13px] font-medium text-mute">{t('pmPremium')}</h3>{prem.premiumBps !== null
      ? <><p className="text-[18px] font-semibold">{premiumText(prem.premiumBps, locale)} <span className="text-[13px] font-medium text-mute">{t(Number(prem.premiumBps) >= 0 ? 'pmPremiumOver' : 'pmDiscountUnder')}</span></p><p className="text-[12.5px] leading-snug text-mute">{t('pmPremiumCaveat')}</p></>
      : <><p className="text-[15px] font-semibold">—</p><p className="text-[12.5px] leading-snug text-mute">{t('pmPremiumNone')}</p></>}</div>
  </Card>;
}

export function Caveats({ v }: { v: PmValuation }) {
  const t = useT();
  return <Section title={t('pmCaveats')}><ul className="space-y-2" data-testid="pm-caveats">{orderCaveats(v.caveats).map((c, k) => <li key={`${c.code}${k}`}>
    <Notice tone={['frozen', 'stale', 'thin_market', 'unit_mismatch', 'unconfirmed_convention', 'company_note'].includes(c.code) ? 'warn' : 'info'}><p className="font-semibold">{t(caveatKey(c.code))}</p><p className="mt-0.5 text-[12.5px] text-mute">{c.text}</p>
      {typeof c.data?.url === 'string' && <p className="mt-0.5 text-[12.5px]"><Src url={c.data.url} /></p>}</Notice></li>)}</ul></Section>;
}

function References({ list }: { list: PmReference[] }) {
  const t = useT(), locale = useLocale();
  if (!list.length) return null;
  return <Section title={t('pmReferences')}><Card className="!py-2"><ul className="divide-y divide-line">{list.map((r, k) => <li key={k} className="py-3 text-[13.5px]">
    <p className="font-semibold">{r.valueUsd ? compactUsd(r.valueUsd, locale) : t('pmRange')} <span className="font-medium text-mute">· {t(referenceKindKey(r.kind))} · {r.date}</span></p>
    <p className="text-[12.5px] leading-snug text-mute">{r.detail}</p><p className="text-[12.5px]"><Src url={r.sourceUrl} /> · {t('pmConfidence')} : {t(`pmConf_${r.confidence}` as Key)}</p></li>)}</ul></Card></Section>;
}

function Detail({ id, nav, delisted }: { id: string; nav: Nav; delisted: boolean }) {
  const t = useT(), locale = useLocale();
  const [pos, setPos] = useState<PmPosition>({ side: 'long', size: '1' }), [typed, setTyped] = useState('1');
  const q = useQuery({ queryKey: ['pm-detail', id, pos.side, pos.size], queryFn: () => get<PmDetail>(pmDetailQuery(id, pos)), refetchInterval: 20_000, placeholderData: (prev) => prev });
  const back = () => nav({ tab: 'private', view: delisted ? 'delisted' : undefined });
  if (q.isLoading) return <div className="space-y-4"><PageTitle onBack={back} backLabel={t('pmBack')}>{id.split(':').slice(1).join(':')}</PageTitle><SkeletonCard lines={4} /><SkeletonCard lines={6} /></div>;
  if (q.isError || !q.data) return <div className="space-y-4"><PageTitle onBack={back} backLabel={t('pmBack')}>{t('pmTitle')}</PageTitle><ErrorState title={t('pmLoadError')} onRetry={() => void q.refetch()}>{(q.error as Error | null)?.message}</ErrorState></div>;
  const d = q.data, m = d.market, c = m.contract, now = d.ts, bad = sizeParam(typed) === null;
  const closes = (d.candles.candles ?? []).map((x) => Number(x.close));
  return <div className="space-y-5" data-testid="pm-detail">
    <PageTitle onBack={back} backLabel={t('pmBack')}>{m.company?.name ?? m.symbol}</PageTitle>
    <PmNotice compact />
    <Card><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[15px] font-semibold">{m.platform}</p><p className="break-all font-mono text-[12.5px] text-mute">{m.id}</p></div>
      {closes.length > 1 && <Spark data={closes} w={96} h={34} />}</div>
      <p className="t-num mt-3 text-[34px]">{priceText(m.market.price.value, locale, 6)} <span className="text-[14px] font-medium text-mute">{c.quoteCurrency}</span></p>
      <div className="mt-2 flex flex-wrap gap-1.5"><UnitTag m={m} /><FreshTag m={m} now={now} />{m.status === 'delisted' && <Tag tone="mute" icon="stop">{t('pmDelisted')}</Tag>}
        <Tag tone={m.review.state === 'reviewed' ? 'ok' : 'warn'} icon={m.review.state === 'reviewed' ? 'check' : 'warn'} testid="pm-review">{t(`pmReview_${m.review.state}` as Key)}</Tag></div>
      {m.review.reasons.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12.5px] leading-snug text-mute">{m.review.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {m.error && <p className="mt-2 text-[13px] text-danger" role="status">{t('pmVenueError')} — {m.error}</p>}
      {d.candles.candles && <p className="mt-2 text-[12px] text-mute">{t('pmCandles', { n: d.candles.candles.length, interval: d.candles.interval ?? '' })} · {d.candles.source}</p>}</Card>

    <Card><Field label={t('pmSizeLabel')} hint={bad ? t('pmSizeBad') : t('pmSizeHint')}><input className={inputCls} inputMode="decimal" value={typed} aria-invalid={bad} data-testid="pm-size"
      onChange={(e) => { setTyped(e.target.value); const s = sizeParam(e.target.value); if (s) setPos((p) => ({ ...p, size: s })); }} /></Field>
      <div className="mt-3"><Seg value={pos.side} options={[['long', t('pmLong')], ['short', t('pmShort')]] as const} onChange={(side) => setPos((p) => ({ ...p, side }))} label={t('pmSide')} /></div></Card>
    <ValuationPanel v={m.valuation} now={now} quote={c.quoteCurrency} />
    <Caveats v={m.valuation} />

    <Section title={t('pmMarketData')}><StatGrid cols={2}>
      <Stat label={t('pmOracle')} value={priceText(m.market.oracle.value, locale, 6)} sub={m.market.oracle.source} />
      <Stat label={t('pmFunding')} value={fundingText(m.market.funding, locale)} sub={ageText(m.market.funding.ts, now, locale)} />
      <Stat label={t('pmOpenInterest')} value={compactUsd(m.market.openInterestUsd.value, locale)} sub={`${priceText(m.market.openInterest.value, locale, 2)} ${t('pmContracts')} · ${t('pmOurArithmetic')}`} />
      <Stat label={t('pmVolume')} value={compactUsd(m.market.volume24h.value, locale)} sub={`${priceText(m.market.volumeBase24h.value, locale, 2)} ${t('pmContracts')}`} />
      <Stat label={t('pmBid')} value={d.book.bids?.[0] ? priceText(d.book.bids[0][0], locale, 6) : '—'} sub={d.book.bids?.[0] ? `× ${priceText(d.book.bids[0][1], locale, 4)}` : d.book.error ?? t('pmEmptyBook')} />
      <Stat label={t('pmAsk')} value={d.book.asks?.[0] ? priceText(d.book.asks[0][0], locale, 6) : '—'} sub={d.book.asks?.[0] ? `× ${priceText(d.book.asks[0][1], locale, 4)}` : d.book.error ?? t('pmEmptyBook')} />
    </StatGrid><div className="mt-1.5 px-1"><Provenance d={m.market.price} now={now} /></div></Section>

    <Section title={t('pmContract')}><Card className="!py-2"><p className="pb-1 pt-2 text-[12px] text-mute">{t('pmSourceTextNote')}</p><dl>
      <Long k={t('pmNature')}>{c.nature}</Long><Fact k={t('pmUnderlying')}>{c.underlying ?? t('pmUnidentified')}</Fact><Fact k={t('pmUnit')}>{c.unit.label}</Fact>
      <Fact k={t('pmQuote')}>{c.quoteCurrency}{c.collateral ? ` · ${t('pmCollateral')} ${c.collateral}` : ''}</Fact><Long k={t('pmContractSize')}>{c.contractSize}</Long>
      <Long k={t('pmMultiplier')}>{c.multiplier ? `${c.multiplier.value} — ${c.multiplier.source}` : t('pmNotPublished')}</Long>
      <Long k={t('pmSettlement')}>{c.settlement}</Long><Long k={t('pmIpo')}>{c.ipoConversion}</Long><Long k={t('pmOracleDef')}>{c.oracle}</Long><Long k={t('pmLiquidation')}>{c.liquidation}</Long>
      <Fact k={t('pmLeverage')}>{c.maxLeverage ? `${c.maxLeverage}×` : '—'}{c.margin ? ` · ${c.margin}` : ''}</Fact>
      {c.assetId !== null && <Fact k={t('pmAssetId')} mono>{c.assetId} ({t('pmInformational')})</Fact>}
      {c.onChainDescription !== null && <Long k={t('pmOnChain')}>{c.onChainDescription || t('pmOnChainEmpty')}</Long>}
      <Fact k={t('pmReviewed')}>{m.review.reviewedAt ?? t('pmReview_not_reviewed')}{m.review.validUntil ? ` · ${t('pmValidUntil', { date: m.review.validUntil.slice(0, 10) })}` : ''}</Fact></dl>
      {c.sources.length > 0 && <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line py-3 text-[12.5px]">{c.sources.map((s) => <Src key={s} url={s} />)}</p>}</Card></Section>

    {d.sameCompany.length > 0 && <Section title={t('pmOtherVenues')}><Card className="!py-2"><p className="pb-1 pt-2 text-[12.5px] leading-snug text-mute">{t('pmNeverAveraged')}</p><ul className="divide-y divide-line">{d.sameCompany.map((o) =>
      <li key={o.id}><button type="button" className="row-press flex w-full items-center justify-between gap-3 py-3 text-left" onClick={() => nav({ tab: 'private', asset: o.id })}>
        <span className="min-w-0"><span className="block text-[14px] font-semibold">{o.platform}</span><span className="block text-[12px] text-mute">{o.unit.label}</span></span>
        <span className="t-num shrink-0 text-[16px]">{priceText(o.price.value, locale)}</span></button></li>)}</ul></Card></Section>}
    <References list={d.references} />

    <Section title={t('pmTrading')}><Card><Btn full disabled aria-disabled="true" data-testid="pm-trade-disabled"><Icon n="lock" className="h-4 w-4" />{t('pmTradingDisabled')}</Btn>
      <ul className="mt-3 list-disc space-y-1 pl-4 text-[12.5px] leading-snug text-mute" data-testid="pm-not-tradable">{m.notTradable.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Card></Section>
  </div>;
}

export function PrivateMarkets({ instrument, view, nav }: { instrument?: string; view?: string; nav: Nav }) {
  const t = useT(), delisted = view === 'delisted';
  const q = useQuery({ queryKey: ['pm-list', delisted], queryFn: () => get<PmList>(pmListQuery(delisted)), refetchInterval: 20_000, enabled: !instrument });
  if (instrument) return <Detail id={instrument} nav={nav} delisted={delisted} />;
  return <div className="space-y-4" data-testid="pm-screen">
    <PageTitle>{t('pmTitle')}</PageTitle>
    <p className="text-[14px] leading-snug text-mute">{t('pmLead')}</p>
    <PmNotice />
    <Seg value={delisted ? 'delisted' : 'live'} options={[['live', t('pmFilterLive')], ['delisted', t('pmFilterDelisted')]] as const} onChange={(v) => nav({ tab: 'private', view: v === 'delisted' ? 'delisted' : undefined })} label={t('pmFilter')} />
    {delisted && <Notice tone="info">{t('pmDelistedNote')}</Notice>}
    {q.isLoading ? <SkeletonRows n={4} /> : q.isError || !q.data ? <ErrorState title={t('pmLoadError')} onRetry={() => void q.refetch()}>{(q.error as Error | null)?.message}</ErrorState>
      : <PmListView data={q.data} onOpen={(id) => nav({ tab: 'private', asset: id, view: delisted ? 'delisted' : undefined })} />}
  </div>;
}
