// NFT market screens (delivery 3, READ ONLY) — a lazy chunk of its own, loaded when an item, a collection or the sources are opened.
//
// Rules of these screens:
//  - one block PER SOURCE: a marketplace's figures are never merged with another's, and a disagreement is said as such;
//  - the five price notions are five labelled lines — asking price, best offer, last sale, collection floor, realised sale (in the
//    activity) — each in its own currency with its exact identifier, its source and its age; a fiat figure is a secondary line
//    with the rate's own source and date;
//  - a source that is absent says WHY (key missing / turned off / error / not covered) and names the server variable; nothing is
//    shown in its place — never a zero, never an example;
//  - every market action is a DISABLED control with its reason: no order is built, signed or sent by this wallet. The links to a
//    marketplace's own page live in a separate "external" group, with what is true about acting there with this wallet.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState, type ReactNode } from 'react';
import { get, post, type ApiError } from '../api';
import { I18n, useT, type Key } from '../i18n';
import { currencyKey, fiatText, moneyText, safeLink, shortId, verificationOf, type CollectionMarketAnswer, type CollectionMarketRow, type ExternalNotice, type FloorEstimate, type Known, type MarketAction, type MarketEvents, type MarketListing, type MarketOffer, type MarketOrders,
  type MarketProviderRow, type Money, type NftItem, type NftMarketAnswer, type Rate, type SourceStatus, type TraitAnswer } from '../nft';
import { Btn, Card, Chips, Fact, Icon, Notice, PageTitle, Section, Skeleton, Tag, when } from '../ui';
import { NftMediaView, tk } from './Nft';

type T = ReturnType<typeof useT>;
const enc = encodeURIComponent;

