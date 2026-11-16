// Server-authored sentences as CODES + PARAMETERS (v11, audit finding B3).
//
// Everything the owner reads that the server writes into a stored row (a proposal's `error`, a bridge or native-swap hold,
// a plan pause) is one entry of this catalogue. The server stores the code and its parameters next to the English sentence;
// the web app translates the code (`sv_<code>` in apps/web/src/i18n.ts — a test checks the two lists match) and API clients
// keep reading the English sentence as `message` / `error`. Pure data and pure functions: no I/O, importable from tests.
export type SvParams = Record<string, string | number>;

export const SV = {
  // ── proposal outcome (proposals.error / error_code) ──────────────────────────────────────────────────────────────────
  broadcast_disabled: 'signed but NOT broadcast: broadcasting is disabled on this server (SPW_BROADCAST=off); nothing was sent to the network',
  approval_expired: 'approval window expired',
  expired_before_approval: 'expired before approval',
  interrupted_signing: 'interrupted during signing; nothing was broadcast',
  not_broadcast_in_time: 'could not be broadcast in time; nothing was sent',
  rejected_by_owner: 'rejected by owner',
  signer_refused: 'the signer refused: {detail}',
  signer_hash_mismatch: 'signer hash mismatch',
  broadcast_attempt_failed: 'broadcast attempt failed: {detail}',
  tx_failed: 'the transaction failed on-chain: {detail}',
  swap_late: 'the swap could not be sent in time; nothing was swapped',
  swap_approval_reverted: 'the token approval reverted; nothing was swapped',
  swap_would_revert: 'the swap would revert now ({detail}); it was not sent',
  swap_would_revert_approved: 'the swap would revert now ({detail}); it was not sent. The exact-amount approval stays in place for the next attempt',
  bridge_late: 'the transfer could not be sent in time; nothing was burned',
  bridge_approval_reverted: 'the token approval reverted; nothing was burned',
  burn_would_revert: 'the burn would revert now ({detail}); it was not sent',
  burn_would_revert_approved: 'the burn would revert now ({detail}); it was not sent. The exact-amount approval stays in place for the next attempt',
  xswap_late: 'the swap could not be sent in time; nothing was sent to the vault',
  xswap_vault_unconfirmed: 'the vault is no longer confirmed ({detail}); nothing was sent to it',
  xswap_approval_reverted: 'the token approval reverted; nothing was sent to the vault',
  deposit_would_revert: 'the deposit would revert now ({detail}); it was not sent',
  deposit_would_revert_approved: 'the deposit would revert now ({detail}); it was not sent. The exact-amount approval of the router stays in place; only this wallet can use it',
  sol_swap_unverified: 'the stored swap no longer verifies; it was not sent',
  sol_swap_expired: 'the swap expired before it could be sent (blockhash too old); nothing was swapped',
  sol_swap_refused: 'the node refused the signed swap ({detail}); it was not sent',
  sol_swap_would_fail: 'the swap would fail now ({detail}); it was not sent',
  sol_swap_below_min: 'the swap no longer delivers the approved minimum in simulation; it was not sent',
  sol_swap_no_balances: 'the node did not report the simulated balances; the swap was not sent',
  sol_burn_mismatch: 'the signer returned a transaction that is not the approved burn; it was not sent',
  sol_burn_expired: 'the transfer expired before it could be sent (blockhash too old); nothing was burned',
  sol_burn_refused: 'the node refused the signed burn ({detail}); it was not sent',
  sol_burn_would_fail: '{detail}; it was not sent',

  // ── CCTP hold detail (bridge.hold is the code; these are the detail sentences, keyed `hold_<hold>`) ───────────────────
  hold_destination_busy: 'another transaction is in flight on {net}',
  hold_destination_pending: 'a previous transaction is still pending on {net}',
  hold_mint_would_fail: 'the mint would revert on {net} now: {detail}',
  hold_fee_above_policy: 'the network fee on {net} is above the signer\'s fee ceiling right now',
  hold_destination_gas: 'add {sym} on {net}: {need} is needed to receive the USDC, the wallet holds {have}',
  hold_attestation_late: 'Circle has not attested this burn yet. The funds are not lost: the mint stays possible whenever the attestation arrives',
  hold_message_mismatch: 'Circle\'s answer does not describe the approved transfer ({detail}); it was not used',
  hold_attestation_expired: 'the Fast attestation expired; a new one was requested from Circle',
  hold_mint_reverted: 'the mint transaction reverted on {net}; the USDC is still waiting. Approve a new attempt with the passkey',
  hold_mint_replaced: 'another transaction took the place of the mint on {net}; the USDC is still waiting. Approve a new attempt with the passkey',
  hold_mint_expired: 'the mint transaction was not included in time on {net}; the USDC is still waiting. Approve a new attempt with the passkey',
  hold_technical: '{detail}',

  // ── THORChain hold detail (xswap.hold is the code) ────────────────────────────────────────────────────────────────────
  hold_vault_churned: 'the vault is no longer confirmed as active and the transaction is not confirmed yet. It cannot be cancelled; THORChain still watches a retiring vault, but this is not guaranteed',
  hold_not_observed: 'THORChain has not reported this deposit yet. Nothing is marked as received until the wallet sees the outbound transaction itself',
  hold_outbound_late: 'THORChain has observed the deposit but has not sent the outbound transaction yet',
  hold_outbound_mismatch: 'the outbound transaction THORChain names does not pay this wallet what was expected; it is not counted as received',
  hold_below_minimum: 'the amount received is below the approved minimum',
  hold_outbound_not_seen: 'THORChain reports an outbound transaction that the wallet\'s own data sources do not show as confirmed yet',

  // ── plan pause / leg outcome (plans.meta.pause.code is the pause code; `reason` carries one of the codes above or these) ──
  plan_no_funds: 'the wallet no longer holds the {sym} of this plan on {net}',
  plan_floor: 'the final result estimated now is {estimate} {sym}, below the floor of {floor}. Nothing was prepared; the funds are where they were',
  plan_proposal_gone: 'the proposal of this step no longer exists',
  plan_replaced: 'replaced by a fresh preparation',
  plan_withdrawn: 'withdrawn: the plan was stopped',
  plan_refunded: 'THORChain refunded the swap: the source asset came back to the wallet, less the network fees',
  plan_tx_ended: 'the transaction {state}',
} as const;
export type SvCode = keyof typeof SV;

/** The English sentence of a code. An unknown parameter stays as `{name}` rather than being invented. */
export function svText(code: SvCode, params: SvParams = {}): string {
  return SV[code].replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m));
}
export const isSvCode = (c: unknown): c is SvCode => typeof c === 'string' && Object.hasOwn(SV, c);

/** A hold as stored and shown: the hold code, its detail code and parameters, and the English detail for API clients. */
export interface SvHold { hold: string; holdCode: SvCode; holdParams: SvParams; holdDetail: string }
export function svHold(hold: string, holdCode: SvCode, params: SvParams = {}): SvHold {
  return { hold, holdCode, holdParams: params, holdDetail: svText(holdCode, params).slice(0, 300) };
}
/** A free technical message (an RPC error, a signer refusal) as a hold detail: the text is DATA inside a translated sentence. */
export const svTechnical = (hold: string, detail: string): SvHold => svHold(hold, 'hold_technical', { detail: detail.slice(0, 240) });
