/**
 * « Négociation réelle » of the Accounts view: the venue accounts (one per network), their state as the venue reports it, the
 * dedicated trading key, how to fund the account (explained here; « Déposer » / « Retirer » live in LiveCollateral.tsx),
 * the authorization flow (limits → review: jurisdiction text, what is signed, key and expiry, limits → passkey) and revocation.
 * Mainnet is shown, and blocked with the reason, while the server setting keeps it off: that setting is the owner's, on the
 * server — there is no switch for it here.
 *
 * v10: same content, restyled to the design system — the venue's logo on each account, figures as stat tiles, the limits as a
 * receipt, the review in four numbered groups (the jurisdiction text verbatim, its checkbox, what is signed, the key, the
 * limits), one unmistakable approval button. Nothing is folded, nothing is animated, nothing was removed.
 */
import { AgentOnAccount } from './LiveAgentNote';   // v7 perp live
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Addr, Btn, Card, H, Icon, Notice, Skeleton, SkeletonStats, Stat, StatGrid, Tag, VenueIcon, when } from '../ui';
import { venueShown } from '../venues';
import { ServerSays, timeOf } from './bits';
import { usd } from './dec';
import { AuthorizeSheet, FundingBox, PLATE, PolicyRows } from './LiveAuthorize';
import { Bullet, Group, LiveErrNotice, LiveSheet, ModeBand, ModeTag, SourceTag, TICKET, WORDS } from './LiveBits';
import { lapi, liveError, toneOf, type LiveConfig, type LiveErr, type LiveNetwork, type LiveSummary, type Revoked } from './live';
export { FundingBox } from './LiveAuthorize';   // moved with the authorization sheet; still offered from here
import { CollateralPanel } from './LiveCollateral';
import { HaltBanner } from './LiveOrderPanel';
import { liveKey, refreshLive } from './liveStore';

const NETWORKS: LiveNetwork[] = ['testnet', 'mainnet'];

function RevokeSheet({ account, onClose }: { account: LiveSummary; onClose: () => void }) {
  const t = useT(); const qc = useQueryClient(); const { locale } = useContext(I18n);
  // how many orders rest on the venue right now (the venue's own list); unknown stays unknown
  const d = useQuery({ queryKey: liveKey(account.id), queryFn: () => lapi.account(account.id), retry: 0 });
  const openOrders = d.data && !d.data.venueState.error ? d.data.venueState.openOrders.length : null;
  const [cancelFirst, setCancelFirst] = useState(true), [busy, setBusy] = useState(false), [err, setErr] = useState<LiveErr | null>(null), [done, setDone] = useState<Revoked | null>(null);
  const lock = useRef(false);
  const revoke = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setErr(null);
    try { setDone(await lapi.revoke(account.id, cancelFirst, locale)); } catch (e) { setErr(liveError(e)); } finally { lock.current = false; setBusy(false); void refreshLive(qc, account.id); }
  };
  return <LiveSheet title={t('flRevokeTitle')} tone={toneOf(account)} label={account.label} busy={busy} onClose={onClose}><div className="min-w-0 space-y-4" data-testid="revoke-sheet">
    <ModeBand tone={toneOf(account)} label={account.label} />
    {!done && <>
      <Notice tone="warn">{t('flRevokeBody')}</Notice>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-line p-3.5 text-[0.875rem] leading-snug"><input type="checkbox" checked={cancelFirst} onChange={(e) => setCancelFirst(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]" data-testid="revoke-cancel-first" />
        <span className="min-w-0 font-medium">{t('flRevokeCancelFirst')}{openOrders !== null && <span className="mt-0.5 block text-[0.78125rem] font-normal text-mute">{t('flRevokeOpenNow', { n: openOrders })}</span>}</span></label>
      {!cancelFirst && (openOrders ?? 0) > 0 && <Notice tone="danger">{t('flRevokeLeaves', { n: openOrders ?? 0 })}</Notice>}
      {err && <LiveErrNotice err={err} />}
      <div className="space-y-2.5"><Btn full kind="danger" busy={busy} onClick={() => void revoke()}><Icon n="stop" className="h-4 w-4" />{t('flRevokeConfirm')}</Btn>
        <Btn full kind="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Btn></div></>}
    {done && <div className="space-y-3" data-testid="revoke-done">
      <Notice tone="ok">{t('flRevoked')}</Notice>
      {done.cancelled && <p className="text-[0.84375rem] leading-snug">{t('flCancelAllDone', { requested: done.cancelled.requested, accepted: done.cancelled.accepted, remaining: done.cancelled.remaining === null ? '?' : done.cancelled.remaining.length })}</p>}
      {done.warning && <Notice tone="danger"><div data-testid="revoke-warning"><b className="font-semibold">{t('flRevokeWarnTitle')}</b> {t('flRevokeWarn')}<span className={`mt-1.5 ${WORDS}`}>{done.warning}</span></div></Notice>}
      <p className="text-[0.78125rem] leading-snug text-mute">{t('flRevokeAgent')}<span className="mt-0.5 block break-words font-mono text-[0.6875rem]">{done.venueAgent}</span></p>
      <Btn full kind="soft" onClick={onClose}>{t('fxClose')}</Btn></div>}
  </div></LiveSheet>;
}

