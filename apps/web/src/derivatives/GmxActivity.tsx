/**
 * What the wallet has on GMX (v8), all of it read from the chain by the server: the positions (with the cross-check against
 * GMX's own API), the orders stored on-chain now, and the engine's operations with their honest states. « Fermer » and
 * « Annuler l'ordre » only open the confirm sheet (GmxConfirm.tsx): nothing leaves without the passkey.
 */
import { useContext, useState } from 'react';
import { I18n, useT } from '../i18n';
import { Btn, Icon, Notice } from '../ui';
import { Pnl, Seg, SideTag, Stat, timeOf } from './bits';
import { type GmxOperation, type GmxPosition, type GmxStatus } from './gmx';
import { ChainTag, GmxOpCard, lev, px, usdc, useLeft } from './GmxBits';
import { GmxConfirm, type GmxRequest } from './GmxConfirm';
import { clock } from './live';
import { usd } from './dec';

function PositionCard({ p, onClose, onSelect }: { p: GmxPosition; onClose?: () => void; onSelect?: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  return <li className="min-w-0 rounded-2xl border border-line p-3.5" data-testid="gmx-position" data-market={p.market} data-side={p.side}>
    <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <button type="button" className="min-w-0 truncate text-left text-[14px] font-semibold" onClick={() => onSelect?.(p.instrument)}>{p.marketName}</button><SideTag side={p.side} />
      <span className="text-[12.5px] font-semibold">{lev(p.leverage, locale)}</span><span className="ml-auto"><ChainTag /></span></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
      <Stat label={t('gxSize')} wrap>{usd(p.sizeUsd, locale)}</Stat>
      <Stat label={t('gxCollateral')} wrap>{usdc(p.collateral, locale)}</Stat>
      <Stat label={t('gxEntry')} wrap>{px(p.entryPrice, locale)}</Stat>
      <Stat label={t('gxMark')} wrap>{px(p.markPrice, locale)}</Stat>
      <Stat label={t('gxPnlEst')} wrap><Pnl value={p.pnlUsd} locale={locale} /></Stat>
      <Stat label={t('gxLiqEst')} wrap>{px(p.liquidationPrice, locale)}</Stat>
      <Stat label={t('gxSince')} wrap>{timeOf(p.increasedAt * 1000, locale, true)}</Stat>
    </dl>
    <p className={`mt-2 flex items-start gap-1.5 text-[12px] leading-snug ${p.venueApi.agrees === true ? 'text-mute' : 'text-warn'}`} data-testid="gmx-crosscheck" data-agrees={String(p.venueApi.agrees)}>
      <Icon n={p.venueApi.agrees === true ? 'check' : 'warn'} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{t(p.venueApi.agrees === true ? 'gxCrossOk' : p.venueApi.agrees === false ? 'gxCrossNo' : 'gxCrossUnknown')}{p.venueApi.detail && p.venueApi.agrees !== true ? <span className="block break-words font-mono text-[11px]">{p.venueApi.detail}</span> : null}</span></p>
    {onClose && <Btn kind="soft" className="mt-2.5 !min-h-11 !text-[14px]" onClick={onClose} data-testid="gmx-position-close">{t('gxClosePosition')}</Btn>}
  </li>;
}

function PendingRow({ o, op, onCancel }: { o: GmxStatus['pendingOrders'][number]; op: GmxOperation | undefined; onCancel?: (op: GmxOperation) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const left = useLeft(o.cancellableAt * 1000);
  return <li className="min-w-0 rounded-2xl border border-line p-3.5" data-testid="gmx-pending-order" data-key={o.key}>
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1"><span className="min-w-0 truncate text-[14px] font-semibold">{o.marketName}</span><SideTag side={o.side} /><span className="text-[12px] text-mute">{o.orderType}</span><span className="ml-auto"><ChainTag /></span></div>
    <p className="text-[12.5px] leading-snug" role="status">{t(o.frozen ? 'gxPendingFrozen' : 'gxPendingWaiting')}</p>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
      <Stat label={t('gxSize')} wrap>{usd(o.sizeUsd, locale)}</Stat><Stat label={t('gxCollateral')} wrap>{usdc(o.collateral, locale)}</Stat>
      <Stat label={t('gxAcceptable')} wrap>{px(o.acceptablePrice, locale)}</Stat><Stat label={t('gxSince')} wrap>{timeOf(o.updatedAt * 1000, locale)}</Stat></dl>
    {o.opId === null ? <p className="mt-2 text-[12px] leading-snug text-warn" data-testid="gmx-pending-foreign">{t('gxPendingForeign')}</p>
      : op && op.state === 'created' && onCancel ? <div className="mt-2 space-y-1">
        <Btn kind="soft" className="!min-h-11 !text-[14px]" disabled={left > 0} onClick={() => onCancel(op)} data-testid="gmx-pending-cancel"><Icon n="x" className="h-4 w-4" />{t('gxCancelOrder')}</Btn>
        <p className="text-[11.5px] leading-snug text-mute">{left > 0 ? t('gxCancelIn', { time: clock(left) }) : t('gxCancelNow')}</p></div> : null}
  </li>;
}

export function GmxActivity({ status, market, onSelect }: { status: GmxStatus; /** only this market's rows (the terminal); everything otherwise */ market?: string; onSelect?: (instrument: string) => void }) {
  const t = useT();
  const [request, setRequest] = useState<GmxRequest | null>(null), [fraction, setFraction] = useState<'0.25' | '0.5' | '1'>('1'), [all, setAll] = useState(false);
  const mine = <T extends { market: string | null }>(rows: T[]) => (market ? rows.filter((r) => r.market?.toLowerCase() === market.toLowerCase()) : rows);
  const positions = mine(status.positions), pending = mine(status.pendingOrders);
  // a proposal that was never approved is not history: it is shown while it waits for the passkey only in its own sheet
  const ops = (market ? status.operations.filter((o) => o.market === null || o.market.toLowerCase() === market.toLowerCase()) : status.operations).filter((o) => !['pending_approval', 'withdrawn', 'expired'].includes(o.state));
  const shown = all ? ops : ops.slice(0, 4), byId = new Map(status.operations.map((o) => [o.id, o]));
  // an on-chain order whose operation is listed below is followed there (one cancel button, not two)
  const loose = pending.filter((o) => !o.opId || !shown.some((x) => x.id === o.opId));
  const cancel = status.tradable ? (op: GmxOperation) => setRequest({ kind: 'cancel', op }) : undefined;
  const head = (s: string, n?: number) => <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-mute">{s}{n ? <span className="rounded-full bg-elev px-1.5 text-[11.5px] text-ink">{n}</span> : null}</h3>;
  return <div className="min-w-0 space-y-4" data-testid="gmx-activity">
    <section data-testid="gmx-positions">
      <div className="flex flex-wrap items-center justify-between gap-2">{head(t('gxPositions'), positions.length)}
        {positions.length > 0 && status.tradable && <Seg size="sm" label={t('gxCloseFraction')} value={fraction} onChange={setFraction} className="mb-2" options={[{ id: '0.25', label: '25 %' }, { id: '0.5', label: '50 %' }, { id: '1', label: '100 %' }]} />}</div>
      {status.positionsError ? <Notice tone="warn"><div data-testid="gmx-positions-error">{t('gxPositionsUnread')}<span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{status.positionsError}</span></div></Notice>
        : positions.length === 0 ? <p className="py-4 text-center text-[13px] text-mute">{t('gxNoPositions')}</p>
        : <ul className="space-y-2.5">{positions.map((p) => <PositionCard key={p.key} p={p} onSelect={onSelect} onClose={status.tradable ? () => setRequest({ kind: 'close', position: p, fraction }) : undefined} />)}</ul>}
      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-mute"><ChainTag />{t('gxPositionsSource')}</p>
    </section>
    {loose.length > 0 && <section data-testid="gmx-pending">{head(t('gxPending'), loose.length)}
      <ul className="space-y-2.5">{loose.map((o) => <PendingRow key={o.key} o={o} op={o.opId ? byId.get(o.opId) : undefined} onCancel={cancel} />)}</ul></section>}
    <section data-testid="gmx-operations">{head(t('gxOperations'))}
      {ops.length === 0 ? <p className="py-4 text-center text-[13px] text-mute">{t('gxNoOperations')}</p>
        : <ul className="space-y-2.5">{shown.map((o) => <li key={o.id}><GmxOpCard op={o} onCancel={cancel} /></li>)}</ul>}
      {ops.length > 4 && <button type="button" className="mt-2 min-h-11 text-[13px] font-medium text-blue" onClick={() => setAll(!all)}>{t(all ? 'gxShowLess' : 'gxShowAll', { n: ops.length })}</button>}
    </section>
    {request && <GmxConfirm status={status} request={request} onClose={() => setRequest(null)} />}
  </div>;
}
