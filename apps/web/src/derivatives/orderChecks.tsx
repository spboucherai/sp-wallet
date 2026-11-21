/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/orderChecks.tsx
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-16
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

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
