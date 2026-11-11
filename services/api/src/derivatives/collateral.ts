// Collateral of a venue account (Hyperliquid): DEPOSIT USDC from the wallet, WITHDRAW it back. Facts, sources and evidence:
// docs/v4/venues/hyperliquid.md section 15; routes and shapes: docs/v4/API-LIVE-NOTES.md ("Collateral").
//
// Deposit = an ordinary wallet proposal (table `proposals`: passkey → signer → broadcast → receipt, the wallet's own worker
// tracks it) whose intent carries a `venueDeposit` section, plus a row here that follows the money to the venue: the credit is
// read from the venue's own ledger (`userNonFundingLedgerUpdates`: a `deposit` whose hash is our transaction hash). Success is
// never claimed before the venue shows it.
// Withdrawal = the canonical `VenueWithdrawal` approved by passkey, signed by the main key inside the signer (`withdraw3`, to the
// wallet's own address), sent to the venue, then followed twice: the venue's ledger (`withdraw`, fee) and the wallet's own
// chain scan (the USDC really arrived from the bridge).
//
// What this file can NOT do: it holds no key. A deposit goes to the bridge pinned in the SIGNER's bundle or is refused there;
// a withdrawal goes to the wallet's own address or is refused there. Mainnet needs SPW_DERIV_LIVE_MAINNET=on.
import { createHash, randomUUID } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { decodeFunctionResult, encodeFunctionData, formatUnits, hexToBigInt, hexToNumber, pad } from 'viem';
import { z } from 'zod';
import { buildEvmTx, CCTP_ENABLED, cctpUsdc, checkPolicy, getNetwork, IntentSchema, intentHash, toB64u, toHex, type Intent, type Policy } from '@spw/core';
import { hlExchangeAnswer, parseHl, VenueError } from '@spw/derivatives';
import {
  buildVenueWithdraw, checkVenueDepositIntent, hex, HL_BRIDGE_PINS, HL_COLLATERAL_PINNED_AT, HL_DEPOSIT_FLOOR_USDC, HL_DEPOSIT_MIN_USDC, HL_DEPOSIT_ROUTE, HL_WITHDRAW_FEE_USDC, recoverTypedDataSigner, usdcDecimal, usdcUnits,
  validateVenueWithdrawal, venueDepositSection, venueWithdrawalHash, VenueWithdrawalSchema, type HlBridgePin, type HlNetwork, type VenueWithdrawal,
} from '@spw/derivatives/live';
import { adapterFor } from '../chains/index.ts';
import { rpcAny, rpcQuorum, type Prepared } from '../chains/rpc.ts';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { broadcastNow, move, type ProposalRow } from '../transfers.ts';
import { signer } from '../signer-client.ts';
import { loop } from '../worker.ts';
import { venueFailure } from './data.ts';
import type { LiveService } from './exec.ts';
import { live } from './live.ts';

export const COLLATERAL_STEP_MS = 10_000;
/** "credited to the account that sent it in less than 1 minute" (venue docs); 6–10 s observed on 2026-11-11 */
export const DEPOSIT_EXPECTED_SEC = 60;
/** after this long without a credit the screen says exactly what to check (polling goes on) */
export const DEPOSIT_OVERDUE_MS = 10 * 60_000;
/** "the funds arrive in the user wallet in 3-4 minutes" (venue docs); about 232 s observed on 2026-11-11 */
export const WITHDRAW_EXPECTED_SEC = 240;
export const WITHDRAW_OVERDUE_MS = 15 * 60_000;
/** a withdrawal whose submission got no readable answer is given up (never assumed sent) after this long without any trace */
export const WITHDRAW_UNKNOWN_GIVE_UP_MS = 30 * 60_000;
const WITHDRAW_TTL_SEC = 180, RESUBMIT_EVERY_MS = 20_000, MAX_SUBMITS = 3, LEDGER_EVERY_MS = 8_000, LIVENESS_TTL_MS = 5 * 60_000, ABSTRACTION_TTL_MS = 10 * 60_000;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAINNET_OFF = 'moving collateral on Hyperliquid MAINNET is disabled on this server (SPW_DERIV_LIVE_MAINNET is not "on"): nothing was built, signed or sent';
const sha = (hexStr: string) => createHash('sha256').update(Buffer.from(hexStr.slice(2), 'hex')).digest('hex');
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export type DepositState = 'pending_approval' | 'signed' | 'sent' | 'awaiting_credit' | 'credited' | 'failed' | 'expired' | 'cancelled';
export type WithdrawState = 'pending_approval' | 'approved' | 'signed' | 'submitted' | 'unknown' | 'completed' | 'rejected' | 'failed' | 'expired' | 'cancelled';

interface Row {
  id: string; account_id: string; kind: 'deposit' | 'withdraw'; state: string; final: boolean; venue_network: HlNetwork; amount: string; fee: string | null; chain_network: string | null;
  proposal_id: string | null; txid: string | null; op_hash: string | null; request: Record<string, any>; action: unknown; signature: { r: string; s: string; v: number } | null; venue_answer: unknown; nonce: string | null;
  balance_before: VenueBalance | null; balance_after: VenueBalance | null; ledger: LedgerEntry | null; arrival: Arrival | null; error: string | null; attempts: number;
  expires_at: Date | null; sent_at: Date | null; venue_at: Date | null; done_at: Date | null; checked_at: Date | null; created_at: Date; updated_at: Date;
}
interface AccountRow { id: string; venue: 'hyperliquid'; network: HlNetwork; account: string; label: string; mode: string }
export interface VenueBalance { abstraction: string | null; equity: string | null; withdrawable: string | null; spotUsdc: string | null; /** what the account holds as collateral, where this account keeps it */ total: string | null; error: string | null; ts: number }
export interface LedgerEntry { time: number; hash: string; type: string; usdc: string | null; fee: string | null; nonce: number | null }
export interface Arrival { txid: string; amount: string; seenAt: number }
export interface Liveness { ok: boolean; checkedAt: number; checked: number; credited: number; detail: string; samples: { tx: string; usdc: string; credited: boolean }[] }

const ledgerAnswer = z.array(z.looseObject({ time: z.number(), hash: z.string(), delta: z.looseObject({ type: z.string(), usdc: z.string().optional(), fee: z.string().optional(), nonce: z.number().optional() }) }));
const spotAnswer = z.looseObject({ balances: z.array(z.looseObject({ coin: z.string(), total: z.string(), hold: z.string().optional() })) });

// ---------------------------------------------------------------------------------------------------------------------------
// Ports: the signer, and the wallet's chain side (replaced by fakes in tests; the real one below reads the registry RPC endpoints)

