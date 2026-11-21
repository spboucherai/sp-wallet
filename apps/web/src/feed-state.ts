/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/feed-state.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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
 * NEXT live sync — the little the FIRST chunk needs to know about the wallet event feed: its mode (is the stream connected?)
 * and the listeners of its events. The feed itself (walletEvents.ts: stream, parser, back-off, polling) is fetched once the
 * shell is drawn, so it costs nothing before the first paint.
 */
export type FeedMode = 'idle' | 'stream' | 'polling' | 'paused' | 'off';
export interface WalletEvent { id: number; at: string; type: string; ref: string | null; data: Record<string, unknown> }

let mode: FeedMode = 'idle';
const modeListeners = new Set<() => void>(), listeners = new Set<(e: WalletEvent) => void>();
/** is the stream connected (`stream`), or is the app on its fallbacks? — for the slow-poll intervals */
export const feedMode = (): FeedMode => mode;
export function setFeedMode(m: FeedMode): void { if (m === mode) return; mode = m; for (const f of modeListeners) f(); }
export function onFeedMode(f: () => void): () => void { modeListeners.add(f); return () => { modeListeners.delete(f); }; }
/** hear every wallet event (a screen that re-reads something the query cache does not hold); returns the unsubscribe */
export function onWalletEvent(f: (e: WalletEvent) => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
export function emitWalletEvent(e: WalletEvent): void { for (const f of listeners) { try { f(e); } catch { /* a listener's error is its own */ } } }
