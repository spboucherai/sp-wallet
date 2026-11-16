// GMX v2 on Arbitrum (v8): the signer side. Docs: docs/v4/venues/gmx.md Part C.
//
// GMX has no venue account and no trading key: an order is a transaction of the MAIN wallet key. So everything goes through
// `Signer.sign` — passkey over the intent hash, policy (limits, fee ceiling, halt, window, allowlist), replay cache — and this
// file adds what a GMX order needs on top:
//   - the venue policy the owner approved ONCE with a passkey (`gmxAuthorize`: allowed markets, maximum leverage, maximum
//     order size, orders per day, price band, execution-fee ceiling, expiry, jurisdiction acknowledgement), stored here;
//   - the transaction is BUILT here from the intent (`buildGmxTxs`, @spw/derivatives/live): pinned ExchangeRouter, Router and
//     OrderVault; receiver = cancellation receiver = this wallet; no callback, no UI fee, no swap path, no referral code;
//   - the signer's OWN price (Coinbase + Kraken) bounds the acceptable price and values the collateral for the leverage check.
// There is no parameter through which another receiver, another contract or provider-built calldata could reach the key.
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { TransactionSerializableEIP1559 } from 'viem';
import type { Intent } from '@spw/core';
import {
  buildGmxTxs, GMX_PINNED_CONTRACTS, GMX_PINS, GMX_POLICY_BOUNDS, GmxAuthorizationSchema, gmxAuthorizationHash, gmxPolicyVerdict, gmxPriceFromRaw, gmxUsdFromRaw, hex, jurisdictionAckOf, validateGmxAuthorization,
  type GmxAuthorization,
} from '@spw/derivatives/live';
import type { VenueCtx } from './venue.ts';

/** `usage`: per UTC day — increases signed, and decreases + cancellations signed */
export interface StoredGmxAuthorization { authorization: GmxAuthorization; hash: string; approvedAt: string; revoked: boolean; revokedAt?: string; usage: Record<string, { increases: number; reduces: number }> }
/** what `Signer.sign` signs with the wallet key after the passkey, and the bookkeeping to do first */
export interface GmxReady { approve: TransactionSerializableEIP1559 | null; main: TransactionSerializableEIP1559; /** counts the action and journals it; called once, right before signing */ commit(txid: string): void;
  /** what the transaction BUILT HERE does (V11: the halt lets a decrease or a cancellation through, never an increase) */ action: 'increase' | 'decrease' | 'cancel'; /** true when the built transaction can only reduce risk: a MarketDecrease or a cancelOrder, no token leaves, no approval */ reducesOnly: boolean }
const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const lc = (s: string) => s.toLowerCase();

export function gmxStatus(ctx: VenueCtx) {
  const now = ctx.now(), today = day(now);
  return Object.values(ctx.store.state.gmx ?? {}).map((r) => ({ authorization: r.authorization, hash: r.hash, approvedAt: r.approvedAt, revoked: r.revoked, revokedAt: r.revokedAt ?? null,
    expired: now >= r.authorization.expiresAt, current: r.authorization.contracts === GMX_PINS.id, today: r.usage[today] ?? { increases: 0, reduces: 0 } }));
}

/** The owner enables GMX trading: passkey assertion over the canonical authorization. Nothing is signed for the chain here. */
export async function gmxAuthorize(ctx: VenueCtx, raw: unknown, assertion: AuthenticationResponseJSON | undefined): Promise<{ authorizationId: string; hash: string }> {
  const st = ctx.store, now = ctx.now();
  const parsed = GmxAuthorizationSchema.safeParse(raw);
  if (!parsed.success) throw ctx.fail('bad_request', 'malformed GMX authorization');
  const a = parsed.data, hash = gmxAuthorizationHash(a), id = a.authorizationId;
  const deny = (code: string, msg: string): never => { st.log('gmx.authorize.denied', { authorizationId: id, code, msg: msg.slice(0, 300) }); st.save(); throw ctx.fail(code, msg); };
  if (st.state.halted) deny('policy', 'emergency halt is active');
  if (a.keyId !== ctx.keys.keyId) deny('wrong_key', 'authorization targets another key');
  if (a.account !== lc(ctx.keys.addresses.evm) || lc(ctx.keys.addresses[GMX_PINS.network] ?? '') !== a.account) deny('wrong_source', 'the account is not this wallet\'s own address');
  try { validateGmxAuthorization(a, now); } catch (e) { deny('unsupported', (e as Error).message); }
  if (st.policy.maxFee[GMX_PINS.network] === undefined) deny('policy', 'no fee ceiling in the policy for Arbitrum');
  if (st.state.gmx?.[id]) deny('replay', 'authorization already recorded');
  for (const r of Object.values(st.state.gmx ?? {})) if (!r.revoked && now < r.authorization.expiresAt) deny('conflict', 'another GMX authorization is active: revoke it first');
  if (!jurisdictionAckOf('gmx', a.ackSha256)) deny('acknowledgement', 'the acknowledgement hash is not the hash of the GMX jurisdiction summary this signer knows');
  if (!assertion) deny('bad_approval', 'the owner\'s passkey approval is required');
  try { await ctx.verify(assertion!, hash); } catch (e) { deny((e as { code?: string }).code ?? 'bad_approval', (e as Error).message); }
  (st.state.gmx ??= {})[id] = { authorization: a, hash: hex(hash), approvedAt: new Date(now * 1000).toISOString(), revoked: false, usage: {} };
  st.log('gmx.authorized', { authorizationId: id, hash: hex(hash), account: a.account, contracts: a.contracts, exchangeRouter: a.exchangeRouter, policy: a.policy, expiresAt: a.expiresAt, ackSha256: a.ackSha256 });
  st.save();
  return { authorizationId: id, hash: hex(hash) };
}

