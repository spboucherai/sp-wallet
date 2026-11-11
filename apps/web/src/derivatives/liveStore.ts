/**
 * The selected VENUE account, kept current: `GET /live/accounts/:id` (venue state, orders, fills, funding, risk events) and the
 * Server-Sent Events of `…/stream` merged into the same cache entry — `account` (the venue's state after each reconciliation),
 * `order`, `action`, `risk`, `status`. Everything shown comes from the server; nothing is predicted locally.
 * While the stream is up the account is polled slowly (the stream carries the changes); without it, every 8 s.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { lapi, type LiveAction, type LiveDetail, type LiveOrder } from './live';

export const liveKey = (id: string | null | undefined) => ['deriv', 'live', 'account', id] as const;
export const refreshLive = (qc: QueryClient, id?: string) => Promise.all([qc.invalidateQueries({ queryKey: ['deriv', 'live', 'accounts'] }), qc.invalidateQueries({ queryKey: id ? liveKey(id) : ['deriv', 'live', 'account'] }),
  qc.invalidateQueries({ queryKey: ['deriv', 'live', 'collateral'] })]);

/** an `order` event replaces the row with the same client id, or is put first */
export function mergeOrder(list: LiveOrder[], o: LiveOrder): LiveOrder[] {
  const i = list.findIndex((x) => x.clientId === o.clientId);
  if (i < 0) return [o, ...list].slice(0, 100);
  if (list[i]!.updatedAt > o.updatedAt) return list;
  const next = [...list]; next[i] = o; return next;
}
/** one stream event applied to the cached account; unknown events change nothing */
export function applyLiveEvent(d: LiveDetail, event: string, data: any): LiveDetail {
  if (!data || typeof data !== 'object') return d;
  if (event === 'account') {
    const readable = data.state !== undefined && data.state !== null;
    return { ...d, venueState: { state: readable ? data.state : d.venueState.state, positions: Array.isArray(data.positions) ? data.positions : d.venueState.positions, openOrders: Array.isArray(data.openOrders) ? data.openOrders : d.venueState.openOrders,
      error: typeof data.error === 'string' ? data.error : readable ? null : d.venueState.error, ts: Number(data.ts) || d.venueState.ts, source: 'venue' },
      divergence: data.divergence === undefined ? d.divergence : data.divergence, halt: data.halt === undefined ? d.halt : data.halt, mode: data.mode === 'MANUAL_LIVE' || data.mode === 'READ_ONLY' ? data.mode : d.mode };
  }
  if (event === 'order' && typeof data.clientId === 'string') return { ...d, orders: mergeOrder(d.orders, data as LiveOrder) };
  if (event === 'action' && typeof data.id === 'string') { const a = data as LiveAction, i = d.actions.findIndex((x) => x.id === a.id); return { ...d, actions: i < 0 ? [a, ...d.actions].slice(0, 50) : d.actions.map((x) => (x.id === a.id ? a : x)) }; }
  if (event === 'risk') return { ...d, riskEvents: [{ id: `s${data.ts}${data.kind}${d.riskEvents.length}`, ts: Number(data.ts) || Date.now(), kind: String(data.kind ?? 'event'), code: typeof data.code === 'string' ? data.code : null, message: String(data.message ?? ''), data: data.data ?? {} }, ...d.riskEvents].slice(0, 100) };
  return d;
}

export type LiveConn = 'connecting' | 'stream' | 'polling';
export function useLiveAccount(id: string | null): { detail: LiveDetail | undefined; error: unknown; conn: LiveConn; /** the reconciliation worker could not read the venue */ workerError: string | null; refresh: () => void } {
  const qc = useQueryClient();
  const [conn, setConn] = useState<LiveConn>('connecting'), [workerError, setWorkerError] = useState<string | null>(null);
  const q = useQuery({ queryKey: liveKey(id), enabled: !!id, queryFn: () => lapi.account(id!), refetchInterval: conn === 'stream' ? 30_000 : 8000, retry: 0 });
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!id) return;
    setConn('connecting'); setWorkerError(null);
    let es: EventSource | null = null;
    try { es = new EventSource(lapi.streamUrl(id)); } catch { setConn('polling'); return; }
    const refetchSoon = () => { if (pending.current) return; pending.current = setTimeout(() => { pending.current = null; void qc.invalidateQueries({ queryKey: liveKey(id) }); void qc.invalidateQueries({ queryKey: ['deriv', 'live', 'accounts'] }); }, 400); };
    const on = (event: string) => (e: Event) => {
      let data: any; try { data = JSON.parse((e as MessageEvent).data); } catch { return; }
      setConn('stream');
      if (event === 'status') { setWorkerError(typeof data?.error === 'string' ? data.error : null); refetchSoon(); return; }   // mode / halt / divergence changed: read the account again
      if (event === 'account') setWorkerError(null);
      qc.setQueryData<LiveDetail>(liveKey(id), (d) => (d ? applyLiveEvent(d, event, data) : d));
      if (event === 'order' || event === 'action' || event === 'risk') refetchSoon();   // fills, funding and events are read from the account route
    };
    for (const ev of ['status', 'account', 'order', 'action', 'risk']) es.addEventListener(ev, on(ev));
    es.addEventListener('open', () => setConn('stream'));
    // the browser reconnects by itself; meanwhile (or when the server refuses a ninth stream) the account is polled
    es.addEventListener('error', (e) => { if (typeof (e as MessageEvent).data === 'string') return; setConn('polling'); });
    return () => { es?.close(); if (pending.current) { clearTimeout(pending.current); pending.current = null; } };
  }, [id, qc]);
  return { detail: id && q.data?.id === id ? q.data : undefined, error: q.error, conn, workerError, refresh: () => { void qc.invalidateQueries({ queryKey: liveKey(id) }); } };
}
