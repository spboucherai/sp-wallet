/**
 * V11 Trade — a SLOT in the confirmation sheets of the order panels (paper: OrderPanel, venue account: LiveApproval). The
 * panels keep their own logic; before the owner confirms — and, on a venue account, before the passkey prompts — the slot shows
 * what the terminal provides for that exact order: every check of the unified risk engine and of the mandate
 * (screens/TradeUnified.tsx → POST /api/v1/trading/orders/preview). Without a provider the slot renders nothing: a panel used
 * outside the terminal (tests, the mock) is exactly what it was.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { OrderBody } from './types';

export interface OrderChecksProps { mode: 'paper' | 'live'; accountId: string; body: Pick<OrderBody, 'instrument' | 'side' | 'type' | 'size' | 'price' | 'triggerPrice' | 'reduceOnly' | 'tif'> & { leverage?: string; slippageBps?: number } }
export const OrderChecksContext = createContext<((p: OrderChecksProps) => ReactNode) | null>(null);
export function OrderChecksSlot(p: OrderChecksProps) { const render = useContext(OrderChecksContext); return render ? <>{render(p)}</> : null; }
