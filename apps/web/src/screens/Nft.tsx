// NFT screens (delivery 1, READ-ONLY): gallery, collection, item page, receive, lookup. Reached from Assets (Home area).
//
// Rules of these screens:
//  - every value is shown with where it comes from: « Confirmé on-chain », « Métadonnée du créateur », « Indexé par … »,
//    « Marché — mis à jour à … »; what could not be established is written as such (non disponible / non vérifié), never filled in;
//  - a name, a description, a trait are TEXT NODES — never HTML; a link is offered only when it is http(s), with its host shown;
//  - media are loaded from this server's proxy only (an opaque id): <img>, <video>, <audio> without autoplay; an SVG is an image;
//    HTML is never inlined — it stays blocked until the owner asks, then runs in a sandboxed iframe (no same origin; scripts only
//    after a second, explicit action);
//  - Send and the market actions exist as DISABLED controls with the real reason of this asset; there is no way to act from here.
import QRCode from 'qrcode';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Nav } from '../App';
import { get, post, api, type ApiError } from '../api';
import { hasText, I18n, useT, type Key } from '../i18n';
import { displayName, mediaUrl, provenanceKey, safeLink, shortId, SOURCE_NAME, STANDARD_KEY, unitsToText, useNftCaps, useNftItem,
  type Known, type NftActivity, type NftChainCap, type NftItem, type NftList, type NftMedia, type NftReceiveRow, type NftSummary, type Stamp } from '../nft';
import { Addr, Btn, Card, Chips, CopyBtn, EmptyState, ErrorState, Fact, Field, Fold, Icon, inputCls, NetworkIcon, Notice, PageTitle, Section, Seg, Skeleton, Tag, when } from '../ui';

type T = ReturnType<typeof useT>;
// delivery 2: the Send flow and the Bitcoin lock list are a chunk of their own, loaded when the owner opens one of them
const NftSend = lazy(() => import('./NftSend').then((m) => ({ default: m.NftSend })));
const UtxoLocks = lazy(() => import('./NftSend').then((m) => ({ default: m.UtxoLocks })));
/** the text of a server code when one exists; otherwise the generic sentence WITH the code (never a guess at its meaning) */
export const tk = (t: T, prefix: string, code: string | null | undefined, fallback: Key): string => (code && hasText(`${prefix}${code}`) ? t(`${prefix}${code}` as Key) : t(fallback, { code: code ?? '—' }));
const errCode = (e: unknown): string => ((e as ApiError)?.code ?? 'error').replace(/^nft_/, '');

/** A full technical identifier: shown whole, selectable, with a copy control. */
export function CopyId({ value, label }: { value: string; label: string }) {
  const t = useT(); const [ok, setOk] = useState(false);
  useEffect(() => { if (!ok) return; const h = setTimeout(() => setOk(false), 1500); return () => clearTimeout(h); }, [ok]);
  return <span className="inline-flex max-w-full items-start gap-1.5"><span className="min-w-0 select-all break-all font-mono text-[12.5px] leading-relaxed" data-testid="nft-id">{value}</span>
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(value).then(() => setOk(true)); }} aria-label={`${t('copy')} — ${label}`} className="press -my-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-mute hover:text-ink"><Icon n={ok ? 'check' : 'copy'} className="h-4 w-4" /></button></span>;
}
function KnownText<V>({ k, render, t }: { k: Known<V>; render: (v: V) => ReactNode; t: T }) {
  if (k.state === 'known') return <>{render(k.value)}</>;
  return <span className="text-mute">{t(k.state === 'none' ? 'nfNone' : k.state === 'unsupported' ? 'nfNotApplicable' : 'nfUnknown')}</span>;
}
/** The provenance of a value, as a tag: category in words + source. */
export function Provenance({ s }: { s: Stamp }) {
  const t = useT(); const { locale } = useContext(I18n);
  const src = SOURCE_NAME[s.source] ?? s.source;
  return <span data-testid="nft-prov" data-category={s.category} data-fresh={s.freshness} title={`${src} · ${s.detail} · ${when(s.fetchedAt, locale)}`}>
    <Tag tone={s.freshness === 'stale' ? 'warn' : s.category === 'onchain' ? 'ok' : 'mute'} icon={s.freshness === 'stale' ? 'warn' : s.category === 'onchain' ? 'check' : s.category === 'market' ? 'chart' : 'book'}>
      {t(provenanceKey(s), { source: src, time: when(s.fetchedAt, locale) })}{s.freshness === 'stale' ? ` · ${t('nfStale')}` : ''}</Tag></span>;
}