export interface CollateralSignerPort {
  status(fresh?: boolean): Promise<{ keyId: string; halted: boolean; addresses: Record<string, string>; policy: Policy; spentToday: Record<string, string> }>;
  sign(intent: unknown, assertion: unknown): Promise<{ raw: string; txid: string; hash: string }>;
  venueWithdraw(withdrawal: unknown, assertion: unknown): Promise<{ withdrawalId: string; hash: string; action: unknown; signature: { r: string; s: string; v: number }; nonce: number; signer: string }>;
}
export interface CollateralChain {
  /** the bridge is the pinned bytecode on every RPC source, not paused, pays the pinned token; the wallet address carries no code. Throws UserError. */
  guards(pin: HlBridgePin, me: string): Promise<void>;
  /** is the route crediting deposits NOW: recent transfers into the bridge matched with the venue's ledger */
  liveness(pin: HlBridgePin, ledger: (user: string, sinceMs: number) => Promise<LedgerEntry[]>): Promise<Liveness>;
  balances(network: string, address: string): Promise<{ usdc: bigint; native: bigint }>;
  /** native USDC the wallet holds on the other networks the cross-network transfer (CCTP) can bring from */
  elsewhere(address: string, except: string): Promise<{ network: string; name: string; usdc: string }[]>;
  prepare(pin: HlBridgePin, from: string, amount: bigint): Promise<Prepared>;
  /** USDC received by the wallet FROM the bridge since `sinceMs`, as the wallet's own chain scan recorded it */
  arrivals(pin: HlBridgePin, me: string, sinceMs: number): Promise<Arrival[]>;
}

