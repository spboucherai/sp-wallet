// V8 hardening — what the withdraw sheet and the "funds on other networks" section say about a withdrawal: the server's REAL
// state (agent_withdrawals), followed until it is final. Never "sent" for something that was not broadcast, never "arrived"
// before the transaction is mined and the payment to the owner's address was seen in it.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { get, post } from '../api';
import type { Key } from '../i18n';

export type WdState = 'requested' | 'signed' | 'broadcast' | 'confirmed' | 'failed' | 'not_sent';
export interface Wd { id: string; ok: boolean; state: WdState; symbol: string; amount: string; explorer: string | null; error: string | null; arrived: boolean; duplicate?: boolean }
export const WD_OPEN: WdState[] = ['requested', 'signed', 'broadcast'];

/** The sentence and its tone for a withdrawal state. Pure (tested). `ok` (green) is reserved for confirmed AND arrived. */
export function withdrawalNotice(w: Pick<Wd, 'state' | 'arrived'>): { key: Key; tone: 'ok' | 'info' | 'warn' | 'danger'; pending: boolean } {
  switch (w.state) {
    case 'requested': case 'signed': return { key: 'hdWdSigned', tone: 'info', pending: true };
    case 'broadcast': return { key: 'hdWdBroadcast', tone: 'info', pending: true };
    case 'confirmed': return w.arrived ? { key: 'hdWdConfirmed', tone: 'ok', pending: false } : { key: 'hdWdUnverified', tone: 'warn', pending: false };
    case 'not_sent': return { key: 'hdWdNotSent', tone: 'warn', pending: false };
    default: return { key: 'hdWdFailed', tone: 'danger', pending: false };
  }
}

/** Start withdrawals and follow them. `start` uses one idempotency key per (sheet, asset): a double tap is the same operation. */
export function useTrackedWithdrawals(agentId: string, onFinal: () => void): { byKey: Record<string, Wd>; start(key: string, body: { asset: string; network?: string }): Promise<Wd> } {
  const qc = useQueryClient();
  const [byKey, setByKey] = useState<Record<string, Wd>>({});
  const idem = useRef<Record<string, string>>({}), final = useRef(onFinal); final.current = onFinal;
  const open = Object.entries(byKey).filter(([, w]) => WD_OPEN.includes(w.state));
  const openIds = open.map(([, w]) => w.id).join(',');
  useEffect(() => {
    if (!openIds) return;
    const tick = async () => { for (const [k, w] of open) { try { const n = await get<Wd>(`/agents/${agentId}/withdrawals/${w.id}`);
      if (n.state !== w.state) { setByKey((m) => ({ ...m, [k]: n })); if (!WD_OPEN.includes(n.state)) { delete idem.current[k]; final.current(); void qc.invalidateQueries({ queryKey: ['portfolio'] }); } } } catch { /* next tick */ } } };
    const h = setInterval(() => void tick(), 3000);
    return () => clearInterval(h);
  }, [openIds, agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async (key: string, body: { asset: string; network?: string }): Promise<Wd> => {
    const idempotencyKey = (idem.current[key] ??= crypto.randomUUID());
    const w = await post<Wd>(`/agents/${agentId}/withdraw`, { ...body, idempotencyKey });
    setByKey((m) => ({ ...m, [key]: w }));
    if (!WD_OPEN.includes(w.state)) { delete idem.current[key]; final.current(); }
    return w;
  };
  return { byKey, start };
}