/** The state of one source, in words — with the variable that would turn it on. */
export function SourceState({ s }: { s: SourceStatus }) {
  const t = useT(); const { locale } = useContext(I18n);
  const tone = s.state === 'ok' ? (s.stale ? 'warn' : 'ok') : s.state === 'error' ? 'danger' : 'mute';
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="nft-market-source" data-provider={s.provider} data-state={s.state} data-stale={s.stale}>
    <span className="text-[0.9375rem] font-semibold">{s.name}</span>
    <Tag tone={tone} icon={s.state === 'ok' ? (s.stale ? 'warn' : 'chart') : s.state === 'needs_key' ? 'key' : s.state === 'off' ? 'minus' : s.state === 'error' ? 'warn' : 'eyeOff'}>{t(`nfMkState_${s.state}` as Key)}{s.stale ? ` · ${t('nfStale')}` : ''}</Tag>
    {s.stamp && <span className="text-[0.75rem] text-mute">{t('nfMkUpdated', { time: when(s.stamp.fetchedAt, locale) })}</span>}
    {s.state !== 'ok' && <p className="basis-full text-[0.78125rem] leading-snug text-mute" data-testid="nft-market-source-why">{tk(t, 'nfMkWhy_', s.code, 'nfMkWhyOther')}{s.unlockedBy ? <> — {t('nfUnlockedBy')} <code className="font-mono text-[0.71875rem] text-ink">{s.unlockedBy}</code></> : null}</p>}
    {s.state === 'ok' && s.stale && s.code && <p className="basis-full text-[0.78125rem] text-warn">{t('nfMkStaleWhy', { code: s.code })}</p>}
  </div>;
}
/** An amount in its own currency (exact), its identifier, and — secondary — the fiat figure with the rate's source and date. */
export function MoneyLine({ m, rates, testid }: { m: Money; rates: Record<string, Rate>; testid?: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const r = rates[currencyKey(m.currency)], usd = r ? fiatText(m.amount, m.currency.decimals, r.usd) : null;
  return <span className="block text-right" data-testid={testid} data-amount={m.amount} data-currency={currencyKey(m.currency)}>
    <span className="font-semibold">{moneyText(m)}</span>
    <span className="block break-all font-mono text-[0.65625rem] text-mute">{m.currency.network} · {m.currency.asset === 'native' ? t('nfMkNative') : shortId(m.currency.asset)}{m.precision === 'source_decimal' ? ` · ${t('nfMkFromDecimal')}` : ''}</span>
    {usd && <span className="block text-[0.75rem] text-mute" data-testid="nft-market-fiat">≈ {usd} USD · {t('nfMkRate', { source: r!.source, time: r!.priceAt ? when(r!.priceAt, locale) : '—' })}{r!.stale ? ` · ${t('nfStale')}` : ''}</span>}
    {r?.withheld && <span className="block text-[0.75rem] text-mute">{t('nfMkRateWithheld')}</span>}
  </span>;
}
function KnownLine<V>({ k, render, t }: { k: Known<V>; render: (v: V) => ReactNode; t: T }) {
  if (k.state === 'known') return <>{render(k.value)}</>;
  return <span className="text-mute" data-state={k.state}>{k.state === 'none' ? t('nfMkNoneReported') : k.state === 'unsupported' ? t('nfNotApplicable') : `${t('nfUnavailable')}${'reason' in k && k.reason ? ` (${tk(t, 'nfMkWhy_', k.reason, 'nfMkWhyCode')})` : ''}`}</span>;
}
const WHAT_TRUE = (n: ExternalNotice): Key => (!n.walletConnect && !n.keyExport ? 'nfMkExternalTruth' : 'nfOutsideWarn');

/** The disabled market actions, each with its reason; then — apart — the links that leave SP Wallet. */
export function MarketActions({ actions, external }: { actions: MarketAction[]; external?: NftMarketAnswer['external'] }) {
  const t = useT();
  return <div className="space-y-4">
    <div role="group" aria-label={t('nfMkActionsInternal')} data-testid="nft-market-actions-internal">
      <p className="mb-2 text-[0.78125rem] font-medium uppercase tracking-wide text-mute">{t('nfMkActionsInternal')}</p>
      <div className="grid grid-cols-2 gap-2">{actions.map((a) => <Btn key={a.id} kind="soft" disabled aria-describedby="nft-market-actions-why" data-testid={`nft-market-action-${a.id}`} data-available="false">{tk(t, 'nfMkAct_', a.id, 'nfMarketActions')}</Btn>)}</div>
      <p id="nft-market-actions-why" className="mt-2 text-[0.78125rem] leading-snug text-warn" data-testid="nft-market-actions-why" data-reason={actions[0]?.reason ?? ''}>{tk(t, 'nfMkActWhy_', actions[0]?.reason, 'nfMarketWhy')}</p>
    </div>
    {external && external.links.length > 0 && <div role="group" aria-label={t('nfMkActionsExternal')} className="border-t border-line pt-4" data-testid="nft-market-actions-external">
      <p className="mb-2 text-[0.78125rem] font-medium uppercase tracking-wide text-mute">{t('nfMkActionsExternal')}</p>
      <Notice tone="warn"><span data-testid="nft-outside-warning">{t('nfOutsideWarn')} {t(WHAT_TRUE(external.notice))}</span></Notice>
      <div className="mt-3 flex flex-wrap gap-2">{external.links.map((m) => { const l = safeLink(m.url); return l ? <a key={m.name} href={l.href} target="_blank" rel="noreferrer noopener" className="press inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line px-3.5 text-[0.84375rem] font-medium" data-testid="nft-market-link"><Icon n="ext" className="h-3.5 w-3.5" />{t('nfMkOpenOn', { market: m.name })} <span className="font-normal text-mute">({l.host})</span></a> : null; })}</div>
    </div>}
  </div>;
}

/** The item page's market panel. */
export function MarketPanel({ id, onOpenMarket }: { id: string; onOpenMarket: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nft', 'market', id], queryFn: () => get<NftMarketAnswer>(`/nfts/market?key=${enc(id)}`), retry: false, staleTime: 60_000 });
  const refresh = useMutation({ mutationFn: () => get<NftMarketAnswer>(`/nfts/market?key=${enc(id)}&refresh=1`), onSuccess: (d) => qc.setQueryData(['nft', 'market', id], d) });
  if (q.isError) return <Notice tone="warn"><span data-testid="nft-market-error">{t('nfMkUnavailable')} ({(q.error as ApiError)?.code ?? 'error'})</span></Notice>;
  if (!q.data) return <Skeleton h="h-40" />;
  const d = q.data, live = d.sources.filter((s) => s.status.state === 'ok');
  return <div className="space-y-4" data-testid="nft-market" data-sources={d.sources.length} data-ok={live.length}>
    {d.sources.length === 0 && <p className="text-[0.84375rem] text-mute" data-testid="nft-market-none">{t('nfMkNoSourceForChain')}</p>}
    {d.sources.length > 0 && live.length === 0 && <Notice tone="info"><span data-testid="nft-market-unavailable">{t('nfMkAllUnavailable')}</span></Notice>}
    {d.sources.map((s) => <div key={s.status.provider} className="rounded-2xl border border-line p-4" data-testid="nft-market-row" data-provider={s.status.provider}>
      <SourceState s={s.status} />
      {s.status.state === 'ok' && <dl className="mt-3">
        <Fact k={t('nfListed')}><KnownLine k={s.listed} t={t} render={(v) => <span data-testid="nft-market-listed">{t(v ? 'nfYes' : 'nfNo')}</span>} /></Fact>
        <Fact k={t('nfAsking')}><KnownLine k={s.ask} t={t} render={(l) => <MoneyLine m={l.price} rates={d.rates} testid="nft-market-ask" />} /></Fact>
        <Fact k={t('nfBestOffer')}><KnownLine k={s.bestOffer} t={t} render={(o) => <MoneyLine m={o.price} rates={d.rates} testid="nft-market-offer" />} /></Fact>
        <Fact k={t('nfMkLastSale')}><KnownLine k={s.lastSale} t={t} render={(x) => <><MoneyLine m={x.price} rates={d.rates} testid="nft-market-last-sale" /><LastSaleWhen at={x.at} /></>} /></Fact>
        <Fact k={t('nfFloor')}><KnownLine k={s.collectionFloor} t={t} render={(m) => <MoneyLine m={m} rates={d.rates} testid="nft-market-floor" />} /></Fact>
        {s.verification && <Fact k={t('nfMkBadge')}><span data-testid="nft-market-badge" data-state={s.verification.state}>{s.verification.state === 'verified' ? t('nfMkVerifiedBy', { source: s.verification.by }) : t('nfMkNotVerifiedBy', { source: s.verification.by })}</span></Fact>}
        {s.rarity.state === 'known' && <Fact k={t('nfMkRank')}><span data-testid="nft-market-rank">{s.rarity.value.outOf ? t('nfMkRankOf', { rank: s.rarity.value.rank, n: s.rarity.value.outOf }) : s.rarity.value.rank} · {t('nfMkMethod', { method: s.rarity.value.method, source: s.status.name })}</span></Fact>}
        {s.flags.suspicious.state === 'known' && s.flags.suspicious.value && <Fact k={t('nfMkFlag')}><span className="text-warn">{t('nfMkSuspicious', { source: s.status.name })}</span></Fact>}
      </dl>}
      {s.status.state === 'ok' && s.status.attribution && <p className="mt-2 text-[0.75rem] text-mute">{s.status.attribution.text}</p>}
    </div>)}
    {d.contradictions.length > 0 && <Notice tone="warn"><span data-testid="nft-market-contradictions">{t('nfMkContradict')} {d.contradictions.map((c) => `${tk(t, 'nfMkField_', c.field, 'nfMkWhyCode')} (${c.providers.join(' ≠ ')})`).join(' · ')}</span></Notice>}
    <p className="text-[0.78125rem] font-medium" data-testid="nft-market-value">{t('nfValueItem')} <span className="font-normal text-mute">{t('nfFloorNote')}</span></p>
    <div className="flex flex-wrap gap-2"><Btn kind="soft" onClick={onOpenMarket} data-testid="nft-market-open"><Icon n="chart" className="h-4 w-4" />{t('nfMkOpenScreen')}</Btn>
      {live.length > 0 && <Btn kind="ghost" busy={refresh.isPending} onClick={() => refresh.mutate()} data-testid="nft-market-refresh"><Icon n="refresh" className="h-4 w-4" />{t('nfMkRefresh')}</Btn>}</div>
  </div>;
}
function LastSaleWhen({ at }: { at: string | null }) { const { locale } = useContext(I18n); return at ? <span className="block text-right text-[0.75rem] text-mute">{when(at, locale)}</span> : null; }

function OrderList({ kind, id }: { kind: 'listings' | 'offers'; id: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['nft', 'market', kind, id], queryFn: () => get<MarketOrders>(`/nfts/market/${kind}?key=${enc(id)}`), retry: false, staleTime: 60_000 });
  if (q.isError) return <Notice tone="warn">{t('nfMkUnavailable')}</Notice>;
  if (!q.data) return <Skeleton h="h-24" />;
  return <div className="space-y-3" data-testid={`nft-market-${kind}`}>{q.data.sources.map((s) => <div key={s.status.provider} className="rounded-2xl border border-line p-4" data-provider={s.status.provider}>
    <SourceState s={s.status} />
    {s.status.state === 'ok' && (s.items.length === 0 ? <p className="mt-2 text-[0.84375rem] text-mute" data-testid={`nft-market-${kind}-empty`}>{t(kind === 'listings' ? 'nfMkNoListing' : 'nfMkNoOffer')}</p>
      : <ul className="mt-2 divide-y divide-line">{s.items.map((o, k) => { const who = kind === 'listings' ? (o as MarketListing).seller : (o as MarketOffer).bidder;
        return <li key={o.orderId ?? k} className="flex items-start justify-between gap-3 py-2.5"><div className="min-w-0 text-[0.78125rem] text-mute">
          <p>{o.venue ?? s.status.name}{kind === 'offers' && (o as MarketOffer).scope !== 'item' ? ` · ${t(`nfMkScope_${(o as MarketOffer).scope}` as Key)}` : ''}{o.quantity !== '1' ? ` · ×${o.quantity}` : ''}</p>
          {who && <p className="break-all font-mono text-[0.71875rem]">{shortId(who)}</p>}{o.expiresAt && <p>{t('nfMkExpires', { time: when(o.expiresAt, locale) })}</p>}</div>
          <MoneyLine m={o.price} rates={q.data!.rates} /></li>; })}</ul>)}
  </div>)}</div>;
}

/** Market events, per source — apart from the chain's transfers. Filter by type; older pages through the source's own cursor. */
export function MarketActivity({ id }: { id: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [type, setType] = useState('');
  const q = useQuery({ queryKey: ['nft', 'market', 'activity', id, type], queryFn: () => get<MarketEvents>(`/nfts/market/activity?key=${enc(id)}&limit=20${type ? `&type=${type}` : ''}`), retry: false, staleTime: 60_000 });
  const [more, setMore] = useState<Record<string, MarketEvents['sources'][number]>>({});
  const older = useMutation({ mutationFn: (s: { provider: string; cursor: string }) => get<MarketEvents>(`/nfts/market/activity?key=${enc(id)}&limit=20&provider=${s.provider}&cursor=${enc(s.cursor)}${type ? `&type=${type}` : ''}`),
    onSuccess: (d, v) => { const got = d.sources[0]; if (got) setMore((m) => ({ ...m, [`${v.provider}|${type}`]: { ...got, events: [...(m[`${v.provider}|${type}`]?.events ?? []), ...got.events] } })); } });
  return <div data-testid="nft-market-activity">
    <Chips label={t('nfMkEventType')} value={type} onChange={setType} options={[{ id: '', label: t('all') }, ...['sale', 'list', 'offer', 'delist', 'cancel-offer'].map((x) => ({ id: x, label: t(`nfEv_${x.replace(/-/g, '_')}` as Key) }))]} />
    {q.isError ? <Notice tone="warn">{t('nfMkUnavailable')}</Notice> : !q.data ? <Skeleton h="h-24" className="mt-3" /> : <div className="mt-3 space-y-3">
      {q.data.sources.length === 0 && <p className="text-[0.84375rem] text-mute">{t('nfMkNoSourceForChain')}</p>}
      {q.data.sources.map((s) => { const extra = more[`${s.status.provider}|${type}`], events = [...s.events.filter((e) => e.type !== 'transfer' && e.type !== 'mint'), ...(extra?.events.filter((e) => e.type !== 'transfer' && e.type !== 'mint') ?? [])], cursor = extra ? extra.cursor : s.cursor;
        return <div key={s.status.provider} className="rounded-2xl border border-line p-4" data-provider={s.status.provider}><SourceState s={s.status} />
          {s.status.state === 'ok' && (events.length === 0 ? <p className="mt-2 text-[0.84375rem] text-mute" data-testid="nft-market-activity-empty">{t('nfMkNoEvent')}</p>
            : <ol className="mt-2 divide-y divide-line">{events.map((e, k) => <li key={k} className="flex items-start justify-between gap-3 py-2.5" data-type={e.type}>
              <div className="min-w-0"><Tag tone={e.type === 'sale' ? 'ok' : 'mute'} icon="chart">{tk(t, 'nfEv_', e.type.replace(/-/g, '_'), 'nfEv_unknown')}</Tag>
                <p className="mt-1 text-[0.78125rem] text-mute">{e.at ? when(e.at, locale) : t('nfActNoTime')}{e.venue ? ` · ${e.venue}` : ''}</p>
                {(e.from || e.to) && <p className="break-all font-mono text-[0.71875rem] text-mute">{e.from ? shortId(e.from) : '?'} → {e.to ? shortId(e.to) : '?'}</p>}
                {e.flags.washTrade.state === 'known' && e.flags.washTrade.value && <p className="text-[0.75rem] text-warn">{t('nfMkWash', { source: s.status.name })}</p>}</div>
              {e.price ? <MoneyLine m={e.price} rates={q.data!.rates} /> : <span className="text-[0.78125rem] text-mute">{t('nfMkNoPrice')}</span>}</li>)}</ol>)}
          {s.status.state === 'ok' && cursor && <Btn kind="soft" className="mt-2" busy={older.isPending} onClick={() => older.mutate({ provider: s.status.provider, cursor })}>{t('nfActOlder')}</Btn>}</div>; })}
      <p className="text-[0.75rem] text-mute">{t('nfMkEventsNote')}</p></div>}
  </div>;
}

/** Brief §10.6 — the Market screen of one item: listings and offers per source, the actions (all disabled, with the reason), the external links apart. */
export function NftMarketScreen({ item, onClose }: { item: NftItem; onClose: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['nft', 'market', item.key], queryFn: () => get<NftMarketAnswer>(`/nfts/market?key=${enc(item.key)}`), retry: false, staleTime: 60_000 });
  return <div className="space-y-5" data-testid="nft-market-screen" data-key={item.key}>
    <PageTitle onBack={onClose} backLabel={t('back')}>{t('nfMkScreenTitle')}</PageTitle>
    <Card><p className="break-all font-mono text-[0.75rem] text-mute" data-testid="nft-market-screen-id">{item.key}</p><p className="mt-2 text-[0.8125rem] text-mute">{t('nfMkScreenIntro')}</p></Card>
    <Section title={t('nfMkListings')}><OrderList kind="listings" id={item.key} /></Section>
    <Section title={t('nfMkOffers')}><OrderList kind="offers" id={item.key} /></Section>
    <Section title={t('nfMkEvents')}><Card><MarketActivity id={item.key} /></Card></Section>
    <Section title={t('nfActions')}><Card>{q.data ? <MarketActions actions={q.data.actions} external={q.data.external} /> : q.isError ? <Notice tone="warn">{t('nfMkUnavailable')}</Notice> : <Skeleton h="h-32" />}</Card></Section>
  </div>;
}

/** Trait frequency of the item's attributes: only with a source's stated total — « 3,2 % de 8 421 items indexés ». */
export function TraitFrequencies({ id }: { id: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['nft', 'market', 'traits', id], queryFn: () => get<TraitAnswer>(`/nfts/market/traits?key=${enc(id)}`), retry: false, staleTime: 5 * 60_000 });
  if (q.isError || !q.data) return <p className="mt-3 text-[0.78125rem] text-mute" data-testid="nft-rarity">{t('nfRarityNotComputed')}{q.isError ? '' : ' …'}</p>;
  const d = q.data, done = d.sources.filter((s) => s.computed);
  if (!done.length) return <p className="mt-3 text-[0.78125rem] text-mute" data-testid="nft-rarity" data-computed="false">{t('nfRarityNotComputed')} {tk(t, 'nfMkTraitWhy_', d.reason, 'nfRarityWhy_no_collection_index')}</p>;
  const sep = locale === 'fr' ? ',' : '.', num = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'fr' ? ' ' : ',');
  return <div className="mt-3 space-y-3" data-testid="nft-rarity" data-computed="true">{done.map((s) => <div key={s.provider} data-provider={s.provider}>
    <p className="text-[0.78125rem] text-mute">{t('nfMkTraitSource', { source: s.name, n: num(s.total!), time: when(s.fetchedAt!, locale) })}{s.stale ? ` · ${t('nfStale')}` : ''}</p>
    <ul className="mt-1 divide-y divide-line">{s.rows.map((r, k) => <li key={k} className="flex items-baseline justify-between gap-3 py-1.5 text-[0.8125rem]"><span className="min-w-0 break-words"><span className="text-mute">{r.traitType} :</span> {r.value}</span>
      <span className="shrink-0 text-right" data-testid="nft-trait-frequency">{r.frequency ? t('nfMkTraitFreq', { percent: r.frequency.percent.replace('.', sep), n: num(r.frequency.total) }) : <span className="text-mute">{t('nfMkTraitNotCounted')}</span>}</span></li>)}</ul>
    {d.mutableMetadata && <p className="mt-1 text-[0.75rem] text-mute">{t('nfMkTraitMutable')}</p>}</div>)}</div>;
}