function LiveAccountCard({ a, config, selected, onSelect }: { a: LiveSummary; config: LiveConfig; selected: boolean; onSelect: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const tone = toneOf(a), off = a.network === 'mainnet' && !a.mainnetEnabled, auth = a.authorization, live = a.mode === 'MANUAL_LIVE';
  const col = useQuery({ queryKey: ['deriv', 'live', 'collateral', a.id, locale], queryFn: () => lapi.collateral(a.id, locale), refetchInterval: 30_000, retry: 0 });
  const [sheet, setSheet] = useState<'authorize' | 'change' | 'revoke' | null>(null);
  const pinnedN = config.pinnedAssets[a.network].length;
  const c = col.data;
  return <li className={`min-w-0 rounded-[22px] border p-4 ${selected ? 'border-ink shadow-e1' : 'border-line'}`} data-testid={`live-account-${a.network}`} data-mode={a.mode}>
    <ModeBand tone={tone} className="mb-4" />
    <div className="flex items-center gap-3"><VenueIcon venue="hyperliquid" size={40} />
      <div className="min-w-0 flex-1"><div className="text-[1.03125rem] font-semibold leading-tight tracking-[-0.015em]">{a.label}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><Tag tone={live && !auth?.expired ? 'ok' : 'mute'} icon={live ? 'key' : 'lock'} testid="live-mode">{t(live ? (auth?.expired ? 'flModeExpired' : 'flModeLive') : 'flModeReadOnly')}</Tag>
          {selected && <Tag tone="info" icon="check">{t('fxSelected')}</Tag>}</div></div></div>

    {off && <div className="mt-4"><Notice tone="warn"><div data-testid="mainnet-off"><b className="font-semibold">{t('flMainnetOffTitle')}</b> {t('flMainnetOff')}</div></Notice></div>}
    <div className="mt-4" data-testid="venue-state">
      {col.isLoading ? <SkeletonStats n={4} /> : !c || c.error || col.isError ? <Notice tone="danger">{t('flUnreadable')} <span className="break-words font-mono text-[0.71875rem] text-mute">{c?.error ?? (col.error ? liveError(col.error).detail || liveError(col.error).code : '')}</span></Notice> : <>
        <StatGrid cols={4}><Stat label={t('fxEquity')} value={usd(c.equity, locale)} /><Stat label={t('fxCollateral')} value={usd(c.collateral, locale)} /><Stat label={t('fxFreeCollateral')} value={usd(c.freeCollateral, locale)} /><Stat label={t('fxWithdrawable')} value={usd(c.withdrawable, locale)} /></StatGrid>
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.75rem] text-mute"><SourceTag />{t('flReadAt', { time: timeOf(c.ts, locale) })} · {c.asset}</p></>}
    </div>
    {a.halted && <div className="mt-4"><HaltBanner account={a} /></div>}
    {/* v7 perp live: an account an agent trades says so */}
    {a.mandate && a.mandate.phase !== 'ended' && <div className="mt-4"><AgentOnAccount account={a} /></div>}

    <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div className={PLATE}><div className="t-eyebrow mb-1.5">{t('flAccountAddr')}</div><Addr value={a.account} /><p className="mt-1.5 text-[0.75rem] leading-snug text-mute">{t('flAccountAddrNote')}</p></div>
      <div className={PLATE} data-testid="trading-key"><div className="t-eyebrow mb-1.5 flex items-center gap-1.5"><Icon n="key" className="h-3.5 w-3.5" />{t('flTradingKey')}</div><Addr value={a.agentAddress} />
        <p className="mt-1.5 text-[0.75rem] leading-snug text-mute">{t('flTradingKeyNote')}</p></div>
    </div>

    {live && auth && <div className="mt-4" data-testid="live-authorization"><Group title={t('flAuthActive')}>
      <div className={TICKET}><PolicyRows p={auth.policy} total={pinnedN} fold expires={when(new Date(auth.expiresAt), locale)} /></div>
      <p className="mt-2 text-[0.75rem] leading-snug text-mute">{t('flLimitsWho')}</p>
      {/* one guided way to change the assets: the sheet revokes this authorization, then grants the new one (one passkey prompt) */}
      {!auth.expired && !off && <div className="mt-3"><Btn kind="soft" full onClick={() => setSheet('change')} data-testid="change-assets"><Icon n="refresh" className="h-4 w-4" />{t('hl1ChgOpen')}</Btn>
        <p className="mt-1.5 text-[0.78125rem] leading-snug text-mute">{t(auth.policy.allowedInstruments.length >= pinnedN ? 'hl1ChgOpenAll' : 'hl1ChgOpenSome', { n: auth.policy.allowedInstruments.length, total: pinnedN })}</p></div>}</Group></div>}
    {!live && auth?.revokedAt && <p className="mt-4 text-[0.78125rem] text-mute">{t('flRevokedAt', { date: when(new Date(auth.revokedAt), locale) })}</p>}

    <div className="mt-4"><FundingBox network={a.network} collateral={c} /></div>
    <div className="mt-4"><CollateralPanel account={a} /></div>

    <div className="mt-4 flex flex-wrap gap-2.5">
      {!selected && <Btn kind="soft" onClick={() => onSelect(a.id)}>{t('fxUse')}</Btn>}
      {!live && <Btn disabled={off} onClick={() => setSheet('authorize')} data-testid="authorize"><Icon n="key" className="h-4 w-4" />{t('flAuthorize')}</Btn>}
      {(live || a.pendingAuthorization) && <Btn kind="danger" onClick={() => setSheet('revoke')} data-testid="revoke"><Icon n="stop" className="h-4 w-4" />{t('flRevoke')}</Btn>}
    </div>
    {off && !live && <p className="mt-2.5 text-[0.78125rem] leading-snug text-mute">{t('flMainnetBlocked')}</p>}
    {sheet === 'authorize' && <AuthorizeSheet account={a} config={config} collateral={c} onClose={() => setSheet(null)} />}
    {sheet === 'change' && <AuthorizeSheet replace account={a} config={config} collateral={c} onClose={() => setSheet(null)} />}
    {sheet === 'revoke' && <RevokeSheet account={a} onClose={() => setSheet(null)} />}
  </li>;
}

export function LiveSection({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const t = useT(); const qc = useQueryClient();
  const { locale } = useContext(I18n);
  const config = useQuery({ queryKey: ['deriv', 'live', 'config', locale], queryFn: () => lapi.config(locale), staleTime: 10_000, refetchInterval: 30_000, retry: 0 });   // v7: the server's sentences in the screen's language
  const accounts = useQuery({ queryKey: ['deriv', 'live', 'accounts'], queryFn: lapi.accounts, refetchInterval: 15_000, retry: 0 });
  const [busy, setBusy] = useState(''), [err, setErr] = useState<LiveErr | null>(null);
  const lock = useRef(false);
  useEffect(() => { setErr(null); }, [accounts.data?.length]);
  const cfg = config.data, list = accounts.data ?? [];
  const anyLive = list.some((a) => a.mode === 'MANUAL_LIVE' && !a.authorization?.expired);
  const create = async (network: LiveNetwork) => {
    if (lock.current) return; lock.current = true; setBusy(network); setErr(null);
    try { const a = await lapi.create(network, t(network === 'testnet' ? 'flLabelTestnet' : 'flLabelMainnet')); await refreshLive(qc); onSelect(a.id); }
    catch (e) { setErr(liveError(e)); } finally { lock.current = false; setBusy(''); }
  };
  return <Card><div className="min-w-0" data-testid="live-card">
    <H right={<Tag tone={anyLive ? 'ok' : 'mute'} icon={anyLive ? 'key' : 'lock'} testid="live-status">{t(anyLive ? 'flLiveOn' : 'fxLiveOff')}</Tag>}><span className="inline-flex items-center gap-2.5"><VenueIcon venue="hyperliquid" size={26} />{t('fxLive')}</span></H>
    <p className="text-[0.875rem] leading-snug">{t('flIntro')}</p>
    <ul className="mt-3.5 space-y-2.5 text-[0.84375rem] leading-snug">{(['fxLiveReq1', 'flReq2', 'fxLiveReq3', 'fxLiveReq4'] as const).map((k) => <Bullet key={k} icon="key">{t(k)}</Bullet>)}</ul>
    {config.isError || accounts.isError ? <div className="mt-4"><LiveErrNotice err={liveError(config.error ?? accounts.error)} /></div> : !cfg || accounts.isLoading ? <div className="mt-4 space-y-3"><Skeleton h="h-40" /><Skeleton h="h-28" /></div> : <>
      {!cfg.mainnetEnabled && <div className="mt-4"><Notice tone="info"><div data-testid="mainnet-setting">{t('flMainnetSetting')}</div></Notice></div>}
      <ul className="mt-4 space-y-4">{NETWORKS.map((n) => { const a = list.find((x) => x.network === n);
        if (a) return <LiveAccountCard key={n} a={a} config={cfg} selected={a.id === selected} onSelect={onSelect} />;
        const off = n === 'mainnet' && !cfg.mainnetEnabled;
        return <li key={n} className="min-w-0 rounded-[22px] border border-dashed border-line p-4" data-testid={`live-create-${n}`}>
          <div className="flex items-center gap-3"><VenueIcon venue="hyperliquid" size={36} /><div className="min-w-0"><ModeTag tone={n === 'mainnet' ? 'mainnet' : 'testnet'} /><div className="mt-1 text-[0.96875rem] font-semibold leading-tight">{t(n === 'testnet' ? 'flCreateTestnetTitle' : 'flCreateMainnetTitle')}</div></div></div>
          <p className="mt-2.5 text-[0.84375rem] leading-snug text-mute">{t(n === 'testnet' ? 'flCreateTestnetBody' : 'flCreateMainnetBody')}</p>
          {off && <p className="mt-2 flex items-start gap-1.5 text-[0.78125rem] font-medium leading-snug text-warn" data-testid="mainnet-blocked"><Icon n="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0">{t('flMainnetBlocked')}</span></p>}
          <Btn className="mt-3.5" kind={n === 'testnet' ? 'primary' : 'soft'} busy={busy === n} disabled={off || !!busy} onClick={() => void create(n)}><Icon n="plus" className="h-4 w-4" />{t(n === 'testnet' ? 'flCreateTestnet' : 'flCreateMainnet')}</Btn></li>; })}</ul>
      {err && <div className="mt-4"><LiveErrNotice err={err} /></div>}
      {/* >>> v7 perp live: the V6 shape of GET /config — mandates exist; on mainnet they are closed by a SERVER SETTING, said with the server's own words */}
      <p className="mt-4 text-[0.78125rem] leading-snug text-mute" data-testid="mandate-mode-note">{cfg.mandateLive.available ? t('plMandateModeNote') : t('flMandateNote')}{venueShown('dydx') ? ` ${t('fxLiveNote')}` : ''}</p>
      {!cfg.mandateLive.available && cfg.mandateLive.reason && <ServerSays mono text={cfg.mandateLive.reason} className="mt-1 break-words text-[0.71875rem] text-mute" />}
      {cfg.mandateLive.available && cfg.mandateLive.mainnet && !cfg.mandateLive.mainnet.enabled && <div className="mt-3 rounded-[18px] border border-dashed border-line bg-elev/60 p-3.5 text-[0.8125rem] leading-snug" data-testid="mandate-mainnet-setting">
        <b className="flex items-start gap-1.5 font-semibold"><Icon n="lock" className="mt-0.5 h-4 w-4 shrink-0" />{t('plLockTitle')}</b><span className="mt-1 block text-mute">{t('plLockBody')}</span>
        <span className="mt-1.5 block break-words font-mono text-[0.6875rem] text-mute">{t('plLockSays')} {cfg.mandateLive.mainnet.reason ?? cfg.reasons?.mandate_mainnet_disabled?.[locale]}</span></div>}
      {/* <<< v7 perp live */}
    </>}</div>
  </Card>;
}
