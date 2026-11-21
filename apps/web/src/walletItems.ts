/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/walletItems.ts
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
 * NEXT — a wallet movement as `GET /activity` gives it (and as the timeline's wallet rows carry it), and the pure helpers the
 * dashboard, the asset page and the Activity screen share: what a row IS, who its counterparty is, which deposits are the
 * result of one of the wallet's own operations. No React: tested in test/next-wallet-items.test.ts.
 */
import type { BridgeV } from './bridge';
import type { ExecutionV } from './execution';
import type { HasLifecycle, LifecycleTimes } from './lifecycle';
import { contactFor, type Contact } from './wallet';
import type { XswapV } from './xswap';

export interface WalletItem extends HasLifecycle, LifecycleTimes {
  kind: 'send' | 'receive' | 'swap' | 'bridge' | 'gmx'; at: string; id: string; network: string; networkName: string; asset?: string; symbol: string; decimals?: number; amount: string; amountDisplay: string;
  state: string; txid: string | null; explorer: string | null; to?: string; from?: string; note?: string; memo?: string | null; confirmations?: number;
  /** the estimate made before signing, and — once the chain has said it — the fee actually paid (native coin of the network) */
  feeDisplay?: string | null; maxFeeDisplay?: string | null; feeSymbol?: string; feePaid?: string | null; feePaidDisplay?: string | null;
  error?: string | null; errorParams?: Record<string, string | number> | null; execution?: ExecutionV; warnings?: string[];
  swap?: { toSymbol: string; receivedDisplay: string | null; minOutDisplay: string } | null; bridge?: BridgeV | null; xswap?: XswapV | null;
  /** deposits: `external` = someone paid the wallet; `internal` = the result of one of the wallet's own operations (`origin` says which, `proposalId` links it) */
  depositKind?: 'external' | 'internal'; origin?: string | null; proposalId?: string | null; txidIsBlock?: boolean; block?: number;
  /** next-contract: the label of the contact behind `to` / `from`, when the server resolved it */ contactLabel?: string | null;
}
export const isInternalDeposit = (i: Pick<WalletItem, 'kind' | 'depositKind'>): boolean => i.kind === 'receive' && i.depositKind === 'internal';
/** deposits that are a return from one of the owner's own accounts outside the wallet (an agent's vault, a venue): shown, and named as such */
export const OWN_ACCOUNT_ORIGINS = ['agent_withdrawal', 'venue_withdrawal'] as const;
export const ORIGIN_KEYS = ['swap', 'bridge', 'xswap', 'agent_withdrawal', 'venue_withdrawal', 'change', 'plan'] as const;
/** i18n key of an internal deposit's origin (`nwOrigin_<origin>`, or the generic one) */
export const originKey = (origin: string | null | undefined): string => `nwOrigin_${origin && (ORIGIN_KEYS as readonly string[]).includes(origin) ? origin : 'other'}`;

/**
 * A list as the owner reads it: an internal deposit whose operation is IN the list is not a row of its own (it is that
 * operation's result, shown inside it — `resultsOf`); one whose operation is not in the list stays, labelled with its origin.
 * An external deposit is always a row.
 */
export function foldInternal<T extends WalletItem>(items: readonly T[]): T[] {
  const ids = new Set(items.filter((i) => i.kind !== 'receive').map((i) => i.id));
  return items.filter((i) => !(isInternalDeposit(i) && i.proposalId && ids.has(i.proposalId)));
}
/** the deposits that are the result of operation `id` */
export const resultsOf = <T extends WalletItem>(items: readonly T[], id: string): T[] => items.filter((i) => isInternalDeposit(i) && i.proposalId === id);

export type Direction = 'in' | 'out' | 'swap';
export const directionOf = (i: Pick<WalletItem, 'kind'>): Direction => (i.kind === 'receive' ? 'in' : i.kind === 'swap' || i.kind === 'bridge' ? 'swap' : 'out');
/** the address on the other side of a plain movement (none for a swap, a bridge or a GMX order: their « to » is a contract of the operation) */
export const counterpartyOf = (i: Pick<WalletItem, 'kind' | 'to' | 'from'>): string | null => (i.kind === 'send' ? i.to ?? null : i.kind === 'receive' ? i.from || null : null);
/** who the counterparty is: the server's `contactLabel` when it sends one, else the contact of the local list; null = show the address */
export function counterpartyLabel(i: Pick<WalletItem, 'kind' | 'to' | 'from' | 'network' | 'contactLabel'>, contacts: readonly Contact[] | undefined): string | null {
  if (i.contactLabel) return i.contactLabel;
  const a = counterpartyOf(i); return a ? contactFor(contacts, i.network, a)?.label ?? null : null;
}
export const shortAddr = (a: string): string => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/** rows of one asset on one network, newest first (the asset page; used when the server has no asset filter) */
export const itemsOfAsset = <T extends WalletItem>(items: readonly T[], network: string, asset: string): T[] => items.filter((i) => i.network === network && i.asset === asset);

// ---- CSV of what is on screen (the server's export has every row of the history; this one has the rows the filters kept)
const cell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
export const CSV_HEAD = 'time_utc,kind,network,symbol,amount,counterparty,contact,lifecycle,confirmations,txid,fee_estimate,fee_paid,fee_symbol';
export function csvOf(items: readonly WalletItem[], contacts: readonly Contact[] | undefined, lifecycle: (i: WalletItem) => string): string {
  const lines = [CSV_HEAD];
  for (const i of items) lines.push([new Date(i.at).toISOString(), i.kind === 'receive' && i.depositKind === 'internal' ? `receive_internal${i.origin ? `:${i.origin}` : ''}` : i.kind, i.network, i.symbol, i.amountDisplay,
    counterpartyOf(i) ?? '', counterpartyLabel(i, contacts) ?? '', lifecycle(i), i.confirmations ?? '', i.txid ?? '', i.feeDisplay ?? '', i.feePaidDisplay ?? '', i.feeSymbol ?? ''].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}
