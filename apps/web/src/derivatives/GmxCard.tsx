/**
 * The GMX « account » (v8). GMX has no venue account: the account IS the wallet's own Arbitrum address — its USDC and ETH,
 * the wallet's limits, its positions and pending orders read from the chain. The card says, lock by lock, why trading is or
 * is not possible: the two server settings (named, and not changeable from the app), the venue policy approved with the
 * passkey, the pinned contracts, the signer, the chain. When everything is open it carries the same real-money band as a
 * mainnet venue account. `GmxLocked` is the short form shown in the terminal in place of the order panel.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Addr, Btn, Card, Icon, Notice } from '../ui';
import { Row, Stat, timeOf } from './bits';
import { fmt, usd } from './dec';
import { gapi, GMX_STATUS_KEY, gmxError, needsAuthorization, SETTING_OF, sortBlockers, type GmxBlocker, type GmxErr, type GmxStatus } from './gmx';
import { GmxActivity } from './GmxActivity';
import { GmxAuthorize } from './GmxAuthorize';
import { ChainTag, eth, GmxErrNotice, usdc } from './GmxBits';
import { ModeBand } from './LiveBits';

const SOFT: ReadonlySet<GmxBlocker> = new Set(['not_authorized', 'authorization_expired', 'authorization_revoked']);
/** every lock that is closed, explained: the server's sentence when it sent one, ours otherwise; a server setting is named */
export function GmxBlockers({ status }: { status: GmxStatus }) {
  const t = useT();
  return <ul className="space-y-2" data-testid="gmx-blockers">{sortBlockers(status.blockers).map((b) => { const setting = SETTING_OF[b];
    return <li key={b}><Notice tone={SOFT.has(b) ? 'info' : 'warn'}><div data-testid="gmx-blocker" data-code={b}>
      <b className="block font-semibold">{t(`gxBT_${b}` as Key)}</b>{status.blockerText[b] || t(`gxB_${b}` as Key)}
      {setting && <span className="mt-1.5 block text-[12.5px]" data-testid="gmx-setting-note">{t('gxSettingNote')} <code className="break-all rounded bg-elev px-1 py-px font-mono text-[11.5px]">{setting}</code></span>}
      {b === 'contracts_changed' && status.pins.problems.length > 0 && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{status.pins.problems.join(' · ')}</span>}
      {b === 'wallet_unreadable' && status.walletError && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{status.walletError}</span>}
      {b === 'chain_unreadable' && status.positionsError && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{status.positionsError}</span>}
    </div></Notice></li>; })}</ul>;
}

/** in the terminal, where the order panel would be: trading is closed, and why */
export function GmxLocked({ status, goAccounts }: { status: GmxStatus; goAccounts: () => void }) {
  const t = useT();
  return <div className="space-y-3" data-testid="gmx-locked">
    <div><h3 className="text-[15px] font-semibold">{t('gxLockedTitle')}</h3><p className="mt-0.5 text-[12.5px] leading-snug text-mute">{t('gxLockedIntro')}</p></div>
    <GmxBlockers status={status} />
    <Btn full kind="soft" onClick={goAccounts} data-testid="gmx-go-account">{t(needsAuthorization(status) ? 'gxGoAuthorize' : 'gxGoAccount')}</Btn>
  </div>;
}

