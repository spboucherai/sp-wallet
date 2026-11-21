/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/src/venue-collateral.ts
 * Module           : services
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

// Collateral of a venue account (Hyperliquid): the signer side of DEPOSIT and WITHDRAW. Docs: docs/v4/venues/hyperliquid.md
// section 15, docs/v4/DERIVATIVES-ARCHITECTURE.md ("Signing").
//
// DEPOSIT is an ordinary wallet intent (`Signer.sign`: passkey over the intent hash, per-transfer and daily limits, fee ceiling,
// allowlist, replay cache — all unchanged) carrying a `venueDeposit` section. `venueDepositVerdict` adds what a free-form send
// lacks: the destination must be the bridge contract PINNED in this bundle, the chain and the token the pinned ones (native
// USDC), the amount at least the wallet's floor above the venue minimum (below it the venue credits nothing and the money is
// lost). And an intent WITHOUT the section that pays a venue bridge is refused, so the minimum cannot be bypassed by a plain send.
//
// WITHDRAW is the second — and last — kind of venue message the MAIN wallet key signs (the first is `approveAgent`, venue.ts):
// Hyperliquid's user-signed `withdraw3`, built HERE from the canonical withdrawal, only after the owner's passkey approved that
// canonical object, and only with `destination` = this signer's own address. There is no parameter through which another
// destination, another action (`usdSend`, `spotSend`, `sendAsset`, `usdClassTransfer`, `approveAgent` …) or another chain name
// could reach the key: nothing received is signed, only what `buildVenueWithdraw` produced and read back.
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { sign } from 'viem/accounts';
import { cctpUsdc, type Intent } from '@spw/core';
import {
  buildVenueWithdraw, checkVenueDepositIntent, hex, HL_WITHDRAWALS_PER_DAY, signatureFromHex, typedDataDigest, validateVenueWithdrawal, venueWithdrawalHash, VenueWithdrawalSchema,
  type HlSignature, type HlWithdrawBuilt, type VenueWithdrawal,
} from '@spw/derivatives/live';
import type { VenueCtx } from './venue.ts';

/** `time` is the venue nonce of the main key for this action; records are kept 30 days (the venue refuses a nonce older than 2 days) */
export interface StoredVenueWithdrawal { withdrawal: VenueWithdrawal; hash: string; signedAt: number; action: HlWithdrawBuilt['action']; signature: HlSignature }
export interface VenueWithdrawResult { withdrawalId: string; hash: string; action: HlWithdrawBuilt['action']; signature: HlSignature; nonce: number; signer: string }
const KEEP_SEC = 30 * 86400;
const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * Called by `Signer.sign` for EVERY intent, before the policy and the passkey. Returns null when the intent may proceed (not a
 * venue deposit and not addressed to a venue bridge, or a venue deposit that matches the pinned table), otherwise the reason.
 */
export function venueDepositVerdict(i: Intent, own: string): string | null {
  try {
    const pin = checkVenueDepositIntent(i, own);
    if (!pin) return null;
    // the pinned token must be the registry's native USDC of that network: two tables, one answer
    if (cctpUsdc(pin.network).id !== pin.usdc) return 'the pinned token is not the registry\'s native USDC on this network';
    if (!i.evm) return 'a venue deposit is an EVM transfer';
    return null;
  } catch (e) { return (e as Error).message; }
}

/**
 * Sign ONE withdrawal from the venue to the wallet's own address. Passkey assertion over the canonical withdrawal; the action
 * is built here from that object alone. The counters and the record are durable before the signature is returned.
 */
export async function venueWithdraw(ctx: VenueCtx, raw: unknown, assertion: AuthenticationResponseJSON | undefined): Promise<VenueWithdrawResult> {
  const st = ctx.store, now = ctx.now();
  const parsed = VenueWithdrawalSchema.safeParse(raw);
  if (!parsed.success) throw ctx.fail('bad_request', 'malformed venue withdrawal');
  const w: VenueWithdrawal = parsed.data, hash = venueWithdrawalHash(w), id = w.withdrawalId, own = ctx.keys.addresses.evm.toLowerCase();
  const deny = (code: string, msg: string): never => { st.log('venue.withdraw.denied', { withdrawalId: id, venue: w.venue, network: w.network, amount: w.amount, destination: w.destination, code, msg: msg.slice(0, 300) }); st.save(); throw ctx.fail(code, msg); };
  if (st.state.halted) deny('policy', 'emergency halt is active');
  if (w.keyId !== ctx.keys.keyId) deny('wrong_key', 'withdrawal targets another key');
  if (w.account !== own) deny('wrong_source', 'the venue account is not this wallet\'s own address');
  if (w.destination !== own) deny('wrong_destination', 'a withdrawal is paid to the wallet\'s own address only: any other destination is refused');
  try { validateVenueWithdrawal(w, now); } catch (e) { deny(/expired|stale|future|window/.test((e as Error).message) ? 'policy' : 'unsupported', (e as Error).message); }
  const all = (st.state.venueWithdrawals ??= {});
  if (all[id]) deny('replay', 'withdrawal already signed');
  const mine = Object.values(all).filter((r) => r.withdrawal.network === w.network);
  // the venue nonce of the main key only moves forward here: an older or equal `time` is never signed again
  if (mine.some((r) => r.withdrawal.time >= w.time)) deny('stale_nonce', 'a withdrawal with the same or a later time was already signed');
  if (Object.values(all).filter((r) => day(r.signedAt) === day(now)).length >= HL_WITHDRAWALS_PER_DAY) deny('policy', 'daily withdrawal count reached');

  let built: HlWithdrawBuilt;
  try { built = buildVenueWithdraw(w, own); } catch (e) { return deny('unsupported', (e as Error).message); }

  if (!assertion) deny('bad_approval', 'the owner\'s passkey approval is required');
  try { await ctx.verify(assertion!, hash); } catch (e) { deny((e as { code?: string }).code ?? 'bad_approval', (e as Error).message); }

  const signature = signatureFromHex(await sign({ hash: typedDataDigest(built.typedData), privateKey: `0x${Buffer.from(ctx.keys.evmPriv).toString('hex')}`, to: 'hex' }));
  for (const [k, r] of Object.entries(all)) if (r.signedAt + KEEP_SEC < now) delete all[k];
  all[id] = { withdrawal: w, hash: hex(hash), signedAt: now, action: built.action, signature };
  st.log('venue.withdraw.ok', { withdrawalId: id, hash: hex(hash), venue: w.venue, network: w.network, account: w.account, destination: built.action.destination, amount: built.action.amount, fee: w.fee, time: w.time });
  st.save(); // durable before the signature leaves
  return { withdrawalId: id, hash: hex(hash), action: built.action, signature, nonce: built.nonce, signer: own };
}
