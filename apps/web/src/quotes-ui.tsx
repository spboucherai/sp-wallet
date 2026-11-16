/**
 * V11 live quotes — the small pieces screens put next to a live figure (docs/V11-QUOTE-ENGINE.md §7; conventions of ui.tsx
 * and docs/v9/DESIGN.md): a state is never a colour alone — the dot always comes with its word and, past « live », its age.
 */
import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { I18n, useT, type Key } from './i18n';
import { ageLabel } from './markets';
import { useConn, useFresh, useQuote, useVenueStatus, type Conn, type Fresh, type LiveQuote } from './quotes';
import { Tag } from './ui';

const DOT: Record<Fresh, string> = { live: 'bg-emerald', delayed: 'bg-mute', stale: 'bg-warn', reconnecting: 'bg-warn', none: 'bg-mute' };

/**
 * live / delayed / stale / reconnecting, with the age. Renders `children` (the screen's own, polled freshness) when there is
 * no live value to speak of — so a screen without the socket shows exactly what it showed before.
 */
export function LiveDot({ v, children, className = '' }: { v: { at: number; stale: boolean; staleAfterMs?: number | null; source?: string } | null | undefined; children?: ReactNode; className?: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const f = useFresh(v);
  if (!v || f.state === 'none') return <>{children ?? null}</>;
  const text = f.state === 'live' ? t('qtLive') : f.state === 'reconnecting' ? t('qtReconnecting') : t(f.state === 'stale' ? 'qtStale' : 'qtDelayed', { age: ageLabel(f.ageMs, locale) });
  return <span className={`inline-flex items-center gap-1.5 text-[12px] ${f.state === 'stale' || f.state === 'reconnecting' ? 'font-medium text-warn' : 'text-mute'} ${className}`} data-testid="qt-dot" data-state={f.state}
    title={v.source ? t('qtSource', { source: v.source }) : undefined}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[f.state]}`} aria-hidden="true" />{text}</span>;
}
/** the same for one market id: subscribes to its quote */
export function QuoteDot({ id, children }: { id: string; children?: ReactNode }) { return <LiveDot v={useQuote(id)}>{children}</LiveDot>; }

/**
 * A figure that ticks: `render(quote)` when the market has a live quote (and returns something), `children` otherwise.
 * A change of `flash(quote)` briefly tints the cell — green up, red down — unless the system asks for reduced motion.
 * Only this cell re-renders on a tick.
 */
export function LiveCell({ id, render, flash, children }: { id: string | null; render: (q: LiveQuote) => ReactNode | null; flash?: (q: LiveQuote) => string | null; children: ReactNode }) {
  const q = useQuote(id), el = useRef<HTMLSpanElement>(null), prev = useRef<number | null>(null);
  const shown = q ? render(q) : null, key = q && flash ? flash(q) : null;
  useEffect(() => {
    const n = key === null ? null : Number(key), was = prev.current;
    prev.current = n;
    if (n === null || was === null || n === was || !el.current || typeof el.current.animate !== 'function') return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.current.animate([{ backgroundColor: `color-mix(in srgb, var(${n > was ? '--emerald' : '--danger'}) 24%, transparent)` }, { backgroundColor: 'transparent' }], { duration: 650, easing: 'ease-out' });
  }, [key]);
  if (shown === null || shown === undefined || shown === false) return <>{children}</>;
  return <span ref={el} className="-mx-1 inline-block rounded-md px-1" data-testid="qt-live" data-id={id ?? ''}>{shown}</span>;
}

const CONN_TEXT: Record<Conn, Key> = { idle: 'qtConnIdle', connecting: 'qtConnConnecting', live: 'qtConnLive', reconnecting: 'qtConnReconnecting', fallback: 'qtConnFallback', paused: 'qtConnPaused' };
const CONN_TONE: Record<Conn, 'ok' | 'warn' | 'mute'> = { idle: 'mute', connecting: 'mute', live: 'ok', reconnecting: 'warn', fallback: 'mute', paused: 'mute' };
/**
 * The state of the live stream for a screen: one tag for the tab's connection and, when asked, one per venue whose upstream is
 * not connected (reconnecting / stale / down) — a dead venue is named, the others stay live.
 */
export function LiveStatus({ venues, names }: { venues?: string[]; names?: Record<string, string> }) {
  const t = useT(); const { locale } = useContext(I18n);
  const conn = useConn(), st = useVenueStatus();
  const troubled = conn === 'live' ? (venues ?? []).map((v) => st[v]).filter((s): s is NonNullable<typeof s> => !!s && s.status !== 'connected' && s.status !== 'idle') : [];
  return <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="qt-conn" data-state={conn} aria-live="polite">
    <Tag tone={CONN_TONE[conn]} icon={conn === 'live' ? 'check' : conn === 'reconnecting' ? 'refresh' : 'clock'}>{t(CONN_TEXT[conn])}</Tag>
    {troubled.map((s) => <Tag key={s.venue} tone={s.status === 'down' ? 'danger' : 'warn'} icon="warn" testid={`qt-venue-${s.venue}`}>{names?.[s.venue] ?? s.venue} · {t(`qtVenue_${s.status}` as Key)}{s.ageMs !== null ? ` · ${ageLabel(s.ageMs, locale)}` : ''}</Tag>)}
  </span>;
}
