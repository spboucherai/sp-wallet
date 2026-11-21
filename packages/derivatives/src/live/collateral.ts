/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/live/collateral.ts
 * Module           : live
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

// Funding a venue account from the wallet, and bringing the money back (v6). Shared by the isolated signer and the API; pure:
// no network, no clock, no key. Facts, sources and the evidence that the route works: docs/v4/venues/hyperliquid.md, section 15.
//
//  - DEPOSIT (Hyperliquid mainnet): a plain transfer of native USDC on Arbitrum One, FROM the wallet's own address (the venue
//    credits the sender: the venue account IS that address) TO the venue's bridge contract, pinned below. It travels as an
//    ordinary wallet intent with a `venueDeposit` section (packages/core/src/intent.ts); `checkVenueDepositIntent` is what the
//    signer applies before it builds the transaction, and what the API applies before it asks.
//  - WITHDRAWAL: the venue's user-signed `withdraw3` action, signed by the wallet key, only to the wallet's own address. Its
//    canonical object (`VenueWithdrawal`) is what the passkey commits to.
//
// The pinned table is a TRUST INPUT of the signer: it is shipped in its bundle and never received from the API.
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { D, type DecStr } from '../decimal.ts';
import { DecStrSchema } from '../models.ts';
import { buildWithdraw3TypedDataOnly, HL_DEFAULT_SIGNATURE_CHAIN_ID, HL_PRIMARY, hlChainName, type HlNetwork, type HlTypedData, type HlWithdraw3Action } from '../venues/hyperliquid/signing.ts';

// ---------------------------------------------------------------------------------------------------------------------------
// Pinned route

export const HL_COLLATERAL_PINNED_AT = '2026-11-11';
/** the venue's documented minimum: "The minimum deposit amount is 5 USDC. If you send an amount less than this, it will not be credited and be lost forever." */
export const HL_DEPOSIT_MIN_USDC = '5';
/** the wallet's own floor, above the venue minimum: a smaller deposit is refused by the API and by the signer */
export const HL_DEPOSIT_FLOOR_USDC = '6';
/** "There is a $1 fee for withdrawing at the time of this writing" (exchange-endpoint); the venue ledger showed `fee: "1.0"` on 2026-11-11 */
export const HL_WITHDRAW_FEE_USDC = '1';
/** USDC has 6 decimals on Arbitrum; amounts are whole base units */
export const HL_USDC_DECIMALS = 6;
/** withdrawal signatures per UTC day (each one costs the venue fee) */
export const HL_WITHDRAWALS_PER_DAY = 10;
/** a withdrawal approval is valid at most this long (`time` → signature) */
export const HL_WITHDRAW_MAX_TTL_MS = 300_000;
export const HL_DEPOSIT_ROUTE = 'arbitrum-bridge2';

export interface HlBridgePin {
  /** wallet network id of the chain the bridge lives on */
  readonly network: string; readonly chainId: number;
  /** Bridge2 (EIP-55). Verified source on the explorer = hyperliquid-dex/contracts Bridge2.sol; not a proxy, no owner. */
  readonly bridge: string;
  /** the only token the bridge pays out and the venue credits: native USDC */
  readonly usdc: string;
  /** SHA-256 of the bridge's runtime bytecode, read on both registry RPC endpoints (scripts/check-hl-bridge.mts) */
  readonly codeSha256: string; readonly codeBytes: number;
}
/**
 * Mainnet only. The testnet bridge (0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89, Arbitrum Sepolia) is deliberately NOT here: the
 * wallet has no Arbitrum Sepolia network, and testnet collateral is mock USDC from the venue's faucet, not a token to deposit.
 */
export const HL_BRIDGE_PINS: Readonly<Partial<Record<HlNetwork, HlBridgePin>>> = {
  mainnet: {
    network: 'arbitrum', chainId: 42161,
    bridge: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    codeSha256: '37ff6a58c3c80d99fd85ba0898ba3a5ae8d55b82c4a4d758dd258af3b05fc3c7', codeBytes: 19394,
  },
};
/** every bridge address the venue documents, on any network, lower case: an ordinary transfer to one of them is refused */
export const HL_BRIDGE_ADDRESSES: readonly string[] = ['0x2df1c51e09aecf9cacb7bc98cb1742757f163df7', '0x08cfc1b6b2dcf36a1480b99353a354aa8ac56f89'];
export const isVenueBridgeAddress = (a: string): boolean => HL_BRIDGE_ADDRESSES.includes(String(a).toLowerCase());