/** One media file through the proxy. `fit`: a tile of the gallery (image only, quiet failure) or the item's player. */
export function NftMediaView({ m, alt, fit }: { m: NftMedia | { id: string; kind: string; status: string } | null; alt: string; fit: 'tile' | 'full' }) {
  const t = useT();
  const [failed, setFailed] = useState(false), [mode, setMode] = useState<'locked' | 'static' | 'run'>('locked');
  const info = useQuery({ queryKey: ['nft', 'media', m?.id], queryFn: () => get<{ status: string; kind?: string; mime?: string; code?: string }>(`/nfts/media/${m!.id}?info=1`), enabled: !!m && fit === 'full' && m.status !== 'blocked', staleTime: 60_000, retry: false });
  const box = fit === 'tile' ? 'aspect-square w-full' : 'aspect-square w-full max-h-[70vh]';
  const placeholder = (icon: string, text: string, code?: string | null, testid = 'nft-media-none') => <div className={`${box} grid place-items-center rounded-2xl bg-elev p-4 text-center text-mute`} data-testid={testid} role="img" aria-label={`${alt} — ${text}`}>
    <span><Icon n={icon} className="mx-auto h-7 w-7" />{fit === 'full' && <><span className="mt-2 block text-[13.5px] font-medium text-ink">{text}</span>{code && <span className="mt-1 block font-mono text-[11.5px]">{code}</span>}</>}</span></div>;
  if (!m) return placeholder('eyeOff', t('nfMediaNone'));
  const blockedCode = m.status === 'blocked' ? ('errorCode' in m ? m.errorCode : null) : info.data && info.data.status === 'media_blocked' ? info.data.code ?? null : null;
  if (m.status === 'blocked' || info.data?.status === 'media_blocked') return placeholder('shield', t('nfMediaBlocked'), tk(t, 'nfBlock_', blockedCode, 'nfBlockOther'), 'nft-media-blocked');
  if (info.data && info.data.status !== 'available') return placeholder('cloudOff', t('nfMediaUnreachable'), info.data.code, 'nft-media-unreachable');
  const kind = info.data?.kind ?? m.kind;
  if (fit === 'full' && info.isLoading) return <Skeleton h="aspect-square" className="!rounded-2xl" />;
  if (kind === 'video') return fit === 'tile' ? placeholder('eye', t('nfMediaVideo')) : <video className={`${box} rounded-2xl bg-black object-contain`} src={mediaUrl(m.id)} controls preload="metadata" playsInline data-testid="nft-media-video" aria-label={alt} />;
  if (kind === 'audio') return fit === 'tile' ? placeholder('eye', t('nfMediaAudio')) : <div className="rounded-2xl bg-elev p-4"><audio className="w-full" src={mediaUrl(m.id)} controls preload="none" data-testid="nft-media-audio" aria-label={alt} /></div>;
  if (kind === 'html') {
    if (fit === 'tile') return placeholder('lock', t('nfMediaActive'));
    if (mode === 'locked') return <div className={`${box} grid place-items-center rounded-2xl bg-elev p-5 text-center`} data-testid="nft-media-active">
      <div className="space-y-3"><Icon n="lock" className="mx-auto h-7 w-7 text-mute" /><p className="text-[14px] font-semibold">{t('nfMediaActive')}</p><p className="mx-auto max-w-[34ch] text-[12.5px] text-mute">{t('nfMediaActiveBody')}</p>
        <div className="flex flex-wrap justify-center gap-2"><Btn kind="soft" onClick={() => setMode('static')} data-testid="nft-media-show">{t('nfMediaShowStatic')}</Btn><Btn kind="ghost" onClick={() => setMode('run')} data-testid="nft-media-run">{t('nfMediaRun')}</Btn></div></div></div>;
    // sandbox: no allow-same-origin, no top navigation, no forms, no popups; scripts only in `run` mode; the document also carries its own sandboxing CSP
    return <div><iframe key={mode} title={alt} src={mediaUrl(m.id, mode === 'run')} sandbox={mode === 'run' ? 'allow-scripts' : ''} allow="" referrerPolicy="no-referrer" loading="lazy" className={`${box} rounded-2xl border border-line bg-white`} data-testid="nft-media-frame" data-mode={mode} />
      <p className="mt-1.5 text-[12px] text-mute">{t(mode === 'run' ? 'nfMediaRunning' : 'nfMediaStaticNote')} <button className="underline" onClick={() => setMode('locked')}>{t('nfMediaClose')}</button></p></div>;
  }
  if (kind === 'model') return placeholder('eyeOff', t('nfMediaModel'));
  if (failed) return placeholder('eyeOff', t('nfMediaFailed'), null, 'nft-media-failed');
  // an SVG is rendered as an IMAGE (scripts in it do not run in an <img>); never inlined into the page
  return <img src={mediaUrl(m.id)} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`${box} rounded-2xl bg-elev object-contain`} data-testid="nft-media-img" />;
}

const stateTone = (s: string): 'ok' | 'warn' | 'danger' | 'mute' => (s === 'in_wallet' ? 'ok' : s === 'escrow_or_delegated' ? 'warn' : s === 'burned' ? 'danger' : 'mute');
function StateTag({ state }: { state: string }) { const t = useT(); return <Tag tone={stateTone(state)} icon={state === 'in_wallet' ? 'check' : state === 'burned' ? 'x' : state === 'unknown' ? 'warn' : 'minus'} testid="nft-state">{tk(t, 'nfState_', state, 'nfState_unknown')}</Tag>; }

/** Per-chain state of the inventory: supported / blocked by provider (and which setting unlocks it) / not supported. Never "no NFT" for a chain that was not read. */
export function ChainStates({ chains }: { chains: NftChainCap[] }) {
  const t = useT();
  const tone = (c: NftChainCap) => (c.inventory === 'supported' ? 'ok' : c.inventory === 'unsupported' ? 'mute' : 'warn') as 'ok' | 'mute' | 'warn';
  return <ul className="divide-y divide-line" data-testid="nft-chains">{chains.map((c) => <li key={c.network} className="flex items-start gap-3 py-2.5" data-chain={c.network} data-inventory={c.inventory}>
    <NetworkIcon net={c.network} size={24} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[14px] font-semibold">{c.name}</span>
      <Tag tone={tone(c)} icon={c.inventory === 'supported' ? 'check' : c.inventory === 'unsupported' ? 'minus' : 'lock'}>{t(`nfInv_${c.inventory}` as Key)}</Tag></div>
      <p className="mt-0.5 text-[12.5px] leading-snug text-mute">{tk(t, 'nfInvWhy_', c.reason.split(':')[0], 'nfInvWhyOther')}{c.unlockedBy ? <> — {t('nfUnlockedBy')} <code className="font-mono text-[11.5px] text-ink">{c.unlockedBy}</code></> : null}</p>
      {c.sections.filter((s) => s.status !== 'ok').map((s) => <p key={s.section} className="mt-0.5 text-[12px] text-mute" data-section={s.section} data-status={s.status}>· {tk(t, 'nfSec_', s.section, 'nfSecOther')} : {t(`nfSecStatus_${s.status}` as Key)}{s.unlockedBy ? <> (<code className="font-mono text-[11px]">{s.unlockedBy}</code>)</> : null}</p>)}
    </div></li>)}</ul>;
}

function Tile({ a, nav, list }: { a: NftSummary; nav: Nav; list: boolean }) {
  const t = useT(); const name = displayName(a);
  const label = name ?? shortId(a.assetId);
  if (list) return <li><button onClick={() => nav({ tab: 'nft', asset: a.key })} className="row-press flex w-full items-center gap-3.5 px-5 py-3 text-left" data-testid="nft-row" data-key={a.key}>
    <span className="h-12 w-12 shrink-0 overflow-hidden rounded-xl"><NftMediaView m={a.image} alt={label} fit="tile" /></span>
    <span className="min-w-0 flex-1"><span className={`block truncate text-[15px] font-semibold ${name ? '' : 'font-mono text-[13px]'}`}>{label}</span><span className="block truncate text-[12.5px] text-mute">{a.collection?.name ?? t('nfNoCollection')} · {t(STANDARD_KEY[a.standard] ?? 'nfStd_unknown')}</span></span>
    <span className="flex shrink-0 flex-col items-end gap-1"><NetworkIcon net={a.chain} size={18} />{a.quantity !== '1' && a.quantity !== '0' && <span className="text-[12px] font-semibold">×{a.quantity}</span>}</span></button></li>;
  return <li><button onClick={() => nav({ tab: 'nft', asset: a.key })} className="press block w-full text-left" data-testid="nft-tile" data-key={a.key}>
    <span className="relative block"><NftMediaView m={a.image} alt={label} fit="tile" /><span className="absolute left-2 top-2 rounded-full bg-surface/90 p-0.5 shadow-e1"><NetworkIcon net={a.chain} size={18} /></span>
      {a.quantity !== '1' && a.quantity !== '0' && <span className="absolute right-2 top-2 rounded-full bg-surface/90 px-2 py-0.5 text-[11.5px] font-bold shadow-e1">×{a.quantity}</span>}</span>
    <span className={`mt-2 block truncate text-[14px] font-semibold ${name ? '' : 'font-mono text-[12.5px]'}`}>{label}</span>
    <span className="block truncate text-[12px] text-mute">{a.collection?.name ?? t('nfNoCollection')}</span>
    {!a.inWallet && <span className="mt-1 block"><StateTag state={a.state} /></span>}</button></li>;
}