export function GmxCard({ status, onOpen }: { status: GmxStatus; /** open a market in the terminal */ onOpen: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [sheet, setSheet] = useState(false), [confirmRevoke, setConfirmRevoke] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState<{ e: GmxErr; raw: unknown } | null>(null);
  const s = status, a = s.authorization, w = s.wallet, onOff = (v: boolean) => <span className={v ? 'font-semibold text-emerald' : 'font-semibold text-mute'}>{t(v ? 'gxOn' : 'gxOff')}</span>;
  const revoke = async () => {
    setBusy(true); setErr(null);
    try { qc.setQueryData([...GMX_STATUS_KEY, locale], await gapi.revoke()); setConfirmRevoke(false); } catch (e) { setErr({ e: gmxError(e), raw: e }); }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: GMX_STATUS_KEY }); }
  };
  const name = (m: string) => s.markets.find((x) => x.market.toLowerCase() === m.toLowerCase())?.name ?? m;
  return <Card><div className="min-w-0 space-y-3.5" data-testid="gmx-card" data-tradable={s.tradable ? '1' : '0'}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[17px] font-semibold tracking-tight">{t('gxCardTitle')}</h2>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${s.tradable ? 'bg-danger/10 text-danger' : 'bg-elev text-mute'}`} data-testid="gmx-card-state"><Icon n={s.tradable ? 'warn' : 'lock'} className="h-3 w-3" />{t(s.tradable ? 'gxStateTradable' : 'gxStateLocked')}</span></div>
    {s.tradable && <div><ModeBand tone="mainnet" label="GMX v2 · Arbitrum" compact /><p className="mt-1.5 text-[12.5px] leading-snug">{t('gxBandReal')}</p></div>}

    <div className="rounded-2xl bg-elev/70 p-3" data-testid="gmx-account">
      <div className="text-[13px] font-semibold">{t('gxAccountIsWallet')}</div><p className="mt-0.5 text-[12px] leading-snug text-mute">{t('gxAccountNote')}</p>
      {s.account ? <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1"><Addr value={s.account.address} />
        <a href={s.account.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-9 items-center gap-1 text-[12.5px] font-medium text-blue">{t('gxSeeAddress')}<Icon n="chev" className="h-3.5 w-3.5" /></a></div> : <p className="mt-1 text-[13px] text-mute">—</p>}
      {w ? <><dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" data-testid="gmx-wallet">
        <Stat label={t('gxWalletUsdc')} wrap>{usdc(w.usdc, locale)}</Stat><Stat label={t('gxWalletEth')} wrap>{eth(w.eth, locale)}</Stat>
        <Stat label={t('gxLimitTx')} wrap>{usdc(w.limits.perTransfer, locale)}</Stat><Stat label={t('gxLimitDay')} wrap>{usdc(w.limits.perDay, locale)}</Stat></dl>
        <p className="mt-1.5 text-[12px] leading-snug text-mute">{t('gxLimitsNote', { spent: fmt(w.limits.spentToday, { locale, dp: 2 }), max: fmt(w.limits.maxNow, { locale, dp: 2 }), fee: fmt(w.feeCeilingEth, { locale, dp: 6, trim: true }) })}</p></>
        : <p className="mt-2 text-[12.5px] leading-snug text-warn" data-testid="gmx-wallet-error">{t('gxWalletUnread')}{s.walletError ? <span className="block break-words font-mono text-[11px]">{s.walletError}</span> : null}</p>}
    </div>

    {s.blockers.length > 0 && <GmxBlockers status={s} />}

    <div className="rounded-2xl border border-line p-3" data-testid="gmx-locks">
      <div className="mb-1 text-[12.5px] font-semibold">{t('gxLocksTitle')}</div>
      <Row label={<code className="font-mono text-[11.5px]">SPW_DERIV_LIVE_MAINNET</code>}><span data-testid="gmx-setting-mainnet">{onOff(s.settings.liveMainnet)}</span></Row>
      <Row label={<code className="font-mono text-[11.5px]">SPW_DERIV_GMX_LIVE</code>}><span data-testid="gmx-setting-gmx">{onOff(s.settings.gmxLive)}</span></Row>
      <Row label={t('gxLockAuth')}><span data-testid="gmx-auth-state" data-state={a?.state ?? 'none'}>{a ? `${t(`gxAuth_${a.state}` as Key)}${a.state === 'active' ? ` · ${t('gxUntil', { date: timeOf(a.expiresAt * 1000, locale, true) })}` : ''}` : t('gxAuth_none')}</span></Row>
      <Row label={t('gxLockPins')}><span data-testid="gmx-pins" data-ok={String(s.pins.ok)} className={s.pins.ok === false ? 'font-semibold text-warn' : ''}>{t(s.pins.ok === true ? 'gxPinsOk' : s.pins.ok === false ? 'gxPinsChanged' : 'gxPinsUnchecked')}</span></Row>
      <p className="mt-1 text-[11.5px] leading-snug text-mute">{t('gxLocksNote')}</p>
      <details className="mt-1.5" data-testid="gmx-contracts"><summary className="flex min-h-9 cursor-pointer items-center text-[12.5px] font-medium text-blue">{t('gxPinsDetails', { id: s.pins.id, date: s.pins.reviewedAt })}</summary>
        <ul className="mt-1 space-y-1">{s.pins.contracts.map((c) => <li key={c.name} className="text-[12px]"><span className="font-medium">{c.name}</span> <a href={c.explorer} target="_blank" rel="noreferrer noopener" className="break-all font-mono text-[11px] text-blue">{c.address}</a></li>)}</ul></details>
    </div>

    {a && <div className="rounded-2xl border border-line p-3" data-testid="gmx-policy">
      <div className="mb-1 text-[12.5px] font-semibold">{t('gxPolicyTitle')}</div>
      <Row label={t('gxAuthMarkets')}><span className="block">{a.policy.allowedMarkets.map((m) => <span key={m} className="block">{name(m)}</span>)}</span></Row>
      <Row label={t('gxAuthLeverage')}>{a.policy.maxLeverage}×</Row><Row label={t('gxAuthOrder')}>{usd(a.policy.maxOrderSizeUsd, locale)}</Row>
      <Row label={t('gxAuthPerDay')}>{a.policy.maxOrdersPerDay} · {t('gxToday', { inc: a.today.increases, red: a.today.reduces })}</Row>
      <Row label={t('gxAuthBand')}>{a.policy.maxPriceDeviationBps} {t('gxBps')}</Row></div>}

    {err && <GmxErrNotice err={err.e} raw={err.raw} />}
    <div className="flex flex-wrap gap-2">
      {needsAuthorization(s) && <Btn onClick={() => setSheet(true)} data-testid="gmx-authorize-open"><Icon n="key" className="h-4 w-4" />{t(a ? 'gxAuthorizeAgain' : 'gxAuthorize')}</Btn>}
      {s.tradable && s.markets.filter((m) => m.allowed).map((m) => <Btn key={m.market} kind="soft" onClick={() => onOpen(m.instrument)} data-testid={`gmx-trade-${m.base}`}>{t('gxTrade', { market: `${m.base}/USD` })}</Btn>)}
      {a?.state === 'active' && (confirmRevoke
        ? <><Btn kind="danger" busy={busy} onClick={() => void revoke()} data-testid="gmx-revoke-confirm">{t('gxRevokeConfirm')}</Btn><Btn kind="ghost" disabled={busy} onClick={() => setConfirmRevoke(false)}>{t('cancel')}</Btn></>
        : <Btn kind="ghost" onClick={() => setConfirmRevoke(true)} data-testid="gmx-revoke">{t('gxRevoke')}</Btn>)}
    </div>
    {confirmRevoke && <p className="text-[12.5px] leading-snug text-mute">{t('gxRevokeNote')}</p>}

    <div className="border-t border-line pt-3"><div className="mb-2 flex items-center gap-2 text-[12px] text-mute"><ChainTag />{t('gxChainCount', { positions: s.positions.length, orders: s.pendingOrders.length })}</div>
      <GmxActivity status={s} onSelect={onOpen} /></div>
    {sheet && <GmxAuthorize status={s} onClose={() => setSheet(false)} />}
  </div></Card>;
}