/** Stopping never needs a passkey. A revoked authorization signs nothing, ever again. */
export function gmxRevoke(ctx: VenueCtx, authorizationId: string): { revoked: true; revokedAt: string } {
  const r = ctx.store.state.gmx?.[authorizationId];
  if (!r) throw ctx.fail('not_found', 'unknown GMX authorization');
  if (!r.revoked) { r.revoked = true; r.revokedAt = new Date(ctx.now() * 1000).toISOString(); ctx.store.log('gmx.revoked', { authorizationId }); ctx.store.save(); }
  return { revoked: true, revokedAt: r.revokedAt! };
}

/**
 * Called by `Signer.sign` for EVERY intent, before the policy and the passkey: an intent WITHOUT the `gmx` section that pays a
 * pinned GMX contract is refused (tokens sent straight to the OrderVault belong to whoever creates the next order).
 */
export function gmxPlainVerdict(i: Intent): string | null {
  if (i.gmx || i.network !== GMX_PINS.network) return null;
  return GMX_PINNED_CONTRACTS.some((c) => lc(GMX_PINS[c].address) === lc(i.to)) ? 'this destination is a GMX contract: funds reach GMX only through a GMX order, which the signer builds itself' : null;
}

/**
 * Everything a GMX intent must pass BEFORE the passkey is looked at: an active authorization for the reviewed contract set,
 * the transaction rebuilt from the intent, the venue policy with the signer's own prices. Returns the transactions to sign and
 * the bookkeeping `Signer.sign` runs after the passkey. This file never touches a key. Throws `ctx.fail(code, reason)`;
 * nothing is recorded on refusal by this function.
 */
export async function gmxPrepare(ctx: VenueCtx, i: Intent, own: string): Promise<GmxReady> {
  const st = ctx.store, now = ctx.now(), g = i.gmx!;
  const rec = st.state.gmx?.[g.authorizationId];
  if (!rec) throw ctx.fail('not_authorized', 'GMX trading is not authorized on this signer: the owner must approve a venue policy first');
  const a = rec.authorization;
  if (rec.revoked) throw ctx.fail('revoked', 'the GMX authorization was revoked');
  if (now >= a.expiresAt) throw ctx.fail('expired', 'the GMX authorization expired');
  if (a.account !== lc(own)) throw ctx.fail('wrong_source', 'the authorization is not for this wallet');
  if (a.contracts !== GMX_PINS.id || a.exchangeRouter !== GMX_PINS.exchangeRouter.address) throw ctx.fail('contract_changed', 'the authorization was given for another GMX contract set than the one this signer pins: a new review and a new authorization are needed');
  let built: ReturnType<typeof buildGmxTxs>;
  try { built = buildGmxTxs(i, own); } catch (e) { throw ctx.fail('unsupported', (e as Error).message); }
  const plan = built.plan, today = day(now), usage = rec.usage[today] ?? { increases: 0, reduces: 0 };
  let px: { index: number; collateral: number } | null = null, mid: string | null = null;
  if (plan.action !== 'cancel') {
    const m = plan.market!, c = plan.collateral!;
    try { const got = await ctx.prices.get([m.priceSymbol, c.priceSymbol]); px = { index: got[m.priceSymbol]!, collateral: got[c.priceSymbol]! }; mid = px.index.toFixed(8); }
    catch (e) { throw ctx.fail('no_price', `the signer could not establish its own market price for ${m.priceSymbol} / ${c.priceSymbol} (${(e as Error).message.slice(0, 80)}); order refused`); }
  }
  const verdict = gmxPolicyVerdict(a.policy, plan, px);
  if (verdict) throw ctx.fail(verdict === 'no price' ? 'no_price' : /acceptable price/.test(verdict) ? 'price' : 'policy', verdict);
  if (plan.action === 'increase' ? usage.increases >= a.policy.maxOrdersPerDay : usage.reduces >= GMX_POLICY_BOUNDS.reduceActionsPerDay) throw ctx.fail('policy', 'daily order count reached');

  // established from the plan the builder derived and the transactions it produced — not from a flag: no collateral amount, no
  // token approval, and (for an order) the MarketDecrease parameters; a cancellation only returns an order's collateral to the wallet
  const reducesOnly = plan.action !== 'increase' && plan.amount === 0n && built.approve === null && (plan.action === 'cancel' ? plan.orderKey !== null && plan.params === null : i.gmx!.orderType === 'MarketDecrease');
  return { approve: built.approve, main: built.main, action: plan.action, reducesOnly, commit: (txid) => {
    // counted and journaled before the signature leaves; `Signer.sign` saves the store before it returns
    if (plan.action === 'increase') usage.increases += 1; else usage.reduces += 1;
    rec.usage[today] = usage;
    for (const d of Object.keys(rec.usage)) if (d < day(now - 3 * 86400)) delete rec.usage[d];
    st.log('gmx.sign.ok', { proposalId: i.proposalId, authorizationId: g.authorizationId, action: plan.action, market: plan.market?.name ?? null, isLong: plan.isLong, collateral: plan.collateral?.symbol ?? null, amount: plan.amount.toString(),
      sizeDeltaUsd: gmxUsdFromRaw(plan.sizeDeltaUsd), acceptablePrice: plan.market ? gmxPriceFromRaw(plan.acceptablePrice, plan.market.indexDecimals) : null, executionFee: plan.executionFee.toString(), orderKey: plan.orderKey,
      signerPrice: mid, approval: !!built.approve, txid });
  } };
}