const bridgeAbi = [
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'usdcToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
export function realChain(now: () => number = Date.now): CollateralChain {
  let cached: Liveness | null = null;
  return {
    async guards(pin, me) {
      const n = getNetwork(pin.network);
      const q = <T>(m: string, p: unknown[]) => rpcQuorum<T>(n.rpc, m, p);
      const changed = (what: string) => new UserError('contract_changed', `${what} on ${n.name} is not what was reviewed; deposits are refused until it is reviewed again`, 503);
      if (sha(await q<string>('eth_getCode', [pin.bridge, 'latest'])) !== pin.codeSha256) throw changed('the bytecode of the venue bridge');
      const call = async (fn: 'paused' | 'usdcToken') => decodeFunctionResult({ abi: bridgeAbi, functionName: fn, data: await q<`0x${string}`>('eth_call', [{ to: pin.bridge, data: encodeFunctionData({ abi: bridgeAbi, functionName: fn }) }, 'latest']) });
      if (String(await call('usdcToken')).toLowerCase() !== pin.usdc.toLowerCase()) throw changed('the token of the venue bridge');
      if (await call('paused')) throw new UserError('bridge_paused', 'the venue bridge is locked (paused) by its validators: withdrawals are blocked there, so nothing is deposited', 503);
      // an EIP-7702 delegation on the wallet address would run someone's code on every coin received
      if ((await q<string>('eth_getCode', [me, 'latest'])) !== '0x') throw new UserError('account_has_code', 'this wallet address carries code (delegation); transfers are refused', 503);
    },
    async liveness(pin, ledger) {
      if (cached && cached.ok && now() - cached.checkedAt < LIVENESS_TTL_MS) return cached;
      const n = getNetwork(pin.network), min = usdcUnits(HL_DEPOSIT_MIN_USDC);
      const head = hexToNumber(await rpcAny<`0x${string}`>(n.rpc, 'eth_blockNumber', []));
      const hx = (v: number) => `0x${v.toString(16)}`, samples: Liveness['samples'] = [];
      // Arbitrum makes about 4 blocks a second: the last 10 minutes first, then the last hour; transfers younger than a minute are left out
      for (const span of [2400, 14_400]) {
        const logs = await rpcAny<{ transactionHash: string; topics: string[]; data: `0x${string}`; removed?: boolean }[]>(n.rpc, 'eth_getLogs',
          [{ address: pin.usdc, topics: [TRANSFER_TOPIC, null, pad(pin.bridge as `0x${string}`).toLowerCase()], fromBlock: hx(head - span), toBlock: hx(head - 240) }]);
        const picked = logs.filter((l) => !l.removed && l.topics.length === 3 && hexToBigInt(l.data) >= min).slice(-3).reverse();
        if (!picked.length) continue;
        for (const l of picked) {
          const user = `0x${l.topics[1]!.slice(26)}`;
          const led = await ledger(user, now() - 3 * 3_600_000);
          samples.push({ tx: l.transactionHash, usdc: formatUnits(hexToBigInt(l.data), 6), credited: led.some((x) => x.type === 'deposit' && x.hash.toLowerCase() === l.transactionHash.toLowerCase()) });
        }
        break;
      }
      const credited = samples.filter((s) => s.credited).length;
      const out: Liveness = { ok: credited > 0, checkedAt: now(), checked: samples.length, credited, samples,
        detail: samples.length === 0 ? 'no deposit of at least 5 USDC reached the bridge in the last hour: the route cannot be shown to work right now' : credited > 0
          ? `${credited} of the ${samples.length} most recent deposits into the bridge are in the venue's ledger` : `none of the ${samples.length} most recent deposits into the bridge is in the venue's ledger` };
      if (out.ok) cached = out;
      return out;
    },
    async balances(network, address) {
      const b = await adapterFor(network).balances(address), usdc = b[cctpUsdc(network).id];
      if (usdc === undefined) throw new UserError('rpc_degraded', 'the USDC balance could not be read', 503);
      return { usdc, native: b.native ?? 0n };
    },
    async elsewhere(address, except) {
      const nets = Object.keys(CCTP_ENABLED).filter((id) => id !== except);
      const rs = await Promise.allSettled(nets.map(async (id) => ({ network: id, name: getNetwork(id).name, usdc: (await adapterFor(id).balances(address))[cctpUsdc(id).id] ?? 0n })));
      return rs.flatMap((r) => (r.status === 'fulfilled' && r.value.usdc > 0n ? [{ network: r.value.network, name: r.value.name, usdc: formatUnits(r.value.usdc, 6) }] : []));
    },
    prepare: (pin, from, amount) => adapterFor(pin.network).prepare({ asset: pin.usdc, from, to: pin.bridge, amount }),
    async arrivals(pin, me, sinceMs) {
      // `deposits` is filled by the wallet's own worker from its chain adapter (Transfer logs to the wallet address)
      void me;
      const rows = await sql<{ txid: string; amount: string; seen_at: Date }[]>`select txid, amount, seen_at from deposits where network = ${pin.network} and lower(asset) = ${pin.usdc.toLowerCase()}
        and lower(from_addr) = ${pin.bridge.toLowerCase()} and seen_at >= ${new Date(sinceMs)} order by seen_at`;
      return rows.map((r) => ({ txid: r.txid, amount: String(r.amount), seenAt: r.seen_at.getTime() }));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------

export const AmountBodySchema = z.strictObject({ amount: z.string().regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/, 'a USDC amount with at most 6 decimals') });
export const CollateralAssertionSchema = z.strictObject({ assertion: z.record(z.string(), z.unknown()) });
export interface CollateralDeps { live: LiveService; signer: CollateralSignerPort; chain: CollateralChain }

export class CollateralService {
  readonly deps: CollateralDeps;
  readonly now: () => number;
  private readonly abstraction = new Map<string, { at: number; v: string | null }>();
  constructor(deps: CollateralDeps) { this.deps = deps; this.now = deps.live.now; }

  // ------------------------------------------------------------------ helpers

  private async account(id: string): Promise<AccountRow> {
    const [a] = await sql<AccountRow[]>`select id, venue, network, account, label, mode from deriv_accounts where id = ${id}`;
    if (!a) throw new UserError('unknown_account', 'unknown venue account', 404);
    return a;
  }
  private async row(accountId: string, opId: string, kind?: 'deposit' | 'withdraw'): Promise<Row> {
    const [r] = await sql<Row[]>`select * from deriv_collateral where id = ${opId} and account_id = ${accountId}`;
    if (!r || (kind && r.kind !== kind)) throw new UserError('unknown_operation', 'unknown collateral operation', 404);
    return r;
  }
  private async set(r: Row, patch: Record<string, unknown>, from?: string): Promise<Row> {
    const p = { ...patch, updated_at: new Date(this.now()) };
    const [u] = from === undefined ? await sql<Row[]>`update deriv_collateral set ${sql(p as never)} where id = ${r.id} returning *`
      : await sql<Row[]>`update deriv_collateral set ${sql(p as never)} where id = ${r.id} and state = ${from} returning *`;
    if (!u) throw new UserError('conflict', 'the operation changed concurrently; reload', 409);
    return u;
  }
  private log(type: string, r: { id: string; account_id: string; kind: string; amount: string; venue_network: string }, data: Record<string, unknown> = {}, actor = 'system'): Promise<void> {
    return audit(`deriv.collateral.${type}`, actor, { account: r.account_id, id: r.id, kind: r.kind, amount: String(r.amount), network: r.venue_network, ...data }).catch((e: Error) => console.error(`[collateral] audit ${type} failed: ${e.message}`));
  }
  private needMainnet(network: HlNetwork): void { if (network === 'mainnet' && !this.deps.live.deps.mainnetEnabled()) throw new UserError('mainnet_disabled', MAINNET_OFF, 403); }
  private venue(network: HlNetwork) { return this.deps.live.deps.venues.get(network); }
  private async options(hash: Uint8Array, ttlSec: number) {
    const creds = await this.deps.live.deps.credentials();
    const options = await generateAuthenticationOptions({ rpID: this.deps.live.deps.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: ttlSec * 1000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    return options;
  }

  /** the venue's own record of money movements of an address (deposits, withdrawals) */
  async ledger(network: HlNetwork, user: string, sinceMs: number): Promise<LedgerEntry[]> {
    try {
      const a = parseHl(ledgerAnswer, await this.venue(network).adapter.http.info({ type: 'userNonFundingLedgerUpdates', user: user.toLowerCase(), startTime: Math.max(0, Math.floor(sinceMs)) }), 'userNonFundingLedgerUpdates');
      return a.map((x) => ({ time: x.time, hash: x.hash, type: x.delta.type, usdc: x.delta.usdc ?? null, fee: x.delta.fee ?? null, nonce: x.delta.nonce ?? null }));
    } catch (e) { throw venueFailure(e); }
  }

  /**
   * What the account holds at the venue. A new account is in the venue's `default` mode: a bridge deposit lands in the perp
   * margin (`clearinghouseState`), ready to trade. Under the venue's "unified account" / "portfolio margin" modes the same
   * money is reported in the spot state instead — read too, so that a credit is never missed.
   */
  async venueBalance(a: AccountRow): Promise<VenueBalance> {
    const v = this.venue(a.network), ts = this.now();
    try {
      let mode = this.abstraction.get(a.id);
      if (!mode || ts - mode.at > ABSTRACTION_TTL_MS) {
        const raw = await v.adapter.http.info({ type: 'userAbstraction', user: a.account }).catch(() => null);
        mode = { at: ts, v: typeof raw === 'string' ? raw.slice(0, 40) : null };
        this.abstraction.set(a.id, mode);
      }
      const st = await v.adapter.account(a.account);
      let spotUsdc: string | null = null;
      if (mode.v !== 'default') {
        const s = spotAnswer.safeParse(await v.adapter.http.info({ type: 'spotClearinghouseState', user: a.account }).catch(() => null));
        spotUsdc = s.success ? (s.data.balances.find((b) => b.coin === 'USDC')?.total ?? '0') : null;
      }
      const unified = mode.v === 'unifiedAccount' || mode.v === 'portfolioMargin';
      return { abstraction: mode.v, equity: st.equity, withdrawable: st.withdrawable, spotUsdc, total: unified && spotUsdc !== null ? spotUsdc : st.equity, error: null, ts };
    } catch (e) { return { abstraction: null, equity: null, withdrawable: null, spotUsdc: null, total: null, error: msg(venueFailure(e)), ts }; }
  }

  // ------------------------------------------------------------------ views

  private view(r: Row, p?: ProposalRow | null) {
    const now = this.now(), pin = HL_BRIDGE_PINS[r.venue_network], n = r.chain_network ? getNetwork(r.chain_network) : null;
    const sent = r.sent_at?.getTime() ?? null;
    const overdue = !r.final && sent !== null && (r.kind === 'deposit' ? r.state === 'awaiting_credit' && now - sent > DEPOSIT_OVERDUE_MS : (r.state === 'submitted' || r.state === 'unknown') && now - sent > WITHDRAW_OVERDUE_MS);
    const fee = r.fee === null ? null : usdcDecimal(usdcUnits(D6(r.fee)));
    return {
      id: r.id, kind: r.kind, state: r.state, final: r.final, venueNetwork: r.venue_network, amount: usdcDecimal(usdcUnits(D6(r.amount))), asset: 'USDC', fee,
      /** withdrawal: what should arrive on the wallet — the venue takes its fee out of the amount (ledger: `usdc` received + `fee`) */
      expectedReceive: r.kind === 'withdraw' && fee !== null ? usdcDecimal(usdcUnits(D6(r.amount)) - usdcUnits(fee)) : null,
      chainNetwork: r.chain_network, chainNetworkName: n?.name ?? null, bridge: r.kind === 'deposit' ? pin?.bridge ?? null : null,
      txid: r.txid, explorer: r.txid && n ? n.explorerTx + r.txid : null, hash: r.op_hash, proposalId: r.proposal_id, proposalState: p?.state ?? null, confirmations: p?.confirmations ?? null,
      createdAt: r.created_at.getTime(), expiresAt: r.expires_at?.getTime() ?? null, sentAt: sent, venueAt: r.venue_at?.getTime() ?? null, doneAt: r.done_at?.getTime() ?? null, checkedAt: r.checked_at?.getTime() ?? null,
      expectedSeconds: r.kind === 'deposit' ? DEPOSIT_EXPECTED_SEC : WITHDRAW_EXPECTED_SEC, overdue,
      /** when overdue: what to look at, in order (machine codes; the screen has the words) */
      check: overdue ? (r.kind === 'deposit' ? ['tx_success', 'tx_to_bridge', 'amount_min', 'venue_ledger', 'venue_status'] : ['venue_ledger', 'bridge_paused', 'wallet_scan', 'venue_status']) : [],
      balanceBefore: r.balance_before, balanceAfter: r.balance_after, ledger: r.ledger, arrival: r.arrival, venueAnswer: r.venue_answer ?? null, error: r.error, attempts: r.attempts,
      arrivalTracked: r.kind === 'withdraw' ? !!pin : null,
    };
  }
  private async views(rows: Row[]) {
    const ids = rows.flatMap((r) => (r.proposal_id ? [r.proposal_id] : []));
    const ps = ids.length ? await sql<ProposalRow[]>`select * from proposals where id in ${sql(ids)}` : [];
    return rows.map((r) => this.view(r, ps.find((p) => p.id === r.proposal_id) ?? null));
  }

  /** everything the two sheets need: venue balance, the route and its facts, the wallet side, the limits, the operations */
  async status(id: string) {
    const a = await this.account(id), pin = HL_BRIDGE_PINS[a.network] ?? null, mainnetEnabled = this.deps.live.deps.mainnetEnabled();
    await this.refreshOpen(id).catch(() => {});
    const [balance, rows] = await Promise.all([this.venueBalance(a), sql<Row[]>`select * from deriv_collateral where account_id = ${id} order by created_at desc limit 20`]);
    let wallet: { address: string; network: string; networkName: string; usdc: string; gas: string; gasSymbol: string; limits: { perTransfer: string; perDay: string; spentToday: string; maxNow: string }; elsewhere: { network: string; name: string; usdc: string }[] } | null = null;
    let walletError: string | null = null, depositReason: string | null = null, signerHalted = false;
    if (pin) {
      try {
        const st = await this.deps.signer.status(), me = st.addresses[pin.network], n = getNetwork(pin.network), key = `${pin.network}:USDC`;
        signerHalted = st.halted;
        if (!me || me.toLowerCase() !== a.account) throw new UserError('wrong_account', 'the venue account is not this wallet\'s address', 409);
        const b = await this.deps.chain.balances(pin.network, me);
        const perTx = BigInt(st.policy.perTx[key] ?? '0'), perDay = BigInt(st.policy.daily[key] ?? '0'), spent = BigInt(st.spentToday[key] ?? '0');
        const room = perDay > spent ? perDay - spent : 0n, maxNow = [perTx, room, b.usdc].reduce((x, y) => (y < x ? y : x));
        const floor = usdcUnits(HL_DEPOSIT_FLOOR_USDC);
        wallet = { address: me, network: pin.network, networkName: n.name, usdc: formatUnits(b.usdc, 6), gas: formatUnits(b.native, n.native.decimals), gasSymbol: n.native.symbol,
          limits: { perTransfer: formatUnits(perTx, 6), perDay: formatUnits(perDay, 6), spentToday: formatUnits(spent, 6), maxNow: formatUnits(maxNow, 6) },
          elsewhere: b.usdc < floor ? await this.deps.chain.elsewhere(me, pin.network) : [] };
        depositReason = b.usdc < floor ? (wallet.elsewhere.length ? 'usdc_elsewhere' : 'no_usdc') : b.native === 0n ? 'no_gas' : (perTx < floor || room < floor) ? 'limit_reached' : null;
      } catch (e) { walletError = msg(e); depositReason = 'wallet_unreadable'; }
    }
    const depositBlock = !pin ? 'no_route' : !mainnetEnabled && a.network === 'mainnet' ? 'mainnet_disabled' : signerHalted ? 'halted' : depositReason;
    const withdrawBlock = a.network === 'mainnet' && !mainnetEnabled ? 'mainnet_disabled' : signerHalted ? 'halted' : balance.error ? 'venue_unreadable' : null;
    return {
      account: a.account, accountId: a.id, venue: a.venue, network: a.network, mainnetEnabled, venueBalance: balance,
      /** deposit before the authorization: the venue refuses every action of an account that never deposited ("Must deposit before performing actions") */
      route: pin ? { id: HL_DEPOSIT_ROUTE, network: pin.network, networkName: getNetwork(pin.network).name, bridge: pin.bridge, bridgeExplorer: getNetwork(pin.network).explorerAddr + pin.bridge, asset: 'USDC', token: pin.usdc,
        venueMinimum: HL_DEPOSIT_MIN_USDC, minimum: HL_DEPOSIT_FLOOR_USDC, expectedSeconds: DEPOSIT_EXPECTED_SEC, credits: 'sender' as const, venueFee: '0', legacy: true, pinnedAt: HL_COLLATERAL_PINNED_AT, codeSha256: pin.codeSha256 } : null,
      withdrawal: { fee: HL_WITHDRAW_FEE_USDC, expectedSeconds: WITHDRAW_EXPECTED_SEC, destination: a.account, payoutNetworkName: a.network === 'mainnet' ? 'Arbitrum One' : 'Arbitrum Sepolia', arrivalTracked: !!pin,
        available: balance.abstraction === 'unifiedAccount' || balance.abstraction === 'portfolioMargin' ? balance.spotUsdc : balance.withdrawable },
      wallet, walletError,
      deposit: { available: depositBlock === null, reason: depositBlock, bridgeFrom: wallet?.elsewhere ?? [] },
      withdraw: { available: withdrawBlock === null, reason: withdrawBlock },
      operations: await this.views(rows), ts: this.now(),
    };
  }

  async operation(id: string, opId: string) {
    let r = await this.row(id, opId);
    if (!r.final) r = await this.refresh(r, true).catch(() => r);
    return { operation: (await this.views([r]))[0]! };
  }

  /** before the passkey only: nothing was signed */
  async cancel(id: string, opId: string) {
    let r = await this.row(id, opId);
    if (r.state !== 'pending_approval') throw new UserError('bad_state', `the operation is ${r.state}: it can no longer be cancelled here`, 409);
    if (r.proposal_id) { const [p] = await sql<ProposalRow[]>`select * from proposals where id = ${r.proposal_id}`; if (p && p.state === 'pending_approval') await move(p, 'rejected', { error: 'rejected by owner' }); }
    r = await this.set(r, { state: 'cancelled', final: true, done_at: new Date(this.now()), error: 'cancelled before approval; nothing was signed' }, 'pending_approval');
    await this.log('cancelled', r, {}, 'owner');
    return { operation: (await this.views([r]))[0]! };
  }

  // ------------------------------------------------------------------ deposit

  async prepareDeposit(id: string, body: z.infer<typeof AmountBodySchema>) {
    const a = await this.account(id), pin = HL_BRIDGE_PINS[a.network];
    if (!pin) throw new UserError('no_route', `no deposit route exists in this wallet for Hyperliquid ${a.network}: testnet collateral is mock USDC from the venue's faucet`, 422);
    this.needMainnet(a.network);
    const amount = usdcUnits(body.amount), floor = usdcUnits(HL_DEPOSIT_FLOOR_USDC);
    if (amount < floor) throw new UserError('below_minimum', `the smallest deposit is ${HL_DEPOSIT_FLOOR_USDC} USDC: the venue credits nothing under ${HL_DEPOSIT_MIN_USDC} USDC and such a transfer would be lost`, 422);
    const st = await this.deps.signer.status(true), n = getNetwork(pin.network), me = st.addresses[pin.network];
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    if (!me || me.toLowerCase() !== a.account) throw new UserError('wrong_account', 'the venue account is not this wallet\'s own address: the venue credits the sender, so nothing is deposited', 409);
    const [open] = await sql<Row[]>`select * from deriv_collateral where account_id = ${id} and kind = 'deposit' and not final and state <> 'pending_approval' limit 1`;
    if (open) throw new UserError('deposit_in_progress', 'a deposit is already on its way to the venue; wait for the credit before sending another', 409);
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${pin.network} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', `a previous transfer on ${n.name} is not confirmed yet; wait for it before depositing`, 409);
    // 1. the contract is the reviewed one, on every RPC source; 2. the route credits deposits right now
    await this.deps.chain.guards(pin, me);
    const live = await this.deps.chain.liveness(pin, (user, since) => this.ledger(a.network, user, since));
    if (!live.ok) throw new UserError('route_not_proven', `the deposit route could not be shown to work right now (${live.detail}); nothing was prepared`, 503);
    const bal = await this.deps.chain.balances(pin.network, me);
    if (bal.usdc < amount) {
      const el = await this.deps.chain.elsewhere(me, pin.network).catch(() => []);
      throw new UserError('insufficient_usdc', `the wallet holds ${formatUnits(bal.usdc, 6)} USDC on ${n.name}${el.length ? `; it holds USDC on ${el.map((x) => `${x.name} (${x.usdc})`).join(', ')}: move it to ${n.name} first with the cross-network transfer` : ''}`, 422);
    }
    const prep = await this.deps.chain.prepare(pin, me, amount);
    const now = Math.floor(this.now() / 1000), proposalId = randomUUID();
    const intent: Intent = IntentSchema.parse({ v: 1, proposalId, keyId: st.keyId, network: n.id, chainRef: n.chainRef, asset: pin.usdc, symbol: 'USDC', decimals: 6, amount: amount.toString(), from: me, to: pin.bridge,
      maxFee: prep.maxFee.toString(), createdAt: now, expiresAt: now + prep.ttlSec, policyVersion: st.policy.version, venueDeposit: venueDepositSection(a.network), ...prep.section });
    // the same rules and the same bytes as the signer, before the owner is asked
    try { checkVenueDepositIntent(intent, me); buildEvmTx(intent); } catch (e) { throw new UserError('simulation_failed', msg(e), 422); }
    const verdict = checkPolicy(st.policy, intent, BigInt(st.spentToday[`${n.id}:USDC`] ?? '0'), now, st.halted);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const hash = intentHash(intent), before = await this.venueBalance(a), opId = randomUUID(), created = new Date(this.now()), expires = new Date(intent.expiresAt * 1000);
    // one deposit under review at a time: the previous unapproved one is withdrawn
    for (const old of await sql<Row[]>`select * from deriv_collateral where account_id = ${id} and kind = 'deposit' and state = 'pending_approval'`) await this.cancel(id, old.id).catch(() => {});
    await sql`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, intent, intent_hash, expires_at, created_at, updated_at)
      values (${proposalId}, ${`venue-deposit-${opId}`}, 'pending_approval', ${n.id}, ${pin.usdc}, 'USDC', 6, ${amount.toString()}, ${me}, ${pin.bridge}, ${`Hyperliquid ${a.network} deposit`}, ${prep.feeEstimate.toString()}, ${prep.maxFee.toString()},
        ${sql.json(['venue_deposit'])}, ${sql.json(intent as never)}, ${toHex(hash)}, ${expires}, ${created}, ${created})`;
    const [r] = await sql<Row[]>`insert into deriv_collateral (id, account_id, kind, state, venue_network, amount, chain_network, proposal_id, op_hash, request, balance_before, expires_at, created_at, updated_at)
      values (${opId}, ${id}, 'deposit', 'pending_approval', ${a.network}, ${formatUnits(amount, 6)}, ${n.id}, ${proposalId}, ${toHex(hash)}, ${sql.json({ liveness: live } as never)}, ${sql.json(before as never)}, ${expires}, ${created}, ${created}) returning *`;
    await this.log('deposit_prepared', r!, { proposal: proposalId, hash: toHex(hash), bridge: pin.bridge, chain: n.id, liveness: live.detail }, 'owner');
    return { operation: (await this.views([r!]))[0]!, intent, route: { network: n.id, networkName: n.name, bridge: pin.bridge, minimum: HL_DEPOSIT_FLOOR_USDC, venueMinimum: HL_DEPOSIT_MIN_USDC, expectedSeconds: DEPOSIT_EXPECTED_SEC },
      fee: { estimate: formatUnits(prep.feeEstimate, n.native.decimals), max: formatUnits(prep.maxFee, n.native.decimals), symbol: n.native.symbol }, liveness: live, venueBalance: before,
      options: await this.options(hash, prep.ttlSec) };
  }

  /** The HTTP call is not the approval: the passkey assertion over the intent hash is, and only the signer judges it. */
  async approveDeposit(id: string, opId: string, assertion: unknown) {
    const a = await this.account(id), pin = HL_BRIDGE_PINS[a.network];
    let r = await this.row(id, opId, 'deposit');
    if (!pin || !r.proposal_id) throw new UserError('no_route', 'no deposit route', 422);
    this.needMainnet(a.network);
    let [p] = await sql<ProposalRow[]>`select * from proposals where id = ${r.proposal_id}`;
    if (r.state !== 'pending_approval' || !p || p.state !== 'pending_approval' || !p.intent) throw new UserError('bad_state', `the deposit is ${r.state}`, 409);
    if (p.expires_at && p.expires_at.getTime() < this.now()) { await this.refresh(r, true); throw new UserError('expired', 'approval window expired; start again', 410); }
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${p.network} and id <> ${p.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer on this network is not confirmed yet', 409);
    await this.deps.chain.guards(pin, p.from_addr); // the contract again, at the moment of signing
    r = await this.set(r, { state: 'signed' }, 'pending_approval');
    p = await move(p, 'approved');
    let signed: { raw: string; txid: string; hash: string };
    try { signed = await this.deps.signer.sign(p.intent, assertion); }
    catch (e) {
      await move(p, 'failed', { error: msg(e) });
      r = await this.set(r, { state: 'failed', final: true, done_at: new Date(this.now()), error: `the signer refused: ${msg(e)}. Nothing was signed or sent.` });
      await this.log('deposit_refused', r, { error: msg(e) });
      throw e;
    }
    if (signed.hash !== p.intent_hash) { await move(p, 'failed', { error: 'signer hash mismatch' }); await this.set(r, { state: 'failed', final: true, error: 'signer hash mismatch; nothing was sent' }); throw new UserError('hash_mismatch', 'signer returned a different intent hash', 500); }
    p = await move(p, 'signed', { raw: signed.raw, txid: signed.txid });
    r = await this.set(r, { txid: signed.txid });
    await this.log('deposit_signed', r, { txid: signed.txid, hash: signed.hash }, 'owner');
    p = await broadcastNow(p);
    r = await this.refresh(r, true);
    return { operation: (await this.views([r]))[0]! };
  }

  // ------------------------------------------------------------------ withdrawal

  async prepareWithdraw(id: string, body: z.infer<typeof AmountBodySchema>) {
    const a = await this.account(id);
    this.needMainnet(a.network);
    const amount = usdcUnits(body.amount), fee = usdcUnits(HL_WITHDRAW_FEE_USDC);
    if (amount <= fee) throw new UserError('below_fee', `the venue keeps ${HL_WITHDRAW_FEE_USDC} USDC of every withdrawal: the amount must be greater than that`, 422);
    const st = await this.deps.signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    if ((st.addresses.evm ?? '').toLowerCase() !== a.account) throw new UserError('wrong_account', 'the venue account is not this wallet\'s own address', 409);
    const [open] = await sql<Row[]>`select * from deriv_collateral where account_id = ${id} and kind = 'withdraw' and not final and state <> 'pending_approval' limit 1`;
    if (open) throw new UserError('withdrawal_in_progress', 'a withdrawal is already in progress; wait for it to arrive before asking for another', 409);
    const before = await this.venueBalance(a);
    if (before.error) throw new UserError('venue_unavailable', `the venue account could not be read (${before.error}); nothing was prepared`, 503);
    const unified = before.abstraction === 'unifiedAccount' || before.abstraction === 'portfolioMargin', available = unified ? before.spotUsdc : before.withdrawable;
    if (available !== null && usdcUnits(D6(available)) < amount) throw new UserError('insufficient_collateral', `the venue reports ${available} USDC withdrawable on this account`, 422);
    const [nr] = await sql<{ last_nonce: string }[]>`update deriv_accounts set last_nonce = greatest(last_nonce + 1, ${this.now()}::bigint) where id = ${id} returning last_nonce`;
    const time = Number(nr!.last_nonce), createdAt = Math.floor(this.now() / 1000);
    const w: VenueWithdrawal = VenueWithdrawalSchema.parse({ v: 1, withdrawalId: randomUUID(), keyId: st.keyId, venue: 'hyperliquid', network: a.network, account: a.account, destination: a.account,
      amount: usdcDecimal(amount), fee: HL_WITHDRAW_FEE_USDC, time, createdAt, expiresAt: createdAt + WITHDRAW_TTL_SEC });
    let built: ReturnType<typeof buildVenueWithdraw>;
    try { validateVenueWithdrawal(w, createdAt); built = buildVenueWithdraw(w, a.account); } catch (e) { throw new UserError('bad_request', msg(e), 422); }
    const hash = venueWithdrawalHash(w), created = new Date(this.now()), pin = HL_BRIDGE_PINS[a.network];
    for (const old of await sql<Row[]>`select * from deriv_collateral where account_id = ${id} and kind = 'withdraw' and state = 'pending_approval'`) await this.cancel(id, old.id).catch(() => {});
    const [r] = await sql<Row[]>`insert into deriv_collateral (id, account_id, kind, state, venue_network, amount, fee, chain_network, op_hash, request, nonce, balance_before, expires_at, created_at, updated_at)
      values (${w.withdrawalId}, ${id}, 'withdraw', 'pending_approval', ${a.network}, ${w.amount}, ${HL_WITHDRAW_FEE_USDC}, ${pin?.network ?? null}, ${hex(hash)}, ${sql.json({ withdrawal: w } as never)}, ${time}, ${sql.json(before as never)},
        ${new Date(w.expiresAt * 1000)}, ${created}, ${created}) returning *`;
    await this.log('withdraw_prepared', r!, { hash: hex(hash), destination: w.destination, time }, 'owner');
    return { operation: (await this.views([r!]))[0]!, withdrawal: w, hash: hex(hash),
      whatIsSigned: { byMainKey: `Hyperliquid withdraw3 (${built.action.hyperliquidChain}): ${built.action.amount} USDC to ${built.action.destination}, time ${built.action.time}`, byPasskey: `SHA-256 of the canonical withdrawal ${hex(hash)}`, action: built.action },
      receive: usdcDecimal(amount - fee), venueBalance: before, options: await this.options(hash, WITHDRAW_TTL_SEC) };
  }

  async approveWithdraw(id: string, opId: string, assertion: unknown) {
    const a = await this.account(id);
    let r = await this.row(id, opId, 'withdraw');
    this.needMainnet(a.network);
    if (r.state !== 'pending_approval') throw new UserError('bad_state', `the withdrawal is ${r.state}`, 409);
    if (r.expires_at && r.expires_at.getTime() < this.now()) { await this.refresh(r, true); throw new UserError('expired', 'approval window expired; start again', 410); }
    const w = VenueWithdrawalSchema.parse(r.request.withdrawal);
    r = await this.set(r, { state: 'approved' }, 'pending_approval');
    const fail = async (why: string, e?: unknown): Promise<never> => {
      r = await this.set(r, { state: 'failed', final: true, done_at: new Date(this.now()), error: `${why}. Nothing was sent to the venue.` });
      await this.log('withdraw_refused', r, { error: why });
      throw e ?? new UserError('signer_mismatch', why, 502);
    };
    let s: Awaited<ReturnType<CollateralSignerPort['venueWithdraw']>>;
    try { s = await this.deps.signer.venueWithdraw(w, assertion); } catch (e) { return fail(`the signer refused: ${msg(e)}`, e); }
    // the API checks the signer's answer before anything leaves: same canonical hash, the action it expects, a signature of the account
    const built = buildVenueWithdraw(w, a.account);
    if (s.hash !== r.op_hash || JSON.stringify(s.action) !== JSON.stringify(built.action) || s.nonce !== w.time) return fail('the signer returned another action than the approved withdrawal');
    if ((await recoverTypedDataSigner(built.typedData, s.signature).catch(() => '')) !== a.account) return fail('the signature does not recover to the venue account');
    // json, not jsonb: the action is kept with its keys in the venue's order (sql.json would go through jsonb and reorder them)
    const [signedRow] = await sql<Row[]>`update deriv_collateral set state = 'signed', action = ${s.action as never}::json, signature = ${sql.json(s.signature as never)}, updated_at = ${new Date(this.now())} where id = ${r.id} and state = 'approved' returning *`;
    if (!signedRow) throw new UserError('conflict', 'the operation changed concurrently; reload', 409);
    r = signedRow;
    await this.log('withdraw_signed', r, { hash: s.hash, destination: built.action.destination, time: w.time }, 'owner');
    r = await this.submit(a, r);
    return { operation: (await this.views([r]))[0]! };
  }

  /** Send the stored, signed action. The same bytes can be sent again: the venue accepts a nonce once. Mainnet needs the server setting. */
  private async submit(a: AccountRow, r: Row): Promise<Row> {
    this.needMainnet(a.network);
    const first = r.attempts === 0, at = new Date(this.now());
    r = await this.set(r, { attempts: r.attempts + 1, checked_at: at, request: sql.json({ ...r.request, lastSubmitAt: at.getTime() } as never), ...(r.sent_at ? {} : { sent_at: at }) });
    let raw: unknown;
    try { raw = await this.venue(a.network).adapter.http.exchange({ action: r.action, nonce: Number(r.nonce), signature: r.signature, vaultAddress: null, expiresAfter: null }, 1); }
    catch (e) {
      // an HTTP refusal of the request itself (malformed for the venue) on the first attempt is a refusal; anything else is unknown
      if (first && e instanceof VenueError && e.code === 'rejected') { r = await this.set(r, { state: 'rejected', final: true, done_at: at, error: `the venue refused the request: ${msg(e)}`, venue_answer: sql.json({ error: msg(e) } as never) }); await this.log('withdraw_rejected', r, { error: msg(e) }); return r; }
      r = await this.set(r, { state: 'unknown', error: `no readable answer from the venue (${msg(e)}); the outcome is unknown until the venue's ledger or the wallet shows it` });
      await this.log('withdraw_unknown', r, { error: msg(e) });
      return r;
    }
    const ans = hlExchangeAnswer.safeParse(raw);
    if (!ans.success) { r = await this.set(r, { state: 'unknown', venue_answer: sql.json({ raw } as never), error: 'the venue\'s answer could not be read; the outcome is unknown until the venue\'s ledger or the wallet shows it' }); await this.log('withdraw_unknown', r); return r; }
    if (ans.data.status === 'ok') { r = await this.set(r, { state: 'submitted', venue_answer: sql.json(raw as never), error: null }); await this.log('withdraw_submitted', r, { attempt: r.attempts }); return r; }
    const said = String(ans.data.response).slice(0, 300);
    if (first) { r = await this.set(r, { state: 'rejected', final: true, done_at: at, venue_answer: sql.json(raw as never), error: `the venue refused the withdrawal: ${said}` }); await this.log('withdraw_rejected', r, { error: said }); return r; }
    // a refusal of a RE-submission proves nothing about the first attempt (it may be "nonce already used"): keep watching
    return this.set(r, { state: 'unknown', venue_answer: sql.json(raw as never), error: `the venue answered "${said}" to the repeated request; the first one may have been accepted — watching the ledger and the wallet` });
  }

  // ------------------------------------------------------------------ reconciliation

  /** One operation forward, from the venue's ledger and the wallet's own chain records. Never signs. */
  private async refresh(r: Row, force = false): Promise<Row> {
    if (r.final) return r;
    const now = this.now(), a = await this.account(r.account_id), pin = HL_BRIDGE_PINS[r.venue_network];
    const due = force || !r.checked_at || now - r.checked_at.getTime() >= LEDGER_EVERY_MS;

    if (r.kind === 'deposit') {
      const [p] = r.proposal_id ? await sql<ProposalRow[]>`select * from proposals where id = ${r.proposal_id}` : [];
      if (!p) return this.set(r, { state: 'failed', final: true, error: 'the wallet proposal of this deposit no longer exists' });
      let [p0] = [p];
      // the wallet's worker expires stale proposals; done here too so that the screen never waits for it
      if (p0.state === 'pending_approval' && p0.expires_at && p0.expires_at.getTime() < now) p0 = await move(p0, 'expired', { error: 'expired before approval' }).catch(() => p0);
      return this.refreshDeposit(r, p0, a, now, due);
    }
    return this.refreshWithdraw(r, a, pin ?? null, now, due);
  }

  private async refreshDeposit(r: Row, p: ProposalRow, a: AccountRow, now: number, due: boolean): Promise<Row> {
    {
      const dead = ['failed', 'replaced', 'expired', 'rejected'].includes(p.state);
      if (dead) {
        const never = !p.txid || p.state === 'expired' || p.state === 'rejected';
        const state = p.state === 'expired' ? 'expired' : p.state === 'rejected' ? 'cancelled' : 'failed';
        r = await this.set(r, { state, final: true, done_at: new Date(now), txid: p.txid, error: `${p.error ?? p.state}${never ? '; nothing left the wallet' : '; the transfer did not happen on-chain: nothing reached the venue'}` });
        await this.log(`deposit_${state}`, r, { error: p.error });
        return r;
      }
      const state = p.state === 'pending_approval' ? 'pending_approval' : p.state === 'approved' || p.state === 'signed' ? 'signed' : p.state === 'confirming' || p.state === 'finalized' ? 'awaiting_credit' : 'sent';
      if (state !== r.state || p.txid !== r.txid) {
        const patch: Record<string, unknown> = { state, txid: p.txid };
        if ((state === 'sent' || state === 'awaiting_credit') && !r.sent_at) patch.sent_at = new Date(now);
        r = await this.set(r, patch);
        if (state === 'awaiting_credit') await this.log('deposit_confirmed_onchain', r, { txid: p.txid, confirmations: p.confirmations });
      }
      if ((r.state !== 'sent' && r.state !== 'awaiting_credit') || !r.txid || !due) return r;
      // the venue's ledger names the Arbitrum transaction it credited: `hash` of a `deposit` entry = our transaction hash
      const led = await this.ledger(r.venue_network, a.account, r.created_at.getTime() - 60_000);
      r = await this.set(r, { checked_at: new Date(now) });
      const hit = led.find((x) => x.type === 'deposit' && x.hash.toLowerCase() === r.txid!.toLowerCase());
      if (!hit) return r;
      const same = hit.usdc !== null && usdcUnits(D6(hit.usdc)) === usdcUnits(D6(r.amount));
      r = await this.set(r, { state: 'credited', final: true, venue_at: new Date(hit.time), done_at: new Date(now), ledger: sql.json(hit as never), balance_after: sql.json(await this.venueBalance(a) as never),
        error: same ? null : `the venue credited ${hit.usdc} USDC, not the ${usdcDecimal(usdcUnits(D6(r.amount)))} USDC sent` });
      await this.log('deposit_credited', r, { txid: r.txid, venueHash: hit.hash, venueTime: hit.time, usdc: hit.usdc });
      return r;
    }
  }

  private async refreshWithdraw(r: Row, a: AccountRow, pin: HlBridgePin | null, now: number, due: boolean): Promise<Row> {
    if (r.state === 'pending_approval') {
      if (r.expires_at && r.expires_at.getTime() < now) { r = await this.set(r, { state: 'expired', final: true, done_at: new Date(now), error: 'expired before approval; nothing was signed' }, 'pending_approval'); await this.log('withdraw_expired', r); }
      return r;
    }
    if (r.state === 'approved') {
      // the process died while asking the signer: without the signature nothing can have been sent
      if (now - r.updated_at.getTime() > 60_000) { r = await this.set(r, { state: 'failed', final: true, done_at: new Date(now), error: 'interrupted while asking the signer; nothing was sent to the venue' }, 'approved'); await this.log('withdraw_interrupted', r); }
      return r;
    }
    if (!due) return r;
    const time = Number(r.nonce), amount = usdcUnits(D6(r.amount)), fee = usdcUnits(D6(r.fee ?? '0'));
    const patch: Record<string, unknown> = { checked_at: new Date(now) };
    if (!r.ledger) {
      const led = await this.ledger(r.venue_network, a.account, r.created_at.getTime() - 60_000).catch(() => [] as LedgerEntry[]);
      // read live 2026-11-11: `nonce` is the action's `time` in microseconds (time × 1000); the plain value is accepted too
      const hit = led.find((x) => x.type === 'withdraw' && (x.nonce === time || x.nonce === time * 1000));
      if (hit) { patch.ledger = sql.json(hit as never); patch.venue_at = new Date(hit.time); r = { ...r, ledger: hit }; await this.log('withdraw_in_venue_ledger', r, { venueHash: hit.hash, usdc: hit.usdc, fee: hit.fee }); }
    }
    if (pin && !r.arrival) {
      // the wallet's own chain scan: USDC from the bridge, for the amount less the fee (or the full amount, should the venue charge the fee on top)
      const got = await this.deps.chain.arrivals(pin, a.account, r.created_at.getTime() - 60_000).catch(() => [] as Arrival[]);
      const used = (await sql<{ txid: string }[]>`select arrival->>'txid' as txid from deriv_collateral where account_id = ${r.account_id} and id <> ${r.id} and arrival is not null`).map((x) => x.txid);
      const want = r.ledger?.usdc ? [usdcUnits(D6(r.ledger.usdc))] : [amount - fee, amount];
      const hit = got.find((g) => !used.includes(g.txid) && want.includes(BigInt(g.amount)));
      if (hit) { patch.arrival = sql.json(hit as never); r = { ...r, arrival: hit }; await this.log('withdraw_arrived', r, { txid: hit.txid, received: formatUnits(BigInt(hit.amount), 6) }); }
    }
    const seen = pin ? r.arrival : r.ledger; // testnet: the payout chain is not one of the wallet's networks, the venue's ledger is the last word available
    if (seen && (r.ledger || !pin || now - (r.arrival?.seenAt ?? now) > 10 * 60_000)) {
      const feeSeen = r.ledger?.fee ? usdcUnits(D6(r.ledger.fee)) : null;
      r = await this.set(r, { ...patch, state: 'completed', final: true, done_at: new Date(now), txid: r.arrival?.txid ?? null, balance_after: sql.json(await this.venueBalance(a) as never),
        error: feeSeen !== null && feeSeen !== fee ? `the venue charged ${r.ledger!.fee} USDC, not the ${usdcDecimal(fee)} USDC shown` : null });
      await this.log('withdraw_completed', r, { txid: r.arrival?.txid ?? null, received: r.arrival ? formatUnits(BigInt(r.arrival.amount), 6) : r.ledger?.usdc ?? null, fee: r.ledger?.fee ?? null });
      return r;
    }
    if (r.arrival || r.ledger) return this.set(r, { ...patch, ...(r.state === 'unknown' || r.state === 'signed' ? { state: 'submitted', error: null } : {}) });
    r = await this.set(r, patch);
    if (r.state === 'signed' || r.state === 'unknown') {
      const sent = r.sent_at?.getTime() ?? r.updated_at.getTime();
      if (r.state === 'unknown' && now - sent > WITHDRAW_UNKNOWN_GIVE_UP_MS) {
        r = await this.set(r, { state: 'rejected', final: true, done_at: new Date(now), error: `${WITHDRAW_UNKNOWN_GIVE_UP_MS / 60_000} minutes without any trace of this withdrawal in the venue's ledger or on the wallet: it is taken as not made. ${r.error ?? ''}`.trim() });
        await this.log('withdraw_given_up', r);
        return r;
      }
      const mainnetOk = a.network !== 'mainnet' || this.deps.live.deps.mainnetEnabled();
      // a signed action that never got a readable answer: the identical bytes again (the venue takes a nonce once), a few times
      if (mainnetOk && r.attempts < MAX_SUBMITS && (r.attempts === 0 || now - Number(r.request.lastSubmitAt ?? sent) >= RESUBMIT_EVERY_MS)) return this.submit(a, r);
    }
    return r;
  }

  private async refreshOpen(accountId?: string): Promise<{ checked: number; errors: string[] }> {
    const rows = accountId ? await sql<Row[]>`select * from deriv_collateral where not final and account_id = ${accountId} order by created_at` : await sql<Row[]>`select * from deriv_collateral where not final order by created_at`;
    const errors: string[] = [];
    for (const r of rows) await this.refresh(r).catch((e) => { errors.push(`${r.id}: ${msg(e)}`); });
    return { checked: rows.length, errors };
  }
  /** the worker's pass: every operation in flight, resumable after a restart (all state is in the database) */
  step(): Promise<{ checked: number; errors: string[] }> { return this.refreshOpen(); }
}

/** numeric columns come back as strings with trailing zeros ("12.300000"): the canonical decimal with at most 6 places */
function D6(x: string): string {
  const [w, f = ''] = String(x).split('.');
  const frac = f.replace(/0+$/, '');
  if (frac.length > 6) throw new Error('more than 6 decimals');
  return frac ? `${w}.${frac}` : w!;
}

let shared: CollateralService | null = null;
/** the process-wide instance: the live service's venues and settings, the real signer client, the registry RPC endpoints */
export async function collateral(): Promise<CollateralService> { return (shared ??= new CollateralService({ live: live(), signer, chain: realChain() })); }
export function startCollateralWorker(): void {
  let last = '';
  loop('deriv-collateral', async () => {
    const s = await (await collateral()).step();
    const err = s.errors[0] ?? '';
    if (err && err !== last) console.log(`[derivatives] collateral: ${s.errors.length} error(s) (${err})`);
    last = err;
  }, COLLATERAL_STEP_MS);
}