/** The collection page's market part: image / banner (through the proxy), description and verification with their source, floor and volume as separate figures with source and age, trait counts. */
export function CollectionMarket({ id, onchainKnown }: { id: string; onchainKnown: boolean }) {
  const t = useT();
  const q = useQuery({ queryKey: ['nft', 'market', 'collection', id], queryFn: () => get<CollectionMarketAnswer>(`/nfts/market/collection?key=${enc(id)}`), retry: false, staleTime: 5 * 60_000 });
  if (q.isError) return <Notice tone="warn">{t('nfMkUnavailable')}</Notice>;
  if (!q.data) return <Skeleton h="h-40" />;
  const d = q.data, ok = d.sources.filter((s) => s.status.state === 'ok'), v = verificationOf(d.sources, onchainKnown), banner = ok.find((s) => s.bannerId), logo = ok.find((s) => s.imageId), desc = ok.find((s) => s.description);
  return <div className="space-y-4" data-testid="nft-collection-market">
    {banner && <div className="h-28 overflow-hidden rounded-2xl sm:h-40" data-testid="nft-collection-banner"><NftMediaView m={{ id: banner.bannerId!, kind: 'image', status: 'not_fetched' }} alt={t('nfMkBanner', { source: banner.status.name })} fit="tile" /></div>}
    <Card><div className="flex gap-4">{logo && <span className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl" data-testid="nft-collection-logo"><NftMediaView m={{ id: logo.imageId!, kind: 'image', status: 'not_fetched' }} alt={logo.name ?? id} fit="tile" /></span>}
      <div className="min-w-0"><p data-testid="nft-collection-verif" data-kind={v.kind}><Tag tone={v.kind === 'verified_by' ? 'ok' : 'mute'} icon={v.kind === 'verified_by' ? 'check' : 'minus'}>{v.kind === 'verified_by' ? t('nfMkCollVerifiedBy', { source: v.by.join(', ') }) : t(v.kind === 'known_contract' ? 'nfMkCollKnown' : 'nfMkCollNotVerified')}</Tag></p>
        <p className="mt-1 text-[0.78125rem] leading-snug text-mute">{t(v.kind === 'verified_by' ? 'nfMkCollVerifiedNote' : v.kind === 'known_contract' ? 'nfMkCollKnownNote' : 'nfMkCollNotVerifiedNote')}</p></div></div>
      {desc && <><p className="mt-3 whitespace-pre-line break-words text-[0.875rem] leading-relaxed" data-testid="nft-collection-market-desc">{desc.description}</p><p className="mt-1 text-[0.75rem] text-mute">{t('nfMkDescBy', { source: desc.status.name })}</p></>}</Card>
    {d.sources.length === 0 && <p className="text-[0.84375rem] text-mute">{t('nfMkNoSourceForChain')}</p>}
    {d.sources.map((s) => <CollectionSource key={s.status.provider} s={s} rates={d.rates} />)}
  </div>;
}
function CollectionSource({ s, rates }: { s: CollectionMarketRow; rates: Record<string, Rate> }) {
  const t = useT(), l = s.url ? safeLink(s.url) : null;
  return <div className="rounded-2xl border border-line p-4" data-testid="nft-collection-source" data-provider={s.status.provider}><SourceState s={s.status} />
    {s.status.state === 'ok' && <><dl className="mt-3">
      <Fact k={t('nfFloor')}><KnownLine k={s.floor} t={t} render={(m) => <MoneyLine m={m} rates={rates} testid="nft-collection-floor" />} /></Fact>
      {s.volumes.map((v) => <Fact key={v.interval} k={`${t('nfVolume')} · ${tk(t, 'nfMkInterval_', v.interval, 'nfMkWhyCode')}`}><span data-testid="nft-collection-volume">{v.volume ? <MoneyLine m={v.volume} rates={rates} /> : v.reported ? <span>{v.reported.value} {v.reported.symbol} <span className="block text-[0.71875rem] text-mute">{t('nfMkAsReported')}</span></span> : <span className="text-mute">{t('nfUnavailable')}</span>}{v.sales ? <span className="block text-[0.75rem] text-mute">{t('nfMkSales', { n: v.sales })}</span> : null}</span></Fact>)}
      <Fact k={t('nfMkItems')}><KnownLine k={s.totalSupply} t={t} render={(x) => <>{x}</>} /></Fact><Fact k={t('nfMkOwners')}><KnownLine k={s.owners} t={t} render={(x) => <>{x}</>} /></Fact><Fact k={t('nfMkListedCount')}><KnownLine k={s.listedCount} t={t} render={(x) => <>{x}</>} /></Fact>
      {s.fees && s.fees.length > 0 && <Fact k={t('nfMkFees')}><ul className="space-y-1 text-right text-[0.78125rem]" data-testid="nft-collection-fees">{s.fees.map((f, k) => <li key={k}>{f.bps !== null ? `${(f.bps / 100).toFixed(2)} %` : '?'} · {t(f.kind === 'marketplace' ? 'nfMkFeeMarket' : f.kind === 'creator_royalty' ? 'nfMkFeeRoyalty' : 'nfMkFeeOther')}{f.required === null ? '' : ` · ${t(f.required ? 'nfMkFeeRequired' : 'nfMkFeeOptional')}`}{f.recipient ? <span className="block font-mono text-[0.6875rem] text-mute">{shortId(f.recipient)}</span> : null}</li>)}</ul></Fact>}
    </dl>
    <p className="mt-2 text-[0.75rem] text-mute">{t('nfFloorNote')} {t('nfMkFeesNote')}</p>
    {s.traits.state === 'known' ? <div className="mt-3" data-testid="nft-collection-traits"><p className="text-[0.78125rem] font-medium">{t('nfMkTraitCounts', { n: s.traits.value.total, source: s.status.name })}{s.traits.value.truncated ? ` · ${t('nfMkTraitCut')}` : ''}</p>
      <ul className="mt-1 space-y-1.5">{s.traits.value.categories.slice(0, 12).map((c) => <li key={c.type} className="text-[0.78125rem]"><span className="text-mute">{c.type} :</span> {c.values.slice(0, 6).map((x) => `${x.value} (${x.count})`).join(' · ')}</li>)}</ul></div>
      : <p className="mt-3 text-[0.78125rem] text-mute" data-testid="nft-collection-traits-none">{t('nfMkTraitCountsNone')} {tk(t, 'nfMkTraitWhy_', 'reason' in s.traits ? s.traits.reason : null, 'nfRarityWhy_no_collection_index')}</p>}
    {l && <p className="mt-3 text-[0.78125rem]"><a href={l.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 font-medium text-blue" data-testid="nft-collection-external"><Icon n="ext" className="h-3.5 w-3.5" />{t('nfMkOpenOn', { market: s.status.name })}</a> <span className="text-mute">— {t('nfExternalWarn')}</span></p>}</>}
  </div>;
}

/** Which market sources exist, which are on, and what each key would unlock — with the request counters of the ones that are on. */
export function MarketProviders() {
  const t = useT();
  const q = useQuery({ queryKey: ['nft', 'market', 'providers'], queryFn: () => get<{ providers: MarketProviderRow[] }>('/nfts/market/providers'), staleTime: 30_000, retry: false });
  if (q.isError) return <p className="text-[0.8125rem] text-mute">{t('nfMkUnavailable')}</p>;
  if (!q.data) return <Skeleton h="h-24" />;
  return <ul className="divide-y divide-line" data-testid="nft-market-providers">{q.data.providers.map((p) => <li key={p.id} className="py-3" data-provider={p.id} data-state={p.state}>
    <div className="flex flex-wrap items-center gap-2"><span className="text-[0.875rem] font-semibold">{p.name}</span><Tag tone={p.state === 'on' ? 'ok' : 'mute'} icon={p.state === 'on' ? 'check' : p.state === 'needs_key' ? 'key' : 'minus'}>{t(`nfMkProv_${p.state}` as Key)}</Tag>
      {p.verification && <span className="text-[0.75rem] text-mute">{t(p.verification === 'live' ? 'nfMkVerifLive' : 'nfMkVerifDoc')}</span>}</div>
    <p className="mt-1 text-[0.78125rem] leading-snug text-mute">{p.chains.join(', ')}{p.state !== 'on' && p.unlockedBy ? <> — {t('nfUnlockedBy')} <code className="font-mono text-[0.71875rem] text-ink">{p.unlockedBy}</code></> : null}</p>
    {p.state !== 'on' && p.unlocks && <p className="mt-0.5 text-[0.78125rem] text-mute">{t('nfMkUnlocks')} {tk(t, 'nfMkUnlocks_', p.id, 'nfMkUnlocksOther')}</p>}
    {p.state === 'on' && <p className="mt-0.5 text-[0.78125rem] text-mute">{tk(t, 'nfMkSends_', p.sends, 'nfMkWhyCode')}{p.budget ? ` · ${t('nfMkBudget', { m: p.budget.minute.used, ml: p.budget.minute.limit, d: p.budget.day.used, dl: p.budget.day.limit })}${p.budget.refused || p.budget.upstreamLimited ? ` · ${t('nfMkBudgetRefused', { n: p.budget.refused + p.budget.upstreamLimited })}` : ''}` : ''}</p>}
    {p.terms && <p className="mt-0.5 text-[0.75rem] text-mute">{t('nfMkTerms', { date: p.terms.readAt })} <span className="break-all">{safeLink(p.terms.url)?.host}</span></p>}
  </li>)}</ul>;
}

/** The opt-in view. Default OFF. Never a valuation, never part of a total. */
export function FloorEstimateView() {
  const t = useT(); const qc = useQueryClient(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['nft', 'valuation'], queryFn: () => get<FloorEstimate>('/nfts/valuation'), staleTime: 60_000, retry: false });
  const set = useMutation({ mutationFn: (enabled: boolean) => post('/nfts/valuation', { enabled }), onSettled: () => { void qc.invalidateQueries({ queryKey: ['nft', 'valuation'] }); } });
  if (!q.data) return q.isError ? <p className="text-[0.8125rem] text-mute">{t('nfMkUnavailable')}</p> : <Skeleton h="h-20" />;
  const d = q.data, e = d.estimate;
  return <div data-testid="nft-estimate" data-enabled={d.enabled}>
    <p className="text-[0.8125rem] leading-snug text-mute">{t('nfMkEstIntro')}</p>
    <Btn kind={d.enabled ? 'ghost' : 'soft'} className="mt-3" busy={set.isPending} onClick={() => set.mutate(!d.enabled)} data-testid="nft-estimate-toggle" aria-pressed={d.enabled}>{t(d.enabled ? 'nfMkEstOff' : 'nfMkEstOn')}</Btn>
    {e && <div className="mt-4"><Notice tone="warn"><span data-testid="nft-estimate-label">{t('nfMkEstLabel')}</span></Notice>
      {e.collections.length === 0 ? <p className="mt-3 text-[0.84375rem] text-mute">{t('nfMkEstNone')}</p> : <ul className="mt-3 divide-y divide-line">{e.collections.map((c) => <li key={c.collectionKey} className="py-2.5" data-collection={c.collectionKey}>
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-[0.875rem] font-semibold">{c.name ?? shortId(c.collectionKey)}</p><p className="text-[0.78125rem] text-mute">{t('nfMkEstItems', { n: c.items })}</p></div>
          {c.used ? <MoneyLine m={c.used.indicative} rates={e.rates} testid="nft-estimate-amount" /> : <span className="text-[0.78125rem] text-mute">{tk(t, 'nfMkWhy_', c.reason, 'nfMkWhyCode')}</span>}</div>
        {c.used && <p className="mt-1 text-[0.75rem] text-mute">{t('nfMkEstFloor', { floor: moneyText(c.used.floor), source: c.used.provider, time: when(c.used.fetchedAt, locale) })}{c.used.stale ? ` · ${t('nfStale')}` : ''}</p>}</li>)}</ul>}
      {e.indicativeUsd && <p className="mt-3 text-[0.8125rem]" data-testid="nft-estimate-total">{t('nfMkEstTotal', { usd: e.indicativeUsd, n: e.collectionsCounted })}</p>}
      <p className="mt-1 text-[0.75rem] text-mute">{t('nfMkEstExcluded')}</p></div>}
  </div>;
}
