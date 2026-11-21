/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/mockCollateral.ts
 * Module           : derivatives
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

/**
 * Browser mock of the collateral routes (deposit / withdraw) — development and browser tests only, loaded with the rest of the
 * mock (`?mock=1`), never part of a production build. It answers with the shapes of services/api/src/derivatives/collateral.ts.
 *
 * REAL in it: the pinned route table, the floor and the fee, the canonical withdrawal and its hash, the `withdraw3` action
 * (`buildVenueWithdraw`), the passkey challenge check, the order of the refusals.
 * NOT real: there is no chain, no venue and no signer. Time does the work of the network: a deposit is "confirmed" after
 * 1.2 s and "credited" after `creditMs` more (or never); a withdrawal "arrives" after `payoutMs`. The deposit's hash is a
 * SHA-256 over the mock's own encoding, not the wallet's intent hash (the core package is not loaded in the browser).
 */
import {
  buildVenueWithdraw, HL_BRIDGE_PINS, HL_COLLATERAL_PINNED_AT, HL_DEPOSIT_FLOOR_USDC, HL_DEPOSIT_MIN_USDC, HL_DEPOSIT_ROUTE, HL_WITHDRAW_FEE_USDC, usdcDecimal, usdcUnits, venueDepositSection, venueWithdrawalHash,
  type VenueWithdrawal,
} from '../../../../packages/derivatives/src/live/collateral.ts';
import { hex } from '../../../../packages/derivatives/src/live/canonical.ts';

type Net = 'testnet' | 'mainnet';
export interface MockAcct { id: string; network: Net; account: string }
export interface CollateralMockEnv {
  now: () => number; mainnet: () => boolean; keyId: string;
  /** what the simulated venue holds for the account: equity and withdrawable, null when the venue cannot be read */
  balance: (a: MockAcct) => { equity: string; withdrawable: string } | null;
  /** the simulated venue credits (+) or debits (−) the account */
  move: (a: MockAcct, deltaUsdc: string) => void;
  options: (hashHex: string) => unknown;
  /** the simulated signer's passkey check: null when the assertion carries this hash */
  refusal: (assertion: unknown, hashHex: string) => Error | null;
  refuse: (code: string, message: string, status: number) => Error;
}
export interface CollateralHooks {
  /** USDC of the wallet on Arbitrum, and what it holds on other networks */ wallet: (usdc: string, elsewhere?: { network: string; name: string; usdc: string }[]) => void;
  /** ms between the on-chain confirmation and the venue's credit; null = the credit never comes */ creditAfter: (ms: number | null) => void;
  /** ms between the venue's acceptance and the arrival on the wallet; null = never */ payoutAfter: (ms: number | null) => void;
  /** the next deposit is treated as sent this long ago (to show the overdue state) */ age: (ms: number) => void;
}
interface Op { id: string; account: string; kind: 'deposit' | 'withdraw'; amount: bigint; hash: string; createdAt: number; expiresAt: number; approvedAt: number | null; state: string; final: boolean; error: string | null;
  before: number; after: number | null; settled: boolean; txid: string | null; withdrawal?: VenueWithdrawal; creditMs: number | null; payoutMs: number | null; venueAt: number | null }