/** Open ANY asset by its identifier (it does not have to be in the wallet). */
export function NftLookup({ chains, nav }: { chains: NftChainCap[]; nav: Nav }) {
  const t = useT(); const able = chains.filter((c) => c.lookup);
  const [chain, setChain] = useState('solana'), [address, setAddress] = useState(''), [tokenId, setTokenId] = useState('');
  const evm = able.find((c) => c.network === chain)?.family === 'evm';
  const m = useMutation({ mutationFn: () => post<NftItem>('/nfts/lookup', { chain, address: address.trim(), ...(evm ? { tokenId: tokenId.trim() } : {}) }), onSuccess: (a) => nav({ tab: 'nft', asset: a.key }) });
  const code = m.error ? errCode(m.error) : null, detail = ((m.error as ApiError | null)?.body as { data?: { detail?: string | null } } | undefined)?.data?.detail ?? null;
  return <form className="space-y-3" data-testid="nft-lookup" onSubmit={(e) => { e.preventDefault(); if (address.trim()) m.mutate(); }}>
    <Chips label={t('network')} value={chain} onChange={(v) => { setChain(v); m.reset(); }} options={able.map((c) => ({ id: c.network, label: c.name, net: c.network }))} />
    <Field label={t(evm ? 'nfLookupContract' : 'nfLookupAddress')}><input className={`${inputCls} font-mono text-[13.5px]`} value={address} onChange={(e) => setAddress(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="nft-lookup-address" /></Field>
    {evm && <Field label={t('nfLookupTokenId')}><input className={`${inputCls} font-mono text-[13.5px]`} value={tokenId} onChange={(e) => setTokenId(e.target.value)} inputMode="numeric" autoCapitalize="off" spellCheck={false} data-testid="nft-lookup-token" /></Field>}
    <Btn type="submit" full busy={m.isPending} disabled={!address.trim() || (evm && !tokenId.trim())} data-testid="nft-lookup-go"><Icon n="search" className="h-4 w-4" />{t('nfLookupGo')}</Btn>
    {code && <Notice tone="warn"><span data-testid="nft-lookup-error" data-code={code}>{tk(t, 'nfErr_', code, 'nfErrOther')}{detail ? <> — {tk(t, 'nfErrDetail_', detail, 'nfErrDetailOther')}</> : null}</span></Notice>}
    <p className="text-[12.5px] text-mute">{t('nfLookupNote')}</p></form>;
}

export function NftReceive({ initial }: { initial?: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['nft', 'receive'], queryFn: () => get<{ items: NftReceiveRow[] }>('/nfts/receive'), staleTime: 60_000 });
  const [net, setNet] = useState(initial ?? 'solana'), [qr, setQr] = useState<{ for: string; url: string } | null>(null), [locks, setLocks] = useState(false);
  const a = q.data?.items.find((x) => x.network === net) ?? q.data?.items[0];
  useEffect(() => { if (a) void QRCode.toDataURL(a.address, { margin: 1, width: 720, errorCorrectionLevel: 'Q', color: { dark: '#080B12', light: '#FFFFFF' } }).then((url) => setQr({ for: a.address, url })); }, [a?.address]);
  if (q.isError) return <ErrorState title={t('nfErrLoad')} onRetry={() => void q.refetch()} />;
  if (!a) return <Skeleton h="h-[420px]" />;
  return <div className="space-y-4" data-testid="nft-receive">
    <Card><Chips label={t('network')} value={a.network} onChange={setNet} options={q.data!.items.map((x) => ({ id: x.network, label: x.name, net: x.network }))} />
      <div className="mt-5 grid place-items-center"><div className="w-full max-w-[240px] rounded-[28px] bg-white p-3.5 shadow-e2 ring-1 ring-line">{qr?.for === a.address ? <img src={qr.url} alt={`QR ${a.address}`} width={720} height={720} className="block h-auto w-full rounded-xl" /> : <div className="skel aspect-square w-full !rounded-xl" />}</div></div>
      <div className="mt-4 flex items-center justify-center gap-2 text-[15px] font-semibold"><NetworkIcon net={a.network} size={22} />{a.name}</div>
      <p className="mt-1 text-center text-[12.5px] text-mute">{a.standards.map((s) => t(STANDARD_KEY[s] ?? 'nfStd_unknown')).join(' · ')}</p>
      <div className="mt-4 rounded-2xl bg-elev/70 p-4 text-center"><div className="mb-1 text-xs text-mute">{t('yourAddress')} · {a.name}</div><span data-testid="nft-receive-address"><Addr value={a.address} /></span></div>
      <div className="mt-3"><CopyBtn text={a.address} full /></div></Card>
    {a.warnings.map((w) => <Notice key={w} tone={w === 'ordinals_heuristic_only' ? 'danger' : w === 'arrival_after_confirmation' ? 'info' : 'warn'}><span data-testid={`nft-receive-warn-${w}`}>{t(`nfRecvWarn_${w}` as Key)}</span></Notice>)}
    {/* delivery 2 — Bitcoin: the protected outputs (signer lock list, ord report or heuristic flags) */}
    {a.network === 'bitcoin' && <Card><Btn full kind="soft" onClick={() => setLocks(!locks)} aria-expanded={locks} data-testid="nft-receive-locks"><Icon n="key" className="h-4 w-4" />{t('nfUTitle')}</Btn>
      {locks && <div className="mt-4"><Suspense fallback={<Skeleton h="h-40" />}><UtxoLocks network="bitcoin" /></Suspense></div>}</Card>}
    <Notice tone="warn">{t('nfRecvCompat', { network: a.name })}</Notice>
    <Notice tone="info"><span data-testid="nft-receive-noclaim">{t(a.network === 'bitcoin' ? 'nfRecvBitcoin' : a.detection === 'blocked_by_provider' ? 'nfRecvNoDetect' : 'nfRecvConfirm')}</span></Notice>
  </div>;
}

/** Assets → NFT: gallery and list, filters, search, sort, lookup, receive. */
export function Nfts({ nav, view, collection }: { nav: Nav; view?: string; collection?: string }) {
  const t = useT(); const qc = useQueryClient(); const { locale } = useContext(I18n);
  const caps = useNftCaps();
  const [chain, setChain] = useState(''), [status, setStatus] = useState<'in_wallet' | 'tracked' | 'left'>('in_wallet'), [q, setQ] = useState(''), [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [mode, setMode] = useState<'grid' | 'list'>(() => { try { return localStorage.getItem('spw-nft-view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } });
  const [dq, setDq] = useState('');
  useEffect(() => { const h = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(h); }, [q]);
  const list = useInfiniteQuery({ queryKey: ['nft', 'list', chain, collection ?? '', status, dq, sort], initialPageParam: 0, getNextPageParam: (l: NftList) => l.cursor ?? undefined,
    queryFn: ({ pageParam }) => get<NftList>(`/nfts?${new URLSearchParams({ ...(chain ? { chain } : {}), ...(collection ? { collection } : {}), status, ...(dq ? { q: dq } : {}), sort, cursor: String(pageParam), limit: '48' })}`),
    refetchInterval: (query) => (query.state.data?.pages[0]?.sync.running.length ? 2500 : 60_000), enabled: view !== 'receive' && view !== 'lookup' });
  const sync = useMutation({ mutationFn: () => post('/nfts/sync', {}), onSettled: () => { void qc.invalidateQueries({ queryKey: ['nft'] }); } });
  const first = list.data?.pages[0], items = list.data?.pages.flatMap((p) => p.items) ?? [], chains = caps.data?.chains ?? [];
  const readable = chains.filter((c) => c.lookup), running = (first?.sync.running.length ?? 0) > 0;
  const tabs = <Seg value={(view === 'receive' || view === 'lookup' ? view : 'gallery') as 'gallery' | 'lookup' | 'receive'} role="tablist" label={t('nfTitle')} onChange={(v) => nav({ tab: 'nfts', view: v === 'gallery' ? undefined : v })}
    options={[['gallery', t('nfTabGallery')], ['lookup', t('nfTabLookup')], ['receive', t('nfTabReceive')]] as const} />;
  const title = <PageTitle onBack={() => nav(collection ? { tab: 'nfts' } : { tab: 'assets' })} backLabel={t('back')}>{t('nfTitle')}</PageTitle>;
  const embedded = view === 'embedded';
  if (view === 'receive') return <div className="space-y-4">{title}{tabs}<NftReceive /></div>;
  if (view === 'lookup') return <div className="space-y-4">{title}{tabs}<Card>{caps.data ? <NftLookup chains={chains} nav={nav} /> : <Skeleton h="h-40" />}</Card></div>;
  const lastSync = first ? Object.values(first.sync.lastSyncedAt).sort()[0] : undefined;
  const blocked = chains.filter((c) => c.inventory === 'blocked_by_provider' || c.inventory === 'partial');
  return <div className="space-y-4" data-testid="nft-gallery">
    {!embedded && <>{title}{tabs}<Notice tone="info"><span data-testid="nft-valuation">{t('nfValueUnavailable')}</span></Notice></>}
    <div className="relative"><Icon n="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-mute" />
      <input className={`${inputCls} !pl-11`} type="search" placeholder={t('nfSearch')} aria-label={t('nfSearch')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="nft-search" /></div>
    <Chips label={t('network')} value={chain} onChange={setChain} options={[{ id: '', label: t('all') }, ...readable.map((c) => ({ id: c.network, label: c.name, net: c.network }))]} />
    <div className="flex flex-wrap items-center gap-2"><div className="min-w-[240px] flex-1"><Seg value={status} label={t('nfFilterStatus')} onChange={setStatus} options={[['in_wallet', t('nfStatus_in_wallet')], ['tracked', t('nfStatus_tracked')], ['left', t('nfStatus_left')]] as const} /></div>
      <Seg value={sort} label={t('nfSort')} onChange={setSort} options={[['recent', t('nfSort_recent')], ['name', t('nfSort_name')]] as const} />
      <Seg value={mode} label={t('nfView')} onChange={(v) => { setMode(v); try { localStorage.setItem('spw-nft-view', v); } catch { /* private mode */ } }} options={[['grid', t('nfView_grid')], ['list', t('nfView_list')]] as const} /></div>
    <p className="px-1 text-[12px] text-mute">{t('nfSortPriceNote')}</p>
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[13px] text-mute"><span data-testid="nft-count" aria-live="polite">{first ? t('nfCount', { n: first.total }) : t('loading')}{collection ? ` · ${t('nfInCollection')}` : ''}</span>
      <span className="flex items-center gap-2">{running ? <Tag tone="info" icon="spin" testid="nft-syncing">{t('nfSyncing')}</Tag> : lastSync ? <span data-testid="nft-synced">{t('nfSyncedAt', { time: when(lastSync, locale) })}</span> : <span>{t('nfNeverSynced')}</span>}
        <button onClick={() => sync.mutate()} disabled={sync.isPending || running} aria-label={t('nfSyncNow')} className="press grid h-9 w-9 place-items-center rounded-full bg-elev text-ink disabled:opacity-40" data-testid="nft-sync"><Icon n="refresh" className="h-4 w-4" /></button></span></div>
    {list.isError ? <ErrorState title={t('nfErrLoad')} onRetry={() => void list.refetch()} offline={(list.error as ApiError)?.code === 'offline'}>{t('nfErrLoadBody')}</ErrorState>
      : !first ? <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-busy="true" data-testid="nft-skeleton">{Array.from({ length: 6 }, (_, k) => <li key={k}><Skeleton h="aspect-square" className="!rounded-2xl" /><Skeleton h="h-3.5" className="mt-2 !w-3/4 !rounded-md" /></li>)}</ul>
      : items.length === 0 ? <EmptyState icon={running ? 'clock' : 'search'} title={t(running ? 'nfEmptySyncing' : dq || chain || collection ? 'nfEmptyFilter' : status === 'in_wallet' ? 'nfEmpty' : 'nfEmptyOther')}>
          <span data-testid="nft-empty">{t(running ? 'nfEmptySyncingBody' : 'nfEmptyBody')}</span></EmptyState>
      : mode === 'grid' ? <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">{items.map((a) => <Tile key={a.key} a={a} nav={nav} list={false} />)}</ul>
      : <Card className="!px-0 !py-1"><ul className="divide-y divide-line">{items.map((a) => <Tile key={a.key} a={a} nav={nav} list />)}</ul></Card>}
    {list.hasNextPage && <Btn kind="soft" full busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('nfMore')}</Btn>}
    {!embedded && blocked.length > 0 && <Notice tone="warn"><span data-testid="nft-blocked-note">{t('nfBlockedNote', { n: blocked.length })}</span></Notice>}
    {!embedded && <Card><Fold summary={<span className="text-[15px] font-semibold">{t('nfChainsTitle')}</span>} open={items.length === 0 && !!first} testid="nft-chains-fold">
      <p className="mb-1 text-[12.5px] text-mute">{t('nfChainsBody')}</p>{caps.data ? <ChainStates chains={chains} /> : caps.isError ? <p className="text-[13px] text-mute">{t('nfErrLoad')}</p> : <Skeleton h="h-24" />}</Fold></Card>}
  </div>;
}

export function NftCollection({ id, nav }: { id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['nft', 'collection', id], queryFn: () => get<{ info: { key: string; id: string; chain: string; standard: string; onchainName: string | null; uri: string | null; size: Known<string>; updateAuthority: Known<string>; features: string[]; source: Stamp } | null; error: string | null;
    metadata: { name: string | null; description: string | null; imageId: string | null; status: string } | null; held: number; fetchedAt: string | null }>(`/nfts/collection?key=${encodeURIComponent(id)}`), retry: false, staleTime: 60_000 });
  const back = <PageTitle onBack={() => nav({ tab: 'nfts' })} backLabel={t('back')}>{q.data?.metadata?.name ?? q.data?.info?.onchainName ?? t('nfCollection')}</PageTitle>;
  if (q.isError) return <div className="space-y-4">{back}<ErrorState title={t('nfErrLoad')} onRetry={() => void q.refetch()}>{tk(t, 'nfErr_', errCode(q.error), 'nfErrOther')}</ErrorState></div>;
  if (!q.data) return <div className="space-y-4">{back}<Skeleton h="h-48" /></div>;
  const c = q.data, i = c.info;
  return <div className="space-y-5" data-testid="nft-collection">
    {back}
    {!i && <Notice tone="warn">{tk(t, 'nfErr_', c.error, 'nfErrOther')}</Notice>}
    {i && <Card><div className="flex gap-4"><span className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl">{c.metadata?.imageId ? <NftMediaView m={{ id: c.metadata.imageId, kind: 'image', status: 'not_fetched' }} alt={i.onchainName ?? i.id} fit="tile" /> : <span className="grid h-full w-full place-items-center bg-elev text-mute"><Icon n="book" /></span>}</span>
      <div className="min-w-0"><p className="flex items-center gap-2 text-[13px] text-mute"><NetworkIcon net={i.chain} size={18} />{t(STANDARD_KEY[i.standard] ?? 'nfStd_unknown')}</p>
        {i.onchainName && <p className="mt-1 text-[16px] font-semibold" data-testid="nft-collection-name">{i.onchainName}</p>}<div className="mt-1"><Provenance s={i.source} /></div></div></div>
      {c.metadata?.description && <p className="mt-4 whitespace-pre-line text-[14px] leading-relaxed" data-testid="nft-collection-desc">{c.metadata.description}</p>}
      {c.metadata?.description && <p className="mt-1 text-[12px] text-mute">{t('nfProvCreator')}</p>}
      <dl className="mt-4"><Fact k={t('nfCollectionId')}><CopyId value={i.id} label={t('nfCollectionId')} /></Fact>
        <Fact k={t('nfHeldHere')}>{c.held}</Fact>
        <Fact k={t('nfCollectionSize')}><KnownText k={i.size} t={t} render={(v) => <>{v}</>} /></Fact>
        <Fact k={t('nfUpdateAuthority')}><KnownText k={i.updateAuthority} t={t} render={(v) => <CopyId value={v} label={t('nfUpdateAuthority')} />} /></Fact>
        <Fact k={t('nfVerification')}><span data-testid="nft-collection-verif">{t('nfCollectionNotCertified')}</span></Fact>
        <Fact k={t('nfFloor')}><span className="text-mute">{t('nfUnavailable')}</span></Fact><Fact k={t('nfVolume')}><span className="text-mute">{t('nfUnavailable')}</span></Fact>
        {i.features.length > 0 && <Fact k={t('nfFeatures')}><span className="break-words font-mono text-[12px]">{i.features.join(', ')}</span></Fact>}
        {c.fetchedAt && <Fact k={t('nfUpdated')}>{when(c.fetchedAt, locale)}</Fact>}</dl></Card>}
    <Section title={t('nfHeldItems')}><Nfts nav={nav} collection={id} view="embedded" /></Section>
  </div>;
}

function Price({ p, t }: { p: Known<{ amount: string; currency: { symbol: string; decimals: number } }>; t: T }) {
  return <KnownText k={p} t={t} render={(v) => <span className="font-semibold">{unitsToText(v.amount, v.currency.decimals)} {v.currency.symbol}</span>} />;
}
function Activity({ id }: { id: string }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nft', 'activity', id], queryFn: () => get<NftActivity>(`/nfts/activity?key=${encodeURIComponent(id)}&limit=30`), retry: false, staleTime: 60_000 });
  const older = useMutation({ mutationFn: () => get<NftActivity>(`/nfts/activity?key=${encodeURIComponent(id)}&limit=30&more=1`), onSuccess: (d) => qc.setQueryData(['nft', 'activity', id], d) });
  if (q.isError) return <Notice tone="warn"><span data-testid="nft-activity-error">{t('nfActUnavailable')} ({errCode(q.error)})</span></Notice>;
  if (!q.data) return <Skeleton h="h-24" />;
  const d = q.data;
  return <div data-testid="nft-activity" data-completeness={d.completeness}>
    <p className="mb-2 text-[12.5px] text-mute">{tk(t, 'nfActComp_', d.completeness, 'nfActComp_unavailable')}{d.note ? ` ${tk(t, 'nfActNote_', d.note.replace(/[0-9]+/g, 'N'), 'nfActNoteOther')}` : ''}{d.error ? ` — ${t('nfActError', { code: d.error })}` : ''}</p>
    {d.events.length === 0 ? <p className="text-[13.5px] text-mute" data-testid="nft-activity-empty">{t('nfActEmpty')}</p> : <ol className="divide-y divide-line">{d.events.map((e) => <li key={e.id} className="py-2.5" data-type={e.type}>
      <div className="flex flex-wrap items-center gap-2"><Tag tone={e.type.startsWith('transfer-in') || e.type === 'mint' ? 'ok' : e.type === 'burn' ? 'danger' : 'mute'} icon={e.type === 'unknown' ? 'warn' : 'swap'}>{tk(t, 'nfEv_', e.type.replace(/-/g, '_'), 'nfEv_unknown')}</Tag>
        <span className="text-[12.5px] text-mute">{e.at ? when(e.at, locale) : t('nfActNoTime')} · {t(`nfFinal_${e.finality}` as Key)}</span>{e.quantity !== '1' && e.quantity !== '0' && <span className="text-[12.5px] font-semibold">×{e.quantity}</span>}</div>
      {(e.from || e.to) && <p className="mt-1 break-all font-mono text-[11.5px] text-mute">{e.from ? shortId(e.from) : '?'} → {e.to ? shortId(e.to) : '?'}</p>}
      <p className="mt-0.5 break-all font-mono text-[11px] text-mute">{shortId(e.tx)}</p>
      {e.price && <p className="text-[12.5px]">{unitsToText(e.price.amount, e.price.currency.decimals)} {e.price.currency.symbol}</p>}</li>)}</ol>}
    <p className="mt-2 text-[12px] text-mute">{t('nfActNoSales')}</p>
    {d.canLoadOlder && <Btn kind="soft" className="mt-2" busy={older.isPending} onClick={() => older.mutate()}>{t('nfActOlder')}</Btn>}
  </div>;
}

/** The item page. */
export function NftDetail({ id, nav }: { id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useNftItem(id);
  const [sending, setSending] = useState(false);
  const refresh = useMutation({ mutationFn: () => post<NftItem>('/nfts/refresh-metadata', { key: id }), onSuccess: (a) => qc.setQueryData(['nft', 'item', id], a) });
  const track = useMutation({ mutationFn: async (on: boolean) => { const a = q.data!; if (on) await post('/nfts/manual', { chain: a.chainId, address: a.contractAddress ?? a.assetId, ...(a.tokenId ? { tokenId: a.tokenId } : {}) }); else await api('DELETE', `/nfts/manual?key=${encodeURIComponent(id)}`); }, onSettled: () => { void qc.invalidateQueries({ queryKey: ['nft'] }); } });
  const back = (title: ReactNode) => <PageTitle onBack={() => nav({ tab: 'nfts' })} backLabel={t('back')}>{title}</PageTitle>;
  if (q.isError) return <div className="space-y-4">{back(t('nfTitle'))}<ErrorState title={t('nfErrItem')} onRetry={() => void q.refetch()} offline={(q.error as ApiError)?.code === 'offline'}><span data-testid="nft-item-error">{tk(t, 'nfErr_', errCode(q.error), 'nfErrOther')}</span></ErrorState></div>;
  if (!q.data) return <div className="space-y-4" aria-busy="true">{back(t('loading'))}<Skeleton h="aspect-square" className="!rounded-2xl" /><Skeleton h="h-40" /></div>;
  const a = q.data, name = displayName(a), md = a.metadata, o = a.ownership;
  const main = a.media.find((m) => m.role === 'animation' && (m.kind === 'video' || m.kind === 'html' || m.kind === 'audio')) ?? a.media.find((m) => m.role === 'image') ?? a.media[0] ?? null;
  const link = safeLink(md.externalUrl), reasons = a.capabilities.transferBlockedBy;
  const mdStamp = md.source, idLabel = a.family === 'evm' ? t('nfContract') : t('nfMint');
  const verdict = a.transfer ?? { transferable: a.capabilities.transferable, blockedBy: a.capabilities.transferBlockedBy, warnings: a.capabilities.transferWarnings ?? [], standard: a.standard, route: null };
  if (sending && verdict.transferable) return <Suspense fallback={<Skeleton h="h-[420px]" />}><NftSend item={a} onClose={() => { setSending(false); void q.refetch(); }} /></Suspense>;
  return <div className="space-y-5" data-testid="nft-detail" data-key={a.key}>
    {back(name ?? <span className="font-mono text-[18px]">{shortId(a.assetId)}</span>)}
    {!o.heldByWallet && <Notice tone={o.state === 'burned' ? 'danger' : 'info'}><span data-testid="nft-not-in-wallet">{t(o.state === 'burned' ? 'nfBurnedNote' : a.origin === 'lookup' ? 'nfNotInWallet' : 'nfNotInWalletTracked')}</span></Notice>}
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6"><div className="space-y-2">
      <NftMediaView m={main} alt={name ?? a.assetId} fit="full" />
      {md.status !== 'ok' && <Notice tone="warn"><span data-testid="nft-metadata-status" data-status={md.status}>{tk(t, 'nfMeta_', md.status, 'nfMeta_unreachable')}{md.errorCode ? <> (<code className="font-mono text-[11.5px]">{md.errorCode}</code>)</> : null}</span></Notice>}
      {a.media.length > 1 && <ul className="flex gap-2 overflow-x-auto">{a.media.filter((m) => m !== main).map((m) => <li key={m.id} className="h-16 w-16 shrink-0 overflow-hidden rounded-xl"><NftMediaView m={m} alt={`${name ?? a.assetId} — ${m.role}`} fit="tile" /></li>)}</ul>}
    </div>
    <div className="mt-4 space-y-4 lg:mt-0">
      <Card>
        <div className="flex flex-wrap items-center gap-2"><NetworkIcon net={a.chainId} size={20} /><span className="text-[13.5px] font-medium">{t(STANDARD_KEY[a.standard] ?? 'nfStd_unknown')}</span><StateTag state={o.state} />{a.quantity !== '1' && <Tag testid="nft-quantity">{t('nfQuantity', { n: a.quantity })}</Tag>}</div>
        {name ? <h2 className="mt-3 break-words text-[20px] font-semibold leading-tight" data-testid="nft-name">{name}</h2> : <p className="mt-3 text-[14px] text-mute" data-testid="nft-name-missing">{t('nfNameUnavailable')}</p>}
        <p className="mt-1 text-[12px] text-mute">{md.name ? t('nfProvCreator') : md.onchainName ? t('nfProvOnchain') : ''}</p>
        {a.collection ? <button className="mt-2 block text-left text-[14px] font-medium text-blue" onClick={() => nav({ tab: 'nftc', asset: a.collection!.key })} data-testid="nft-collection-link">{a.collection.name ?? shortId(a.collection.id)}</button> : <p className="mt-2 text-[13.5px] text-mute">{t('nfNoCollection')}</p>}
        {a.collection && <p className="mt-1" data-testid="nft-collection-verified" data-state={a.collection.verifiedOnChain.state === 'known' ? String(a.collection.verifiedOnChain.value) : a.collection.verifiedOnChain.state}>
          {a.collection.verifiedOnChain.state === 'known' ? <Tag tone={a.collection.verifiedOnChain.value ? 'ok' : 'warn'} icon={a.collection.verifiedOnChain.value ? 'check' : 'warn'}>{t(a.collection.verifiedOnChain.value ? 'nfCollVerifiedOnchain' : 'nfCollUnverifiedOnchain')}</Tag>
            : <Tag tone="mute" icon="minus">{t(a.collection.verifiedOnChain.state === 'unsupported' ? 'nfCollNoOnchainNotion' : 'nfCollNotVerified')}</Tag>}</p>}
        <dl className="mt-3"><Fact k={idLabel}><CopyId value={a.contractAddress ?? a.assetId} label={idLabel} /></Fact>
          {a.tokenId !== null && <Fact k={t('nfTokenId')}><CopyId value={a.tokenId} label={t('nfTokenId')} /></Fact>}</dl>
      </Card>
      <Card><h3 className="mb-2 text-[15px] font-semibold">{t('nfActions')}</h3>
        <div className="grid grid-cols-2 gap-2.5">
          <CopyBtn text={a.tokenId !== null ? `${a.contractAddress}/${a.tokenId}` : a.assetId} />
          {a.explorerUrl && safeLink(a.explorerUrl) ? <a href={a.explorerUrl} target="_blank" rel="noreferrer noopener" className="press inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl border border-line px-4 text-[15px] font-medium" data-testid="nft-explorer"><Icon n="ext" className="h-4 w-4" />{t('explorer')}</a> : <span />}
          <Btn kind="soft" onClick={() => nav({ tab: 'nfts', view: 'receive' })}><Icon n="down" className="h-4 w-4" />{t('receive')}</Btn>
          <Btn kind="soft" busy={refresh.isPending} onClick={() => refresh.mutate()} data-testid="nft-refresh"><Icon n="refresh" className="h-4 w-4" />{t('nfRefresh')}</Btn>
        </div>
        {refresh.isError && <p className="mt-2 text-[12.5px] text-warn" data-testid="nft-refresh-error">{tk(t, 'nfErr_', errCode(refresh.error), 'nfErrOther')}</p>}
        <p className="mt-2 text-[12px] text-mute">{t('nfRefreshNote')}</p>
        {(a.origin !== 'discovered') && <Btn kind="ghost" full className="mt-2" busy={track.isPending} onClick={() => track.mutate(a.origin !== 'manual')} data-testid="nft-track">{t(a.origin === 'manual' ? 'nfUntrack' : 'nfTrack')}</Btn>}
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          {/* delivery 2: a transferable asset opens the Send flow; a blocked one shows its exact reasons instead of a dead button */}
          {verdict.transferable
            ? <><Btn full onClick={() => setSending(true)} data-testid="nft-send" data-transferable="true"><Icon n="up" className="h-4 w-4" />{t('nfSend')}</Btn>
              <p className="text-[12.5px] text-mute" data-testid="nft-send-route">{t('nfTRoute')} <span className="font-mono text-[11.5px]">{verdict.route}</span></p></>
            : <><Btn full disabled aria-describedby="nft-send-why" data-testid="nft-send" data-transferable="false"><Icon n="up" className="h-4 w-4" />{t('nfSend')}</Btn>
              <ul id="nft-send-why" className="space-y-1 text-[12.5px] text-warn" data-testid="nft-send-why">{verdict.blockedBy.map((r) => <li key={r} data-reason={r}>· {tk(t, 'nfWhy_', r, 'nfWhyOther')}</li>)}</ul></>}
          <Btn full disabled kind="soft" aria-describedby="nft-market-why" data-testid="nft-market-actions">{t('nfMarketActions')}</Btn>
          <p id="nft-market-why" className="text-[12.5px] text-mute" data-testid="nft-market-why">{t('nfMarketWhy')}</p>
        </div>
      </Card>
    </div></div>

    {md.description && <Section title={t('nfDescription')} right={mdStamp ? <Provenance s={mdStamp} /> : undefined}><Card><p className="whitespace-pre-line break-words text-[14px] leading-relaxed" data-testid="nft-description">{md.description}</p>
      {link && <p className="mt-3 text-[13.5px]"><a href={link.href} target="_blank" rel="noreferrer noopener nofollow" className="inline-flex items-center gap-1.5 font-medium text-blue" data-testid="nft-external-link"><Icon n="ext" className="h-3.5 w-3.5" />{link.host}</a> <span className="text-mute">— {t('nfExternalWarn')}</span></p>}</Card></Section>}
    {!md.description && link && <Card><a href={link.href} target="_blank" rel="noreferrer noopener nofollow" className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-blue" data-testid="nft-external-link"><Icon n="ext" className="h-3.5 w-3.5" />{link.host}</a> <span className="text-[13px] text-mute">— {t('nfExternalWarn')}</span></Card>}

    <Section title={`${t('nfTraits')} · ${md.attributes.length}`} right={mdStamp && md.attributes.length > 0 ? <Provenance s={mdStamp} /> : undefined}><Card>
      {md.attributes.length === 0 ? <p className="text-[13.5px] text-mute" data-testid="nft-traits-none">{t(md.status === 'ok' ? 'nfTraitsNone' : 'nfTraitsUnavailable')}</p>
        : <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="nft-traits">{md.attributes.map((x, k) => <li key={k} className="rounded-xl bg-elev/70 px-3.5 py-2.5" data-malformed={x.malformed}>
          <span className="block break-words text-[11.5px] font-medium uppercase tracking-wide text-mute">{x.traitType ?? t('nfTraitNoType')}{x.displayType ? ` · ${x.displayType}` : ''}</span>
          <span className="block break-words text-[14px] font-semibold">{x.valueText || <span className="font-normal text-mute">{t('nfTraitNoValue')}</span>}{x.maxValue ? <span className="font-normal text-mute"> / {x.maxValue}</span> : null}</span>
          {x.malformed && <span className="mt-0.5 block text-[11.5px] text-warn">{t('nfTraitMalformed')}</span>}</li>)}</ul>}
      <p className="mt-3 text-[12.5px] text-mute" data-testid="nft-rarity">{t('nfRarityNotComputed')} {tk(t, 'nfRarityWhy_', md.traitStatistics.reason, 'nfRarityWhy_no_collection_index')}</p></Card></Section>

    <Section title={t('nfOwnership')} right={<Provenance s={o.source} />}><Card><dl>
      <Fact k={t('nfOwner')}><KnownText k={o.owner} t={t} render={(v) => <CopyId value={v} label={t('nfOwner')} />} /></Fact>
      <Fact k={t('nfInThisWallet')}><span data-testid="nft-held">{t(o.heldByWallet ? 'nfYes' : 'nfNo')}</span></Fact>
      <Fact k={t('nfQuantityHeld')}>{a.quantity}</Fact>
      <Fact k={t('nfSupply')}><KnownText k={a.supply} t={t} render={(v) => <>{v}</>} /></Fact>
      {o.tokenAccount.state !== 'unsupported' && <Fact k={t('nfTokenAccount')}><KnownText k={o.tokenAccount} t={t} render={(v) => <CopyId value={v} label={t('nfTokenAccount')} />} /></Fact>}
      {o.frozen.state !== 'unsupported' && <Fact k={t('nfFrozen')}><KnownText k={o.frozen} t={t} render={(v) => <>{t(v ? 'nfYes' : 'nfNo')}</>} /></Fact>}
      {o.delegate.state !== 'unsupported' && <Fact k={t('nfDelegate')}><KnownText k={o.delegate} t={t} render={(v) => <CopyId value={v} label={t('nfDelegate')} />} /></Fact>}
      {o.tokenRecordState.state !== 'unsupported' && <Fact k={t('nfTokenRecord')}><KnownText k={o.tokenRecordState} t={t} render={(v) => <>{tk(t, 'nfRecord_', v, 'nfUnknown')}</>} /></Fact>}
      {a.verifiedAt && <Fact k={t('nfVerifiedAt')}>{when(a.verifiedAt, locale)}</Fact>}</dl></Card></Section>

    <Section title={t('nfMarket')} right={a.market ? <Provenance s={a.market.source} /> : undefined}><Card>
      {a.market ? <dl data-testid="nft-market"><Fact k={t('nfListed')}><KnownText k={a.market.listed} t={t} render={(v) => <>{t(v ? 'nfYes' : 'nfNo')}</>} /></Fact>
        <Fact k={t('nfAsking')}><Price p={a.market.listingPrice} t={t} /></Fact>
        <Fact k={t('nfSeller')}><KnownText k={a.market.seller} t={t} render={(v) => <CopyId value={v} label={t('nfSeller')} />} /></Fact>
        <Fact k={t('nfBestOffer')}><Price p={a.market.bestOffer} t={t} /></Fact>
        <Fact k={t('nfFloor')}><Price p={a.market.collectionFloor} t={t} /></Fact></dl>
        : <p className="text-[13.5px] text-mute" data-testid="nft-market-none">{t('nfMarketNone')}</p>}
      {a.market && <p className="mt-2 text-[12px] text-mute">{t('nfFloorNote')} {t('nfMarketAttribution')}</p>}
      <p className="mt-3 text-[12.5px] font-medium">{t('nfValueItem')}</p>
      {a.externalMarkets.length > 0 && <div className="mt-3 border-t border-line pt-3"><p className="mb-2 text-[12.5px] text-mute" data-testid="nft-outside-warning">{t('nfOutsideWarn')}</p>
        <div className="flex flex-wrap gap-2">{a.externalMarkets.map((m) => { const l = safeLink(m.url); return l ? <a key={m.name} href={l.href} target="_blank" rel="noreferrer noopener" className="press inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line px-3.5 text-[13.5px] font-medium" data-testid="nft-market-link"><Icon n="ext" className="h-3.5 w-3.5" />{m.name} <span className="font-normal text-mute">({l.host})</span></a> : null; })}</div></div>}</Card></Section>

    <Section title={t('nfChainDetails')}><Card><dl>
      <Fact k={t('network')}>{a.chainId}</Fact><Fact k={t('nfStandard')}>{t(STANDARD_KEY[a.standard] ?? 'nfStd_unknown')}</Fact>
      <Fact k={t('nfKey')}><CopyId value={a.key} label={t('nfKey')} /></Fact>
      {a.tokenProgram && <Fact k={t('nfProgram')}><CopyId value={a.tokenProgram} label={t('nfProgram')} /></Fact>}
      {a.updateAuthority.state !== 'unsupported' && <Fact k={t('nfUpdateAuthority')}><KnownText k={a.updateAuthority} t={t} render={(v) => <CopyId value={v} label={t('nfUpdateAuthority')} />} /></Fact>}
      <Fact k={t('nfMutable')}><KnownText k={md.mutable} t={t} render={(v) => <>{t(v ? 'nfMutableYes' : 'nfMutableNo')}</>} /></Fact>
      {a.creators.state === 'known' && <Fact k={t('nfCreators')}><ul className="space-y-1">{a.creators.value.map((c) => <li key={c.address} className="text-right"><span className="break-all font-mono text-[12px]">{shortId(c.address)}</span> · {c.share} % · <span className={c.verified ? 'text-emerald' : 'text-mute'}>{t(c.verified ? 'nfCreatorVerified' : 'nfCreatorUnverified')}</span></li>)}</ul></Fact>}
      {a.royaltyBps.state === 'known' && <Fact k={t('nfRoyalty')}>{(a.royaltyBps.value / 100).toFixed(2)} %</Fact>}
      {a.ruleSet.state !== 'unsupported' && <Fact k={t('nfRuleSet')}><KnownText k={a.ruleSet} t={t} render={(v) => <CopyId value={v} label={t('nfRuleSet')} />} /></Fact>}
      {a.extensions.length > 0 && <Fact k={t('nfFeatures')}><span className="break-words font-mono text-[12px]" data-testid="nft-features">{a.extensions.join(', ')}</span></Fact>}
      <Fact k={t('nfMetadataUri')}>{md.sourceUri ? <CopyId value={md.sourceUri.length > 300 ? `${md.sourceUri.slice(0, 120)}…` : md.sourceUri} label={t('nfMetadataUri')} /> : <span className="text-mute">{t('nfNone')}</span>}</Fact>
      {md.resolvedUri && md.resolvedUri !== md.sourceUri && <Fact k={t('nfResolvedUri')}><span className="break-all font-mono text-[12px]">{md.resolvedUri}</span></Fact>}
      {md.contentHash && <Fact k={t('nfContentHash')}><span className="break-all font-mono text-[11.5px]">{md.contentHash}</span></Fact>}</dl></Card></Section>

    <Section title={t('nfActivity')}><Card><Activity id={id} /></Card></Section>

    <Section title={t('nfSources')}><Card><ul className="space-y-2.5" data-testid="nft-sources">{a.sources.map((s, k) => <li key={k} className="text-[13px]"><Provenance s={s} />
      <span className="mt-1 block text-mute">{SOURCE_NAME[s.source] ?? s.source} · {s.detail} · {when(s.fetchedAt, locale)}{s.blockRef?.slot ? ` · slot ${s.blockRef.slot}` : s.blockRef?.number ? ` · ${t('block')} ${s.blockRef.number}` : ''} · {tk(t, 'nfConf_', s.confidence, 'nfConfOther')}</span></li>)}</ul>
      <p className="mt-3 text-[12px] text-mute">{t('nfSourcesNote')}</p></Card></Section>
  </div>;
}
