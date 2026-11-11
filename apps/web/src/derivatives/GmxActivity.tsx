/**
 * What the wallet has on GMX (v8), all of it read from the chain by the server: the positions (with the cross-check against
 * GMX's own API), the orders stored on-chain now, and the engine's operations with their honest states. « Fermer » and
 * « Annuler l'ordre » only open the confirm sheet (GmxConfirm.tsx): nothing leaves without the passkey.
 *
 * v10: asset logos, figures as tiles, eyebrow-titled groups, designed empty states. A `created` order still reads « en
 * attente d'exécution par le réseau GMX » (GmxOpCard) and an on-chain pending order « en attente » — never executed.
 */
import { useContext, useState, type ReactNode } from 'react';
import { I18n, useT } from '../i18n';
import { AssetIcon, Btn, Icon, Notice, Stat, StatGrid, Tag } from '../ui';
import { Pnl, Seg, SideTag, timeOf } from './bits';
import { type GmxOperation, type GmxPosition, type GmxStatus } from './gmx';
import { ChainTag, gmxBase, GmxOpCard, lev, px, usdc, useLeft } from './GmxBits';
import { GmxConfirm, type GmxRequest } from './GmxConfirm';
import { WORDS } from './LiveBits';
import { clock } from './live';
import { usd } from './dec';

const CARD = 'min-w-0 rounded-[18px] border border-line p-4';
/** nothing to list: an icon and the sentence, in the list's place */
function Nothing({ icon, children }: { icon: string; children: ReactNode }) {
  return <div className="flex items-center gap-3 rounded-[18px] bg-elev/50 px-4 py-4 text-[13.5px] text-mute"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface"><Icon n={icon} className="h-[18px] w-[18px]" /></span><span className="min-w-0">{children}</span></div>;
}

