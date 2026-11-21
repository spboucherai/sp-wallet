/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/issuer.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Who stands behind a registry deployment, in the owner's language.
//
// Two sources, both display only:
//   1. the ticker, for the reviewed wrappers of packages/core/src/market-symbols.ts (WBTC, cbBTC, BTCB, WETH, EURC…): the
//      server sends their issuer as an English sentence; the same facts are said here in French and English;
//   2. the deployment NAME of the registry, for pegged or bridged tokens that keep the underlying's ticker and therefore
//      carry no issuer anywhere else: "Binance-Peg Ethereum" (ETH on BNB Chain), "Binance-Peg USD Coin" (the 18-decimal
//      USDC of BNB Chain), "Bridged USDT (Base Standard Bridge)", "Wrapped BTC (Arbitrum bridge)".
// Nothing here decides anything: the signer prices and refuses on its own.
import type { Key } from './i18n';

type T = (k: Key, v?: Record<string, string | number>) => string;
export interface IssuerInfo { kind: 'wrapped' | 'pegged' | 'bridged'; /** one sentence fragment: who must stay solvent and honest */ text: string }
const BY_SYMBOL: Record<string, Key> = { WETH: 'qaIss_WETH', WBTC: 'qaIss_WBTC', cbBTC: 'qaIss_cbBTC', tBTC: 'qaIss_tBTC', BTCB: 'qaIss_BTCB', cbXRP: 'qaIss_cb', cbDOGE: 'qaIss_cb', cbADA: 'qaIss_cb', cbLTC: 'qaIss_cb',
  WBNB: 'qaIss_wnative', WAVAX: 'qaIss_wnative', WPOL: 'qaIss_wnative', WHYPE: 'qaIss_wnative', EURC: 'qaIss_EURC' };
/** The bridge named in a deployment name: "… (Base Standard Bridge)" → "Base Standard Bridge". */
const bridgeOf = (name: string): string | null => { const m = /\(([^)]*bridge[^)]*)\)/i.exec(name); return m ? m[1]!.replace(/\bbridge\b/, 'Bridge') : /^bridged\b/i.test(name) ? '' : null; };

export function issuerOf(t: T, assetSymbol: string, name: string, serverIssuer?: string | null): IssuerInfo | null {
  const bridge = bridgeOf(name), via = bridge ? ` ; ${t('qaIssVia', { bridge })}` : '';
  const key = BY_SYMBOL[assetSymbol];
  if (/^binance-peg\b/i.test(name)) return { kind: 'pegged', text: key === 'qaIss_BTCB' ? t(key) : t('qaIssBinancePeg') };
  if (key) return { kind: assetSymbol === 'EURC' ? 'pegged' : 'wrapped', text: t(key, { sym: assetSymbol, under: assetSymbol.replace(/^cb|^W/, '') }) + via };
  if (bridge !== null) return { kind: 'bridged', text: bridge ? t('qaIssBridged', { bridge }) : t('qaIssBridgedGeneric') };
  return serverIssuer ? { kind: 'wrapped', text: serverIssuer } : null;
}
/** Representation the reviewed default rule does not pick although it is the liquid one on that network (shown as a hint; the rule is unchanged). */
export const LIQUID_HINT: Record<string, Record<string, string>> = { bsc: { BTC: 'BTCB' } };