const pow10 = (n: number): bigint => 10n ** BigInt(n);
/** whole USDC (decimal string) → base units */
export const usdcUnits = (x: DecStr): bigint => {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(x)) throw new Error('a USDC amount has at most 6 decimals');
  const [w, f = ''] = x.split('.');
  return BigInt(w!) * pow10(HL_USDC_DECIMALS) + BigInt(f.padEnd(HL_USDC_DECIMALS, '0') || '0');
};
/** base units → the venue's plain decimal string (no trailing zeros) */
export const usdcDecimal = (v: bigint): DecStr => {
  const w = v / pow10(HL_USDC_DECIMALS), f = (v % pow10(HL_USDC_DECIMALS)).toString().padStart(HL_USDC_DECIMALS, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Deposit: the `venueDeposit` section of a wallet intent

/** the section as it sits in the intent (same shape as the zod schema of packages/core/src/intent.ts) */
export interface VenueDepositSection { venue: 'hyperliquid'; venueNetwork: HlNetwork; route: string; bridge: string; minAmount: string }
/** the fields of a wallet intent this file reads (structural: the derivatives package does not import the core package) */
export interface VenueDepositIntent {
  network: string; chainRef: string; asset: string; symbol: string; decimals: number; amount: string; from: string; to: string;
  memo?: string | undefined; swap?: unknown; bridge?: unknown; /** native cross-chain swap (THORChain) */ xswap?: unknown; venueDeposit?: VenueDepositSection | undefined;
}

export function venueDepositSection(venueNetwork: HlNetwork): VenueDepositSection {
  const pin = HL_BRIDGE_PINS[venueNetwork];
  if (!pin) throw new Error(`no deposit route is pinned for Hyperliquid ${venueNetwork}`);
  return { venue: 'hyperliquid', venueNetwork, route: HL_DEPOSIT_ROUTE, bridge: pin.bridge, minAmount: usdcUnits(HL_DEPOSIT_FLOOR_USDC).toString() };
}

/**
 * Everything a venue deposit must be, checked against the pinned table. `own` is the wallet's own address on the intent's
 * network (the signer derives it; the API reads it from the signer). Throws with the reason; returns the pin used.
 * An intent WITHOUT the section that pays a venue bridge address is refused too: such a transfer would skip the minimum.
 */
export function checkVenueDepositIntent(i: VenueDepositIntent, own: string): HlBridgePin | null {
  const s = i.venueDeposit;
  if (!s) {
    if (isVenueBridgeAddress(i.to)) throw new Error('this destination is a venue bridge: funds reach the venue only through a venue deposit, which checks the network, the token and the minimum');
    return null;
  }
  if (i.swap || i.bridge || i.xswap) throw new Error('a venue deposit is neither a swap nor a cross-chain transfer');
  if (i.memo !== undefined) throw new Error('a venue deposit carries no memo');
  if (s.venue !== 'hyperliquid') throw new Error('unknown venue');
  const pin = HL_BRIDGE_PINS[s.venueNetwork];
  if (!pin) throw new Error(`no deposit route is pinned for Hyperliquid ${s.venueNetwork}`);
  if (s.route !== HL_DEPOSIT_ROUTE) throw new Error('unknown deposit route');
  if (i.network !== pin.network || i.chainRef !== String(pin.chainId)) throw new Error(`a Hyperliquid ${s.venueNetwork} deposit is made on ${pin.network} only`);
  if (i.asset !== pin.usdc || i.symbol !== 'USDC' || i.decimals !== HL_USDC_DECIMALS) throw new Error('only native USDC can be deposited: any other token sent to the bridge is lost');
  if (s.bridge !== pin.bridge || i.to !== pin.bridge) throw new Error('the destination is not the pinned bridge contract of the venue');
  if (i.from !== own) throw new Error('the venue credits the sending address: a deposit is sent from the wallet\'s own address only');
  if (i.from.toLowerCase() === i.to.toLowerCase()) throw new Error('destination equals source');
  const floor = usdcUnits(HL_DEPOSIT_FLOOR_USDC);
  if (s.minAmount !== floor.toString()) throw new Error('the minimum shown for approval is not the one this signer enforces');
  if (!/^(0|[1-9]\d{0,77})$/.test(i.amount)) throw new Error('malformed amount');
  if (BigInt(i.amount) < floor) throw new Error(`a deposit below ${HL_DEPOSIT_FLOOR_USDC} USDC is refused: the venue credits nothing under ${HL_DEPOSIT_MIN_USDC} USDC and the funds would be lost`);
  return pin;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Withdrawal: canonical object, hash, and the one venue action it allows

const enc = new TextEncoder();
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UsdAmount = DecStrSchema.refine((x) => /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(x) && /[1-9]/.test(x), 'a positive USDC amount with at most 6 decimals');

export const VenueWithdrawalSchema = z.strictObject({
  v: z.literal(1),
  withdrawalId: z.uuid(),
  /** the owner key (signer key id) */
  keyId: z.string().min(8).max(80),
  venue: z.literal('hyperliquid'),
  network: z.enum(['mainnet', 'testnet']),
  /** the venue account = the wallet's own EVM address (lower case) */
  account: z.string().regex(ADDRESS),
  /** where the bridge pays out on Arbitrum. The signer accepts exactly one value: the wallet's own address. */
  destination: z.string().regex(ADDRESS),
  /** USDC asked from the venue, as the venue receives it (plain decimal string) */
  amount: UsdAmount,
  /** the venue's withdrawal fee that was shown (USDC) */
  fee: UsdAmount,
  /** `time` of the withdraw3 action = the venue nonce (unix ms) */
  time: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** unix seconds: the approval window */
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
});
export type VenueWithdrawal = z.infer<typeof VenueWithdrawalSchema>;

export function venueWithdrawalBytes(w: VenueWithdrawal): Uint8Array {
  const x = VenueWithdrawalSchema.parse(w);
  const fields: [string, string][] = [
    ['v', '1'], ['withdrawalId', x.withdrawalId], ['keyId', x.keyId], ['venue', x.venue], ['network', x.network], ['account', x.account], ['destination', x.destination],
    ['amount', D.str(D.from(x.amount))], ['fee', D.str(D.from(x.fee))], ['time', String(x.time)], ['createdAt', String(x.createdAt)], ['expiresAt', String(x.expiresAt)],
  ];
  const parts: Uint8Array[] = [enc.encode('SPW-VENUE-WITHDRAW-v1'), new Uint8Array([0])];
  for (const [k, v] of fields) {
    const kb = enc.encode(k), vb = enc.encode(v), head = new Uint8Array(6);
    new DataView(head.buffer).setUint16(0, kb.length);
    new DataView(head.buffer).setUint32(2, vb.length);
    parts.push(head, kb, vb);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export const venueWithdrawalHash = (w: VenueWithdrawal): Uint8Array => sha256(venueWithdrawalBytes(w));

/** Structural validity at approval time. The signer additionally checks the key id, that account and destination are ITS OWN address, the passkey, replay and its daily count. */
export function validateVenueWithdrawal(w: VenueWithdrawal, nowSec: number): void {
  if (w.destination !== w.account) throw new Error('a withdrawal is paid to the wallet\'s own address only: any other destination is refused');
  if (D.str(D.from(w.fee)) !== HL_WITHDRAW_FEE_USDC) throw new Error(`the fee shown is not the venue's documented withdrawal fee (${HL_WITHDRAW_FEE_USDC} USDC)`);
  if (!D.gt(D.from(w.amount), D.from(w.fee))) throw new Error(`the amount must be greater than the venue's withdrawal fee (${HL_WITHDRAW_FEE_USDC} USDC): nothing would arrive`);
  if (w.expiresAt <= nowSec) throw new Error('approval window expired');
  if (w.createdAt > nowSec + 60) throw new Error('withdrawal dated in the future');
  if ((w.expiresAt - w.createdAt) * 1000 > HL_WITHDRAW_MAX_TTL_MS) throw new Error('approval window too long');
  // the venue's rule is "(T − 2 days, T + 1 day)"; the wallet is much stricter so that a signature cannot be kept for later
  const nowMs = nowSec * 1000;
  if (w.time > nowMs + 60_000) throw new Error('withdrawal time is dated in the future');
  if (w.time < nowMs - HL_WITHDRAW_MAX_TTL_MS) throw new Error('withdrawal time is stale');
}

export interface HlWithdrawBuilt { action: HlWithdraw3Action; typedData: HlTypedData; nonce: number }
/**
 * The ONE venue action a canonical withdrawal allows, built from the canonical object alone and read back field by field:
 * `withdraw3` to `own`, on the chain name of the withdrawal's network, with the SDK's signature chain id. `own` is given by
 * the caller from its own knowledge (the signer: its derived address), never taken from the withdrawal.
 */
export function buildVenueWithdraw(w: VenueWithdrawal, own: string): HlWithdrawBuilt {
  const me = String(own).toLowerCase();
  if (!ADDRESS.test(me)) throw new Error('own address is not an EVM address');
  if (w.account !== me || w.destination !== me) throw new Error('a withdrawal is paid to the wallet\'s own address only: any other destination is refused');
  const built = buildWithdraw3TypedDataOnly({ network: w.network, destination: me, amount: D.str(D.from(w.amount)), time: w.time });
  const m = built.typedData.message, a = built.action, chain = hlChainName(w.network);
  const ok = built.typedData.primaryType === HL_PRIMARY.withdraw && built.typedData.domain.name === 'HyperliquidSignTransaction' && built.typedData.domain.chainId === parseInt(HL_DEFAULT_SIGNATURE_CHAIN_ID, 16)
    && Object.keys(built.typedData.types).sort().join() === ['EIP712Domain', HL_PRIMARY.withdraw].sort().join()
    && Object.keys(m).join() === 'hyperliquidChain,destination,amount,time' && m.hyperliquidChain === chain && m.destination === me && m.amount === D.str(D.from(w.amount)) && m.time === w.time
    && Object.keys(a).join() === 'type,hyperliquidChain,signatureChainId,destination,amount,time' && a.type === 'withdraw3' && a.hyperliquidChain === chain && a.signatureChainId === HL_DEFAULT_SIGNATURE_CHAIN_ID
    && a.destination === me && a.amount === m.amount && a.time === w.time;
  if (!ok) throw new Error('the withdrawal action does not read back as expected');
  return { action: a, typedData: built.typedData, nonce: w.time };
}