export function createCollateralMock(env: CollateralMockEnv) {
  const pin = HL_BRIDGE_PINS.mainnet!, OPS: Op[] = [];
  let USDC = usdcUnits('40'), ELSE: { network: string; name: string; usdc: string }[] = [], CREDIT: number | null = 2500, PAYOUT: number | null = 3000, AGE = 0, SPENT = 0n;
  const u = (x: bigint) => usdcDecimal(x), PER_TX = usdcUnits('50'), PER_DAY = usdcUnits('100'), FLOOR = usdcUnits(HL_DEPOSIT_FLOOR_USDC), FEE = usdcUnits(HL_WITHDRAW_FEE_USDC);
  const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  const bal = (a: MockAcct) => { const b = env.balance(a); return { abstraction: 'default', equity: b?.equity ?? null, withdrawable: b?.withdrawable ?? null, spotUsdc: null, total: b?.equity ?? null, error: b ? null : 'hyperliquid: request timed out after 8000 ms', ts: env.now() }; };
  const num = (x: string | null) => (x === null ? 0 : Number(x));

  /** time moves an operation forward: read on every request, like the backend re-reads the venue and the chain */
  function advance(o: Op, a: MockAcct): void {
    const now = env.now();
    if (o.final) return;
    if (o.approvedAt === null) { if (now > o.expiresAt) { o.state = 'expired'; o.final = true; o.error = 'expired before approval; nothing was signed'; } return; }
    const since = now - o.approvedAt;
    if (o.kind === 'deposit') {
      o.state = since < 1200 ? 'sent' : 'awaiting_credit';
      if (o.creditMs !== null && since >= 1200 + o.creditMs) { if (!o.settled) { env.move(a, u(o.amount)); o.settled = true; } o.state = 'credited'; o.final = true; o.venueAt = now; o.after = num(env.balance(a)?.equity ?? null); }
    } else {
      o.state = 'submitted';
      if (o.payoutMs !== null && since >= o.payoutMs) { if (!o.settled) { USDC += o.amount - FEE; o.settled = true; } o.state = 'completed'; o.final = true; o.venueAt = now; o.after = num(env.balance(a)?.equity ?? null); o.txid = `0x${rnd(32)}`; }
    }
  }
  function view(o: Op) {
    const now = env.now(), sent = o.approvedAt, dep = o.kind === 'deposit';
    const overdue = !o.final && sent !== null && (dep ? o.state === 'awaiting_credit' && now - sent > 600_000 : o.state === 'submitted' && now - sent > 900_000);
    const b = (v: number | null) => (v === null ? null : { abstraction: 'default', equity: String(v), withdrawable: String(v), spotUsdc: null, total: String(v), error: null, ts: now });
    return { id: o.id, kind: o.kind, state: o.state, final: o.final, venueNetwork: 'mainnet', amount: u(o.amount), asset: 'USDC', fee: dep ? null : HL_WITHDRAW_FEE_USDC, expectedReceive: dep ? null : u(o.amount - FEE),
      chainNetwork: 'arbitrum', chainNetworkName: 'Arbitrum One', bridge: dep ? pin.bridge : null, txid: o.txid, explorer: o.txid ? `https://arbiscan.io/tx/${o.txid}` : null, hash: o.hash, proposalId: null, proposalState: null, confirmations: null,
      createdAt: o.createdAt, expiresAt: o.expiresAt, sentAt: sent, venueAt: o.venueAt, doneAt: o.final ? o.venueAt ?? now : null, checkedAt: now, expectedSeconds: dep ? 60 : 240, overdue,
      check: overdue ? (dep ? ['tx_success', 'tx_to_bridge', 'amount_min', 'venue_ledger', 'venue_status'] : ['venue_ledger', 'bridge_paused', 'wallet_scan', 'venue_status']) : [],
      balanceBefore: b(o.before), balanceAfter: b(o.after), ledger: o.final && o.venueAt ? { time: o.venueAt, hash: o.txid ?? '', type: dep ? 'deposit' : 'withdraw', usdc: dep ? u(o.amount) : u(o.amount - FEE), fee: dep ? null : '1.0' } : null,
      arrival: !dep && o.state === 'completed' ? { txid: o.txid!, amount: (o.amount - FEE).toString(), seenAt: o.venueAt! } : null, venueAnswer: null, error: o.error, attempts: sent === null ? 0 : 1, arrivalTracked: dep ? null : true };
  }
  const mine = (a: MockAcct) => OPS.filter((o) => o.account === a.id);
  const find = (a: MockAcct, id: string, kind?: string) => { const o = mine(a).find((x) => x.id === id && (!kind || x.kind === kind)); if (!o) throw env.refuse('unknown_operation', 'unknown collateral operation', 404); advance(o, a); return o; };
  const needMainnet = (a: MockAcct) => { if (a.network === 'mainnet' && !env.mainnet()) throw env.refuse('mainnet_disabled', 'moving collateral on Hyperliquid MAINNET is disabled on this server (SPW_DERIV_LIVE_MAINNET is not "on"): nothing was built, signed or sent', 403); };
  const amountOf = (b: any): bigint => { if (typeof b?.amount !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(b.amount) || Object.keys(b).length !== 1) throw env.refuse('bad_request', 'invalid request', 400); return usdcUnits(b.amount); };

  function handle(method: string, rest: string, body: any, a: MockAcct): unknown {
    const main = a.network === 'mainnet', now = env.now();
    for (const o of mine(a)) advance(o, a);
    if (rest === '/status' && method === 'GET') {
      const room = PER_DAY > SPENT ? PER_DAY - SPENT : 0n, maxNow = [PER_TX, room, USDC].reduce((x, y) => (y < x ? y : x));
      const reason = !main ? 'no_route' : !env.mainnet() ? 'mainnet_disabled' : USDC < FLOOR ? (ELSE.length ? 'usdc_elsewhere' : 'no_usdc') : room < FLOOR ? 'limit_reached' : null, b = bal(a);
      return { account: a.account, accountId: a.id, venue: 'hyperliquid', network: a.network, mainnetEnabled: env.mainnet(), venueBalance: b,
        route: main ? { id: HL_DEPOSIT_ROUTE, network: 'arbitrum', networkName: 'Arbitrum One', bridge: pin.bridge, bridgeExplorer: `https://arbiscan.io/address/${pin.bridge}`, asset: 'USDC', token: pin.usdc, venueMinimum: HL_DEPOSIT_MIN_USDC,
          minimum: HL_DEPOSIT_FLOOR_USDC, expectedSeconds: 60, credits: 'sender', venueFee: '0', legacy: true, pinnedAt: HL_COLLATERAL_PINNED_AT, codeSha256: pin.codeSha256 } : null,
        withdrawal: { fee: HL_WITHDRAW_FEE_USDC, expectedSeconds: 240, destination: a.account, payoutNetworkName: main ? 'Arbitrum One' : 'Arbitrum Sepolia', arrivalTracked: main, available: b.withdrawable },
        wallet: main ? { address: a.account, network: 'arbitrum', networkName: 'Arbitrum One', usdc: u(USDC), gas: '0.002', gasSymbol: 'ETH', limits: { perTransfer: u(PER_TX), perDay: u(PER_DAY), spentToday: u(SPENT), maxNow: u(maxNow) }, elsewhere: USDC < FLOOR ? ELSE : [] } : null,
        walletError: null, deposit: { available: reason === null, reason, bridgeFrom: USDC < FLOOR ? ELSE : [] },
        withdraw: { available: !(main && !env.mainnet()) && !b.error, reason: main && !env.mainnet() ? 'mainnet_disabled' : b.error ? 'venue_unreadable' : null },
        operations: [...mine(a)].reverse().slice(0, 20).map(view), ts: now };
    }
    let m = /^\/operations\/([0-9a-f-]{36})(\/cancel)?$/.exec(rest);
    if (m) {
      const o = find(a, m[1]!);
      if (m[2]) { if (o.state !== 'pending_approval') throw env.refuse('bad_state', `the operation is ${o.state}: it can no longer be cancelled here`, 409); o.state = 'cancelled'; o.final = true; o.error = 'cancelled before approval; nothing was signed'; }
      return { operation: view(o) };
    }
    if (rest === '/deposit/prepare') {
      if (!main) throw env.refuse('no_route', 'no deposit route exists in this wallet for Hyperliquid testnet: testnet collateral is mock USDC from the venue\'s faucet', 422);
      needMainnet(a);
      const amount = amountOf(body);
      if (amount < FLOOR) throw env.refuse('below_minimum', `the smallest deposit is ${HL_DEPOSIT_FLOOR_USDC} USDC: the venue credits nothing under ${HL_DEPOSIT_MIN_USDC} USDC and such a transfer would be lost`, 422);
      if (mine(a).some((o) => o.kind === 'deposit' && !o.final && o.state !== 'pending_approval')) throw env.refuse('deposit_in_progress', 'a deposit is already on its way to the venue; wait for the credit before sending another', 409);
      if (USDC < amount) throw env.refuse('insufficient_usdc', `the wallet holds ${u(USDC)} USDC on Arbitrum One`, 422);
      if (amount > PER_TX || SPENT + amount > PER_DAY) throw env.refuse('policy', 'amount above per-transaction limit for arbitrum:USDC', 422);
      for (const o of mine(a)) if (o.kind === 'deposit' && o.state === 'pending_approval') { o.state = 'cancelled'; o.final = true; }
      const t = Math.floor(now / 1000);
      const intent = { v: 1, proposalId: crypto.randomUUID(), keyId: env.keyId, network: 'arbitrum', chainRef: '42161', asset: pin.usdc, symbol: 'USDC', decimals: 6, amount: amount.toString(), from: a.account, to: pin.bridge, maxFee: '9000000000000',
        createdAt: t, expiresAt: t + 180, policyVersion: 4, venueDeposit: venueDepositSection('mainnet'), evm: { nonce: 7, gasLimit: '90000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' } };
      const before = num(env.balance(a)?.equity ?? null);
      // NOT the wallet's intent hash (see the header): a hash of this mock's own bytes, enough to bind the simulated passkey
      const hash = hex(venueWithdrawalHash({ v: 1, withdrawalId: intent.proposalId, keyId: env.keyId, venue: 'hyperliquid', network: 'mainnet', account: a.account, destination: a.account, amount: u(amount), fee: '1', time: now, createdAt: t, expiresAt: t + 180 }));
      const o: Op = { id: crypto.randomUUID(), account: a.id, kind: 'deposit', amount, hash, createdAt: now, expiresAt: now + 180_000, approvedAt: null, state: 'pending_approval', final: false, error: null, before, after: null, settled: false,
        txid: null, creditMs: CREDIT, payoutMs: null, venueAt: null };
      OPS.push(o);
      return { operation: view(o), intent, route: { network: 'arbitrum', networkName: 'Arbitrum One', bridge: pin.bridge, minimum: HL_DEPOSIT_FLOOR_USDC, venueMinimum: HL_DEPOSIT_MIN_USDC, expectedSeconds: 60 },
        fee: { estimate: '0.0000045', max: '0.000009', symbol: 'ETH' }, liveness: { ok: true, checkedAt: now, checked: 3, credited: 3, detail: 'mock: 3 of the 3 most recent deposits into the bridge are in the venue\'s ledger', samples: [] },
        venueBalance: bal(a), options: env.options(hash) };
    }
    m = /^\/deposit\/([0-9a-f-]{36})\/approve$/.exec(rest);
    if (m) {
      needMainnet(a);
      const o = find(a, m[1]!, 'deposit');
      if (o.state !== 'pending_approval') throw env.refuse(o.state === 'expired' ? 'expired' : 'bad_state', `the deposit is ${o.state}`, o.state === 'expired' ? 410 : 409);
      const no = env.refusal(body?.assertion, o.hash);
      if (no) { o.state = 'failed'; o.final = true; o.error = `the signer refused: ${no.message}. Nothing was signed or sent.`; throw no; }
      o.approvedAt = now - AGE; AGE = 0; o.txid = `0x${rnd(32)}`; USDC -= o.amount; SPENT += o.amount;
      advance(o, a);
      return { operation: view(o) };
    }
    if (rest === '/withdraw/prepare') {
      needMainnet(a);
      const amount = amountOf(body), b = env.balance(a);
      if (amount <= FEE) throw env.refuse('below_fee', `the venue keeps ${HL_WITHDRAW_FEE_USDC} USDC of every withdrawal: the amount must be greater than that`, 422);
      if (mine(a).some((o) => o.kind === 'withdraw' && !o.final && o.state !== 'pending_approval')) throw env.refuse('withdrawal_in_progress', 'a withdrawal is already in progress; wait for it to arrive before asking for another', 409);
      if (!b) throw env.refuse('venue_unavailable', 'the venue account could not be read; nothing was prepared', 503);
      if (usdcUnits(Number(b.withdrawable).toFixed(6).replace(/\.?0+$/, '')) < amount) throw env.refuse('insufficient_collateral', `the venue reports ${b.withdrawable} USDC withdrawable on this account`, 422);
      for (const o of mine(a)) if (o.kind === 'withdraw' && o.state === 'pending_approval') { o.state = 'cancelled'; o.final = true; }
      const t = Math.floor(now / 1000);
      const w: VenueWithdrawal = { v: 1, withdrawalId: crypto.randomUUID(), keyId: env.keyId, venue: 'hyperliquid', network: a.network, account: a.account, destination: a.account, amount: u(amount), fee: HL_WITHDRAW_FEE_USDC, time: now, createdAt: t, expiresAt: t + 180 };
      const built = buildVenueWithdraw(w, a.account), hash = hex(venueWithdrawalHash(w));
      const o: Op = { id: w.withdrawalId, account: a.id, kind: 'withdraw', amount, hash, createdAt: now, expiresAt: now + 180_000, approvedAt: null, state: 'pending_approval', final: false, error: null, before: num(b.equity), after: null, settled: false,
        txid: null, withdrawal: w, creditMs: null, payoutMs: PAYOUT, venueAt: null };
      OPS.push(o);
      return { operation: view(o), withdrawal: w, hash, whatIsSigned: { byMainKey: `Hyperliquid withdraw3 (${built.action.hyperliquidChain}): ${built.action.amount} USDC to ${built.action.destination}, time ${built.action.time}`,
        byPasskey: `SHA-256 of the canonical withdrawal ${hash}`, action: built.action }, receive: u(amount - FEE), venueBalance: bal(a), options: env.options(hash) };
    }
    m = /^\/withdraw\/([0-9a-f-]{36})\/approve$/.exec(rest);
    if (m) {
      needMainnet(a);
      const o = find(a, m[1]!, 'withdraw');
      if (o.state !== 'pending_approval') throw env.refuse(o.state === 'expired' ? 'expired' : 'bad_state', `the withdrawal is ${o.state}`, o.state === 'expired' ? 410 : 409);
      const no = env.refusal(body?.assertion, o.hash);
      if (no) { o.state = 'failed'; o.final = true; o.error = `the signer refused: ${no.message}. Nothing was sent to the venue.`; throw no; }
      env.move(a, `-${u(o.amount)}`);      // the venue debits the account when it accepts the withdrawal
      o.approvedAt = now - AGE; AGE = 0;
      advance(o, a);
      return { operation: view(o) };
    }
    throw env.refuse('not_found', 'no such collateral route', 404);
  }
  const hooks: CollateralHooks = {
    wallet: (usdc, elsewhere = []) => { USDC = usdcUnits(usdc); ELSE = elsewhere; },
    creditAfter: (ms) => { CREDIT = ms; }, payoutAfter: (ms) => { PAYOUT = ms; }, age: (ms) => { AGE = ms; },
  };
  return { handle, hooks };
}
