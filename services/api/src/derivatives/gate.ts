/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/gate.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// V11 — the unified risk gate, as the venue engines see it. The engines (paper.ts, exec.ts, gmx-exec.ts) stay the executors;
// before an order of ANY origin (owner screen, perp agent, trading API) is stored for approval or handed to the signer they
// ask this gate, which runs `evaluate()` of @spw/trading on a context assembled by the risk service (services/api/src/risk).
// The gate is set on the engine instances by the server (orders/index.ts); an engine built without one behaves as before.
import type { AccountState, Book, DecStr, Instrument, OrderRequest, Position, Ticker } from '@spw/derivatives';

export interface PreTradeRequest {
  mode: 'paper' | 'live'; venue: string; network: string; accountId: string;
  /** the order as the engine will execute it (a market order names its worst acceptable price) */
  req: OrderRequest; instrument: Instrument;
  /** who the engine places it for: the owner (manual order, close), or an agent / API key under a derivative mandate */
  origin: 'owner' | 'close' | 'mandate'; agentId?: string | null; mandateId?: string | null;
  /** a preview: the evaluation is stored as one and is never reused as the decision of an order */
  preview?: boolean;
  /** what the engine has just read for its own checks — reused, never re-read, so the two engines judge the same market */
  known: { ticker: Ticker; book: Book | null; account: AccountState | null; positions: Position[] | null; leverage: DecStr | null; maintenanceMarginFraction?: DecStr };
}
export type PreTradeResult = { ok: true } | { ok: false; code: 'risk_denied' | 'kill_switch_active' | 'read_only_mode'; reason: string };
export type PreTradeGate = (r: PreTradeRequest) => Promise<PreTradeResult>;
/** why NEW risk is blocked right now (kill switch or read-only mode), or null — asked again at approval time, for a proposal made before the switch */
export type NewRiskBlock = () => Promise<{ code: 'kill_switch_active' | 'read_only_mode'; reason: string } | null>;