function PositionCard({ p, onClose, onSelect }: { p: GmxPosition; onClose?: () => void; onSelect?: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const ok = p.venueApi.agrees === true;
  return <li className={CARD} data-testid="gmx-position" data-market={p.market} data-side={p.side}>
    <div className="mb-3 flex items-center gap-3"><AssetIcon sym={gmxBase(p.marketName)} size={36} />
      <div className="min-w-0 flex-1"><button type="button" className="row-press -my-1 block min-h-9 max-w-full rounded-lg text-left text-[15.5px] font-semibold leading-tight [overflow-wrap:anywhere]" onClick={() => onSelect?.(p.instrument)}>{p.marketName}</button>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1"><SideTag side={p.side} /><span className="text-[13px] font-semibold">{lev(p.leverage, locale)}</span><ChainTag /></div></div></div>
    <StatGrid cols={4}>
      <Stat label={t('gxSize')} value={usd(p.sizeUsd, locale)} />
      <Stat label={t('gxCollateral')} value={usdc(p.collateral, locale)} />
      <Stat label={t('gxEntry')} value={px(p.entryPrice, locale)} />
      <Stat label={t('gxMark')} value={px(p.markPrice, locale)} />
      <Stat label={t('gxPnlEst')} value={<Pnl value={p.pnlUsd} locale={locale} />} />
      <Stat label={t('gxLiqEst')} value={px(p.liquidationPrice, locale)} />
      <Stat label={t('gxSince')} value={timeOf(p.increasedAt * 1000, locale, true)} />
    </StatGrid>
    <p className={`mt-3 flex items-start gap-2 text-[12.5px] leading-snug ${ok ? 'text-mute' : 'text-warn'}`} data-testid="gmx-crosscheck" data-agrees={String(p.venueApi.agrees)}>
      <Icon n={ok ? 'check' : 'warn'} className={`mt-0.5 h-4 w-4 shrink-0 ${ok ? 'text-emerald' : ''}`} />
      <span className="min-w-0">{t(ok ? 'gxCrossOk' : p.venueApi.agrees === false ? 'gxCrossNo' : 'gxCrossUnknown')}{p.venueApi.detail && !ok ? <span className="block break-words font-mono text-[11px]">{p.venueApi.detail}</span> : null}</span></p>
    {onClose && <Btn kind="soft" className="mt-3 !min-h-11 !text-[14px]" onClick={onClose} data-testid="gmx-position-close">{t('gxClosePosition')}</Btn>}
  </li>;
}

function PendingRow({ o, op, onCancel }: { o: GmxStatus['pendingOrders'][number]; op: GmxOperation | undefined; onCancel?: (op: GmxOperation) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const left = useLeft(o.cancellableAt * 1000);
  return <li className={CARD} data-testid="gmx-pending-order" data-key={o.key}>
    <div className="mb-2.5 flex items-center gap-3"><AssetIcon sym={gmxBase(o.marketName)} size={36} />
      <div className="min-w-0 flex-1"><div className="text-[15.5px] font-semibold leading-tight [overflow-wrap:anywhere]">{o.marketName}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1"><SideTag side={o.side} /><span className="text-[12.5px] text-mute">{o.orderType}</span><ChainTag /></div></div></div>
    <p className="flex items-start gap-2 text-[13.5px] leading-snug" role="status"><Icon n="clock" className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><span className="min-w-0">{t(o.frozen ? 'gxPendingFrozen' : 'gxPendingWaiting')}</span></p>
    <StatGrid cols={4} className="mt-3">
      <Stat label={t('gxSize')} value={usd(o.sizeUsd, locale)} /><Stat label={t('gxCollateral')} value={usdc(o.collateral, locale)} />
      <Stat label={t('gxAcceptable')} value={px(o.acceptablePrice, locale)} /><Stat label={t('gxSince')} value={timeOf(o.updatedAt * 1000, locale)} /></StatGrid>
    {o.opId === null ? <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-snug text-warn" data-testid="gmx-pending-foreign"><Icon n="warn" className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0">{t('gxPendingForeign')}</span></p>
      : op && op.state === 'created' && onCancel ? <div className="mt-3 space-y-1.5">
        <Btn kind="soft" className="!min-h-11 !text-[14px]" disabled={left > 0} onClick={() => onCancel(op)} data-testid="gmx-pending-cancel"><Icon n="x" className="h-4 w-4" />{t('gxCancelOrder')}</Btn>
        <p className="text-[12px] leading-snug text-mute">{left > 0 ? t('gxCancelIn', { time: clock(left) }) : t('gxCancelNow')}</p></div> : null}
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
  const head = (s: string, n?: number) => <h3 className="t-eyebrow mb-2 flex min-h-6 items-center gap-2 px-0.5">{s}{n ? <Tag>{n}</Tag> : null}</h3>;
  return <div className="min-w-0 space-y-5" data-testid="gmx-activity">
    <section data-testid="gmx-positions">
      <div className="flex flex-wrap items-center justify-between gap-2">{head(t('gxPositions'), positions.length)}
        {positions.length > 0 && status.tradable && <Seg size="sm" label={t('gxCloseFraction')} value={fraction} onChange={setFraction} className="mb-2" options={[{ id: '0.25', label: '25 %' }, { id: '0.5', label: '50 %' }, { id: '1', label: '100 %' }]} />}</div>
      {status.positionsError ? <Notice tone="warn"><div data-testid="gmx-positions-error">{t('gxPositionsUnread')}<span className={`mt-1.5 ${WORDS}`}>{status.positionsError}</span></div></Notice>
        : positions.length === 0 ? <Nothing icon="chart">{t('gxNoPositions')}</Nothing>
        : <ul className="space-y-3">{positions.map((p) => <PositionCard key={p.key} p={p} onSelect={onSelect} onClose={status.tradable ? () => setRequest({ kind: 'close', position: p, fraction }) : undefined} />)}</ul>}
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-mute"><ChainTag />{t('gxPositionsSource')}</p>
    </section>
    {loose.length > 0 && <section data-testid="gmx-pending">{head(t('gxPending'), loose.length)}
      <ul className="space-y-3">{loose.map((o) => <PendingRow key={o.key} o={o} op={o.opId ? byId.get(o.opId) : undefined} onCancel={cancel} />)}</ul></section>}
    <section data-testid="gmx-operations">{head(t('gxOperations'))}
      {ops.length === 0 ? <Nothing icon="list">{t('gxNoOperations')}</Nothing>
        : <ul className="space-y-3">{shown.map((o) => <li key={o.id}><GmxOpCard op={o} onCancel={cancel} /></li>)}</ul>}
      {ops.length > 4 && <button type="button" className="press mt-2 inline-flex min-h-11 items-center gap-1 text-[13.5px] font-medium text-blue" onClick={() => setAll(!all)}>{t(all ? 'gxShowLess' : 'gxShowAll', { n: ops.length })}</button>}
    </section>
    {request && <GmxConfirm status={status} request={request} onClose={() => setRequest(null)} />}
  </div>;
}
