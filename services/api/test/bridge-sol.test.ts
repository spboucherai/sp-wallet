// Solana ↔ EVM USDC (Circle CCTP V2) life cycle through the REAL API routes, worker steps and signer process boundary, against
// a scripted Solana cluster, a scripted EVM chain and a scripted attestation service (no network). The scripted cluster
// DECODES the transactions it receives (v1 messages, signatures checked) and plays the three Circle instructions the way the
// source describes them; what the real programs do with the same bytes is proven by mainnet simulation
// (scripts/sim-solana-cctp.mts). Database: one per run (test-db.ts, label bridge_sol).
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-db.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base58 } from '@scure/base';
import { decodeFunctionData, encodeAbiParameters, keccak256, numberToHex, pad, parseTransaction, toFunctionSelector, type Hex } from 'viem';
import {
  ATA_PROGRAM, BPF_UPGRADEABLE_LOADER, CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, CCTP_SOL_DISC, CCTP_SOL_EVENT_RENT, CCTP_SOL_FEE_RECIPIENT, CCTP_SOL_MESSAGE_TRANSMITTER, CCTP_SOL_NONCE_RENT, CCTP_SOL_PINS,
  CCTP_SOL_TOKEN_MESSENGER_MINTER, CCTP_TOKEN_MESSENGER, CCTP_TOKEN_MINTER, cctpBytes32, cctpEnd, cctpRecipient32, cctpSolBytes32, cctpSolPda, cctpSolTokenAccount, decodeCctpMessage, decodeCctpSolEventAccount, decodeSolV1Message,
  EIP1967_IMPLEMENTATION_SLOT, encodeCctpMessage, NETWORKS, SYSTEM_PROGRAM, TOKEN_PROGRAM, type CctpMessage, type Intent,
} from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'q'.repeat(48), DB_LABEL = 'bridge_sol';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), ME = keys.addresses.evm, ME_SOL = keys.addresses.solana!;
const owner = new TestPasskey(RP, ORIGIN);
const CODE = JSON.parse(readFileSync(new URL('./fixtures/cctp-code.json', import.meta.url), 'utf8')) as Record<string, string>;
const usdc = (n: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === 'USDC')!.id;
const USDC_SOL = usdc('solana'), MY_ATA = cctpSolTokenAccount(ME_SOL);
const SEL = { allowance: '0xdd62ed3e', used: toFunctionSelector('usedNonces(bytes32)'), minFee: toFunctionSelector('getMinFeeAmount(uint256)'), burn: '0x8e0250ee', receive: '0x57ecfd28' };
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RENT: Record<number, number> = { 428: Number(CCTP_SOL_EVENT_RENT), 9: Number(CCTP_SOL_NONCE_RENT), 165: 1_488_440, 0: 650_240 };
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex'), pk = (s: string) => Buffer.from(base58.decode(s));
const clock = { skew: 0 }; // moves the signer's and the scripted cluster's clocks together

/** The scripted EVM chain of services/api/test/bridge.test.ts (source and destination of a CCTP transfer). */
class Chain {
  head = 1000; nonce = 0; native = 10n ** 17n; allowance = 0n; pending: { hash: string; raw: string }[] = []; receipts = new Map<string, any>(); used = new Set<string>(); implSlot: Record<string, string>; logs: { message: Hex }[] = [];
  constructor(public id: string) { const p = CCTP_ENABLED[id]!; this.implSlot = { [CCTP_TOKEN_MESSENGER.toLowerCase()]: p.messengerImpl.address, [CCTP_MESSAGE_TRANSMITTER.toLowerCase()]: p.transmitterImpl.address }; }
  mine(status = 1, blocks = 20) {
    for (const t of this.pending) {
      const tx = parseTransaction(t.raw as Hex); this.head += 1; this.nonce = Math.max(this.nonce, tx.nonce! + 1);
      const logs: any[] = [];
      if (status === 1 && tx.to?.toLowerCase() === CCTP_MESSAGE_TRANSMITTER.toLowerCase()) {
        const [message] = decodeFunctionData({ abi: CCTP_ABI, data: tx.data! }).args as [Hex, Hex], m = decodeCctpMessage(message);
        this.used.add(m.nonce);
        logs.push({ address: usdc(this.id), topics: [TRANSFER, pad('0x0', { size: 32 }), `0x${m.body.mintRecipient}`], data: numberToHex(m.body.amount - m.body.feeExecuted, { size: 32 }) });
      }
      this.receipts.set(t.hash, { status: numberToHex(status), blockNumber: numberToHex(this.head), blockHash: keccak256(t.hash as Hex), transactionHash: t.hash, logs });
    }
    this.pending = []; this.head += blocks;
  }
  rpc(method: string, p: any[]): unknown {
    const err = (message: string) => { throw Object.assign(new Error(message), { rpc: true }); };
    switch (method) {
      case 'eth_chainId': return numberToHex(Number(NETWORKS[this.id]!.chainRef));
      case 'eth_blockNumber': return numberToHex(this.head);
      case 'eth_getBlockByNumber': return { number: numberToHex(this.head), baseFeePerGas: '0x989680' };
      case 'eth_maxPriorityFeePerGas': return '0xf4240';
      case 'eth_getBalance': return numberToHex(this.native);
      case 'eth_getTransactionCount': return numberToHex(p[1] === 'pending' ? this.nonce + this.pending.length : this.nonce);
      case 'eth_getCode': { const a = String(p[0]).toLowerCase();
        if (a === CCTP_TOKEN_MESSENGER.toLowerCase() || a === CCTP_MESSAGE_TRANSMITTER.toLowerCase()) return CODE.proxy;
        if (a === CCTP_TOKEN_MINTER.toLowerCase()) return CODE.minter;
        return CODE[a] ?? '0x'; }
      case 'eth_getStorageAt': return p[1] === EIP1967_IMPLEMENTATION_SLOT ? pad((this.implSlot[String(p[0]).toLowerCase()] ?? '0x0') as Hex, { size: 32 }).toLowerCase() : pad('0x0', { size: 32 });
      case 'eth_estimateGas': case 'eth_call': { const d = String(p[0].data), sel = d.slice(0, 10);
        if (sel === SEL.allowance) return numberToHex(this.allowance, { size: 32 });
        if (sel === SEL.used) return numberToHex(this.used.has(d.slice(10, 74)) ? 1 : 0, { size: 32 });
        if (sel === SEL.minFee) return err('execution reverted');
        if (sel === SEL.burn) return this.allowance < 1n ? err('execution reverted: ERC20: transfer amount exceeds allowance') : method === 'eth_call' ? '0x' : '0x1a000';
        if (sel === SEL.receive) return method === 'eth_call' ? encodeAbiParameters([{ type: 'bool' }], [true]) : '0x2a000';
        return err('execution reverted'); }
      case 'eth_sendRawTransaction': { const hash = keccak256(p[0] as Hex); if (!this.pending.some((x) => x.hash === hash) && !this.receipts.has(hash)) this.pending.push({ hash, raw: p[0] });
        const tx = parseTransaction(p[0] as Hex); if (tx.to?.toLowerCase() === usdc(this.id).toLowerCase()) this.allowance = 10n ** 30n;
        return hash; }
      case 'eth_getTransactionReceipt': return this.receipts.get(String(p[0])) ?? null;
      case 'eth_getLogs': return [];
      default: return err(`unscripted ${method}`);
    }
  }
}

/** A scripted Solana cluster: system accounts, USDC token accounts, the accounts Circle's programs create — and the three instructions. */
class Sol {
  height = 5000; slot = 9000; lamports = new Map<string, bigint>(); tokens = new Map<string, { owner: string; amount: bigint; state: string }>();
  accts = new Map<string, { owner: string; lamports: bigint; data: Buffer }>(); pending: { sig: string; wire: Uint8Array }[] = []; txs = new Map<string, { err: unknown; slot: number; keys: string[]; pre: any[]; post: any[] }>();
  nonceTx = new Map<string, string>(); pin = { slot: { ...{ t: CCTP_SOL_PINS.transmitter.lastDeploySlot, m: CCTP_SOL_PINS.messenger.lastDeploySlot } }, feeRecipient: CCTP_SOL_FEE_RECIPIENT }; drop = false; sent: string[] = []; sigChecks = 0;
  now = () => Math.floor(Date.now() / 1000) + clock.skew;
  private tokBal(keys: string[]) { return keys.flatMap((k, n) => { const t = this.tokens.get(k); return t ? [{ accountIndex: n, mint: USDC_SOL, owner: t.owner, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: t.amount.toString(), decimals: 6 } }] : []; }); }
  private lam(k: string): bigint { return this.lamports.get(k) ?? this.accts.get(k)?.lamports ?? (this.tokens.has(k) ? 1_488_440n : 0n); }
  /** run a transaction. `commit` false = simulation (state restored). */
  run(wire: Uint8Array, o: { sigVerify: boolean; commit: boolean; want?: string[] }) {
    const n = wire[1]!, msg = wire.subarray(0, wire.length - 64 * n), d = decodeSolV1Message(msg), payer = d.payer;
    if (o.sigVerify) for (let k = 0; k < n; k++) { this.sigChecks++;
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk(d.keys[k]!)]), format: 'der', type: 'spki' });
      if (!edVerify(null, msg, key, wire.subarray(msg.length + 64 * k, msg.length + 64 * (k + 1)))) return { err: 'SignatureFailure', logs: [], keys: d.keys }; }
    const snap = { lamports: new Map(this.lamports), tokens: new Map([...this.tokens].map(([k, v]) => [k, { ...v }])), accts: new Map(this.accts) };
    const pre = d.keys.map((k) => Number(this.lam(k))), preTok = this.tokBal(d.keys), fee = 5000n * BigInt(n) + d.priorityFeeLamports, logs: string[] = [];
    let err: unknown = null, units = 0;
    const pay = (v: bigint) => { const b = this.lamports.get(payer) ?? 0n; if (b < v) throw { InstructionError: [0, { Custom: 1 }], log: 'Transfer: insufficient lamports' }; this.lamports.set(payer, b - v); };
    try {
      if ((this.lamports.get(payer) ?? 0n) < fee) throw 'InsufficientFundsForFee';
      this.lamports.set(payer, this.lamports.get(payer)! - fee);
      for (const ix of d.instructions) {
        const disc = hx(ix.data.subarray(0, 8)), a = ix.accounts, data = Buffer.from(ix.data);
        if (ix.program === CCTP_SOL_TOKEN_MESSENGER_MINTER && disc === CCTP_SOL_DISC.depositForBurn) {
          units += 41_763; logs.push('Program log: Instruction: DepositForBurn');
          const amount = data.readBigUInt64LE(8), domain = data.readUInt32LE(16), t = this.tokens.get(a[3]!);
          if (a.length !== 18 || a[0] !== payer || a[1] !== payer || !d.keys.slice(0, n).includes(a[11]!) || a[10] !== USDC_SOL || a[7] !== cctpSolPda.remoteTokenMessenger(domain)) throw { InstructionError: [0, { Custom: 3012 }], log: 'bad accounts' };
          if (!t || t.owner !== a[0] || t.amount < amount) throw { InstructionError: [0, { Custom: 1 }], log: 'Error: insufficient funds' };
          t.amount -= amount; pay(CCTP_SOL_EVENT_RENT);
          const message = encodeCctpMessage({ version: 1, sourceDomain: 5, destinationDomain: domain, nonce: '0'.repeat(64), sender: cctpSolBytes32(CCTP_SOL_TOKEN_MESSENGER_MINTER), recipient: cctpBytes32(CCTP_TOKEN_MESSENGER), destinationCaller: data.subarray(52, 84).toString('hex'),
            minFinalityThreshold: data.readUInt32LE(92), finalityThresholdExecuted: 0, body: { version: 1, burnToken: cctpSolBytes32(a[10]!), mintRecipient: data.subarray(20, 52).toString('hex'), amount, messageSender: cctpSolBytes32(a[0]!), maxFee: data.readBigUInt64LE(84), feeExecuted: 0n, expirationBlock: 0n } });
          const mb = Buffer.from(message.slice(2), 'hex'), head = Buffer.alloc(52); Buffer.from(CCTP_SOL_DISC.messageSentAccount, 'hex').copy(head); pk(payer).copy(head, 8); head.writeBigInt64LE(BigInt(this.now()), 40); head.writeUInt32LE(mb.length, 48);
          this.accts.set(a[11]!, { owner: CCTP_SOL_MESSAGE_TRANSMITTER, lamports: CCTP_SOL_EVENT_RENT, data: Buffer.concat([head, mb]) });
        } else if (ix.program === CCTP_SOL_MESSAGE_TRANSMITTER && disc === CCTP_SOL_DISC.receiveMessage) {
          units += 190_000; logs.push('Program log: Instruction: ReceiveMessage');
          const ml = data.readUInt32LE(8), m = decodeCctpMessage(`0x${data.subarray(12, 12 + ml).toString('hex')}`), nonceAcct = cctpSolPda.usedNonce(m.nonce), t = this.tokens.get(a[15]!);
          if (a.length !== 20 || a[4] !== nonceAcct || a[13] !== cctpSolPda.tokenPair(m.sourceDomain, m.body.burnToken) || a[15] !== base58.encode(Buffer.from(m.body.mintRecipient, 'hex'))) throw { InstructionError: [0, { Custom: 3012 }], log: 'bad accounts' };
          if (this.accts.has(nonceAcct)) throw { InstructionError: [0, { Custom: 0 }], log: `Allocate: account Address { address: ${nonceAcct}, base: None } already in use` };
          if (!t) throw { InstructionError: [0, { Custom: 3012 }], log: 'AnchorError caused by account: recipient_token_account. Error Code: AccountNotInitialized' };
          pay(CCTP_SOL_NONCE_RENT); this.accts.set(nonceAcct, { owner: CCTP_SOL_MESSAGE_TRANSMITTER, lamports: CCTP_SOL_NONCE_RENT, data: Buffer.alloc(9, 1) });
          t.amount += m.body.amount - m.body.feeExecuted; this.nonceTx.set(nonceAcct, base58.encode(wire.subarray(msg.length, msg.length + 64)));
        } else if (ix.program === CCTP_SOL_MESSAGE_TRANSMITTER && disc === CCTP_SOL_DISC.reclaimEventAccount) {
          units += 145_227; logs.push('Program log: Instruction: ReclaimEventAccount');
          const ev = this.accts.get(a[2]!);
          if (!ev || decodeCctpSolEventAccount(ev.data).rentPayer !== a[0] || a[0] !== payer) throw { InstructionError: [0, { Custom: 2003 }], log: 'A raw constraint was violated' };
          if (this.now() < decodeCctpSolEventAccount(ev.data).createdAt + 5 * 86400) throw { InstructionError: [0, { Custom: 6033 }], log: 'Program log: AnchorError thrown. Error Code: EventAccountWindowNotExpired. Error Number: 6033.' };
          this.accts.delete(a[2]!); this.lamports.set(payer, this.lamports.get(payer)! + ev.lamports);
        } else if (ix.program === ATA_PROGRAM && data.length === 1 && data[0] === 1) {
          units += 17_917;
          if (a[1] !== cctpSolTokenAccount(a[2]!) || a[3] !== USDC_SOL || a[0] !== payer) throw { InstructionError: [0, { Custom: 0 }], log: 'bad token account' };
          if (!this.tokens.has(a[1]!)) { pay(1_488_440n); this.tokens.set(a[1]!, { owner: a[2]!, amount: 0n, state: 'initialized' }); }
        } else throw { InstructionError: [0, 'ProgramNotScripted'], log: `unscripted program ${ix.program}` };
      }
    } catch (e) { err = typeof e === 'string' ? e : { InstructionError: (e as any).InstructionError }; if ((e as any).log) logs.push((e as any).log); }
    const failedState = () => { Object.assign(this, { tokens: snap.tokens, accts: snap.accts }); this.lamports = snap.lamports; if (err !== 'InsufficientFundsForFee' && o.commit) this.lamports.set(payer, (this.lamports.get(payer) ?? 0n) - fee); };
    if (err) failedState();
    const out = { err, logs, unitsConsumed: units, fee: Number(fee), keys: d.keys, preBalances: pre, postBalances: d.keys.map((k) => Number(this.lam(k))), preTokenBalances: preTok, postTokenBalances: this.tokBal(d.keys),
      accounts: (o.want ?? []).map((w) => { const x = this.accts.get(w); return x ? { owner: x.owner, lamports: Number(x.lamports), executable: false, data: [x.data.toString('base64'), 'base64'] } : null; }) };
    if (!o.commit && !err) { this.lamports = snap.lamports; this.tokens = snap.tokens; this.accts = snap.accts; }
    return out;
  }
  mine(blocks = 40) {
    for (const t of this.pending) { if (this.drop) continue; this.slot += 1; const r = this.run(t.wire, { sigVerify: true, commit: true }); this.txs.set(t.sig, { err: r.err, slot: this.slot, keys: r.keys, pre: (r as any).preTokenBalances ?? [], post: (r as any).postTokenBalances ?? [] }); }
    this.pending = []; this.height += blocks; this.slot += blocks;
  }
  info(addr: string, o: any = {}): unknown {
    const slice = (b: Buffer) => { const s = o.dataSlice ? b.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length) : b; return [s.toString('base64'), 'base64']; };
    for (const [pin, slot] of [[CCTP_SOL_PINS.transmitter, this.pin.slot.t], [CCTP_SOL_PINS.messenger, this.pin.slot.m]] as const) {
      if (addr === pin.program) { const b = Buffer.alloc(36); b.writeUInt32LE(2); pk(pin.programData).copy(b, 4); return { owner: BPF_UPGRADEABLE_LOADER, executable: true, lamports: 1, data: slice(b) }; }
      if (addr === pin.programData) { const b = Buffer.alloc(45 + 8); b.writeUInt32LE(3); b.writeBigUInt64LE(BigInt(slot), 4); b[12] = 1; pk(pin.upgradeAuthority).copy(b, 13); return { owner: BPF_UPGRADEABLE_LOADER, executable: false, lamports: 1, data: slice(b) }; }
    }
    if (addr === USDC_SOL) return { owner: TOKEN_PROGRAM, executable: false, lamports: 1, data: o.encoding === 'jsonParsed' ? { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, freezeAuthority: 'x' } } } : slice(Buffer.alloc(82)) };
    if (addr === cctpSolPda.tokenMessenger()) { const b = Buffer.alloc(185); b.writeUInt32LE(1, 104); pk(this.pin.feeRecipient).copy(b, 109); return { owner: CCTP_SOL_TOKEN_MESSENGER_MINTER, executable: false, lamports: 1, data: slice(b) }; }
    const t = this.tokens.get(addr);
    if (t) return { owner: TOKEN_PROGRAM, executable: false, lamports: 1_488_440, data: o.encoding === 'jsonParsed' ? { program: 'spl-token', parsed: { type: 'account', info: { mint: USDC_SOL, owner: t.owner, state: t.state, tokenAmount: { amount: t.amount.toString(), decimals: 6 } } } } : slice(Buffer.alloc(165)) };
    const x = this.accts.get(addr);
    if (x) return { owner: x.owner, executable: false, lamports: Number(x.lamports), data: slice(x.data) };
    if (this.lamports.has(addr)) return { owner: SYSTEM_PROGRAM, executable: false, lamports: Number(this.lamports.get(addr)), data: slice(Buffer.alloc(0)) };
    return null;
  }
  rpc(method: string, p: any[]): unknown {
    switch (method) {
      case 'getGenesisHash': return NETWORKS.solana!.chainRef;
      case 'getAccountInfo': return { value: this.info(p[0], p[1]) };
      case 'getMinimumBalanceForRentExemption': return RENT[p[0] as number] ?? 9_999_999;
      case 'getRecentPrioritizationFees': return [];
      case 'getLatestBlockhash': return { value: { blockhash: base58.encode(createHash('sha256').update(`bh${this.height}`).digest()), lastValidBlockHeight: this.height + 150 } };
      case 'getBalance': return { value: Number(this.lamports.get(p[0]) ?? 0n) };
      case 'getBlockHeight': return this.height;
      case 'getSlot': return this.slot;
      case 'simulateTransaction': return { value: this.run(new Uint8Array(Buffer.from(p[0], 'base64')), { sigVerify: !!p[1]?.sigVerify, commit: false, want: p[1]?.accounts?.addresses }) };
      case 'sendTransaction': { const wire = new Uint8Array(Buffer.from(p[0], 'base64')), nSig = wire[1]!, sig = base58.encode(wire.subarray(wire.length - 64 * nSig, wire.length - 64 * (nSig - 1)));
        const check = this.run(wire, { sigVerify: true, commit: false }); if (check.err === 'SignatureFailure') throw new Error('Transaction signature verification failure');
        if (!this.pending.some((x) => x.sig === sig) && !this.txs.has(sig)) { this.pending.push({ sig, wire }); this.sent.push(sig); } return sig; }
      case 'getSignatureStatuses': return { value: (p[0] as string[]).map((s) => { const t = this.txs.get(s); return t ? { err: t.err, confirmationStatus: 'finalized', confirmations: null, slot: t.slot } : null; }) };
      case 'getTransaction': { const t = this.txs.get(p[0]); return t ? { transaction: { message: { accountKeys: t.keys } }, meta: { err: t.err, preTokenBalances: t.pre, postTokenBalances: t.post } } : null; }
      case 'getSignaturesForAddress': { const s = this.nonceTx.get(p[0]); return s ? [{ signature: s }] : []; }
      default: throw new Error(`unscripted ${method}`);
    }
  }
}

const chain = new Chain('base'), sol = new Sol();
const iris: { messages: Map<string, unknown> } = { messages: new Map() };
let fake: Server, signerSrv: Server, app: any, sql: any, worker: any, bridge: any, adapters: any, cookie = '', store: Store;
async function api(method: string, path: string, body?: unknown, idem?: string) {
  const r = await app.inject({ method, url: path, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const row = async (id: string) => (await sql`select * from proposals where id = ${id}`)[0];
const getP = async (id: string) => (await api('GET', `/api/v1/transfers/proposals/${id}`)).json;
const assert = (options: any) => owner.assert(Buffer.from(options.challenge, 'base64url'));
const tick = async () => { await worker.reconcile(); await sql`update proposals set bridge = jsonb_set(bridge, '{nextAt}', '0') where kind = 'bridge'`; await bridge.advanceBridges(); };
const asCircle = (m: CctpMessage, nonce: string): Hex => encodeCctpMessage({ ...m, nonce, finalityThresholdExecuted: m.minFinalityThreshold });
const attest = (txid: string, message: Hex) => iris.messages.set(txid, { messages: [{ status: 'complete', message, attestation: `0x${'33'.repeat(130)}`, cctpVersion: 2, delayReason: null }] });
async function prepare(body: unknown) {
  const prep = await api('POST', '/api/v1/bridge/proposals', body, crypto.randomUUID());
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  return prep.json as { proposal: any; options: any };
}
const approve = async (prep: { proposal: any; options: any }) => { const ap = await api('POST', `/api/v1/transfers/proposals/${prep.proposal.id}/approve`, { assertion: assert(prep.options) }); expect(ap.status, JSON.stringify(ap.json)).toBe(200); return ap.json; };

beforeAll(async () => {
  const DB = (await createTestDb(DB_LABEL)).name;   // v8: unique per checkout and per run (test-db.ts)
  fake = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const send = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = new URL(req.url!, 'http://x');
      if (url.pathname.startsWith('/rpc/')) { const j = JSON.parse(body), target = url.pathname.slice(5) === 'solana' ? sol : chain;
        try { send(200, { jsonrpc: '2.0', id: j.id, result: target.rpc(j.method, j.params) }); } catch (e) { send(200, { jsonrpc: '2.0', id: j.id, error: { code: 3, message: (e as Error).message } }); } return; }
      if (url.pathname.startsWith('/v2/burn/USDC/fees/')) return send(200, [{ finalityThreshold: 1000, minimumFee: 1 }, { finalityThreshold: 2000, minimumFee: 0 }]);
      if (url.pathname === '/v2/fastBurn/USDC/allowance') return send(200, { allowance: 5e7 });
      if (url.pathname.startsWith('/v2/messages/')) { const m = iris.messages.get(url.searchParams.get('transactionHash') ?? ''); return m ? send(200, m) : send(404, { error: 'Message not found for provided parameters' }); }
      if (url.pathname.startsWith('/v2/reattest/')) return send(200, { message: 'ok' });
      send(404, {});
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'spw-bridge-sol-api-'));
  store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('bridge-sol-setup').digest('hex');
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => Math.floor(Date.now() / 1000) + clock.skew), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_IRIS_OVERRIDE: base, SPW_RPC_OVERRIDE: JSON.stringify({ base: [`${base}/rpc/base`, `${base}/rpc/base`], solana: [`${base}/rpc/solana`, `${base}/rpc/solana`] }) });
  const warn = console.warn; console.warn = () => {};
  const db = await import('../src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  await import('../src/rpc-override.ts');
  adapters = (await import('../src/chains/index.ts')).adapters;
  adapters.base.balances = async () => ({ native: chain.native, [usdc('base')]: 100_000000n });
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [] });
  worker = await import('../src/worker.ts'); bridge = await import('../src/bridge.ts');
  console.warn = warn;
  const o = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'bridge-sol-setup' });
  expect(s.status, JSON.stringify(s.json)).toBe(200); cookie = String(s.setCookie).split(';')[0]!;
});
afterAll(async () => { await app?.close(); signerSrv?.close(); fake?.close(); await sql?.end(); });
beforeEach(async () => {
  await sql`update proposals set state = 'failed' where state not in ('finalized', 'failed', 'expired', 'rejected', 'replaced')`;
  await sql`update proposals set bridge = jsonb_set(bridge, '{phase}', '"done"') where kind = 'bridge'`;
  store.state.spent = {}; store.save();
  chain.mine(); chain.native = 10n ** 17n; chain.allowance = 0n; sol.mine(); sol.drop = false; sol.sent = [];
  sol.pin = { slot: { t: CCTP_SOL_PINS.transmitter.lastDeploySlot, m: CCTP_SOL_PINS.messenger.lastDeploySlot }, feeRecipient: CCTP_SOL_FEE_RECIPIENT };
  sol.lamports.set(ME_SOL, 50_000_000n); sol.tokens.set(MY_ATA, { owner: ME_SOL, amount: 100_000000n, state: 'initialized' });
});

describe('Solana → EVM', () => {
  it('quote: both speeds with Circle\'s documented times for Solana, the refundable deposit, and the gas needed on the destination', async () => {
    const q = (await api('GET', '/api/v1/bridge/quote?from=solana&to=base&amount=10')).json;
    expect(q.options.map((o: any) => [o.speed, o.available, o.feeDisplay, o.seconds])).toEqual([['standard', true, '0', 17], ['fast', true, '0.001', 1]]);
    expect(q.solana).toMatchObject({ role: 'source', depositDisplay: '0.00282448', reclaimAfterSeconds: 432000, symbol: 'SOL' });
    expect(q.destinationGas).toMatchObject({ symbol: 'ETH', enough: true });
    expect((await api('GET', '/api/v1/bridge/execution')).json.networks).toContain('solana');
  });
  it('the whole transfer: burn built and co-signed by the signer, attestation, EVM mint to the wallet\'s own address — then, five days later, the deposit', async () => {
    const lam0 = sol.lamports.get(ME_SOL)!;
    const prep = await prepare({ fromNetwork: 'solana', toNetwork: 'base', amount: '10', speed: 'standard' });
    expect(prep.proposal).toMatchObject({ network: 'solana', state: 'pending_approval', kind: 'bridge', warnings: [], bridge: { stage: 'review', toNetwork: 'base', speed: 'standard', expectedSeconds: 17, simulated: true, needsApproval: false,
      sol: { role: 'source', depositDisplay: '0.00282448', reclaimState: 'pending', recipient: ME } } });
    expect(BigInt(prep.proposal.maxFee)).toBeLessThanOrEqual(3_000_000n); // fee + deposit inside the signer's fee ceiling for Solana
    const intent = (await row(prep.proposal.id)).intent as Intent;
    expect(intent.bridge).toMatchObject({ toNetwork: 'base', toDomain: 6, recipient: ME, messenger: CCTP_SOL_TOKEN_MESSENGER_MINTER, transmitter: CCTP_SOL_MESSAGE_TRANSMITTER, approveGas: '0' }); expect(intent.from).toBe(ME_SOL);
    const checks0 = sol.sigChecks;
    const ap = await approve(prep);
    expect(ap.state).toBe('broadcast');
    const ev = store.state.bridges![prep.proposal.id]!.sol!.eventAccount;
    expect((await row(prep.proposal.id)).bridge.sol.eventAccount).toBe(ev); // read back from the signed bytes and compared with the rebuilt burn
    expect(sol.pending).toHaveLength(1); expect(sol.sigChecks - checks0).toBeGreaterThanOrEqual(4); // both signatures checked at the last gate and on receipt
    const d = decodeSolV1Message(sol.pending[0]!.wire.subarray(0, sol.pending[0]!.wire.length - 128));
    expect(d.keys.slice(0, 2)).toEqual([ME_SOL, ev]); expect(d.instructions).toHaveLength(1);
    sol.mine(); await tick();
    let p = await getP(prep.proposal.id);
    expect(p.state).toBe('finalized'); expect(p.bridge.stage).toBe('attesting');
    expect(sol.tokens.get(MY_ATA)!.amount).toBe(90_000000n); expect(lam0 - sol.lamports.get(ME_SOL)!).toBe(BigInt(prep.proposal.maxFee)); // amount burned; fee + deposit paid
    expect(p.bridge.sol).toMatchObject({ eventAccount: ev, reclaimState: 'locked', reclaimEstimated: false });
    // Circle attests the message the program stored
    const stored = decodeCctpSolEventAccount(sol.accts.get(ev)!.data), m = decodeCctpMessage(`0x${hx(stored.message)}`);
    expect(m.body.messageSender).toBe(cctpSolBytes32(ME_SOL)); expect(m.body.mintRecipient).toBe(cctpBytes32(ME));
    // an answer that is not this burn is not used
    attest(p.txid, asCircle({ ...m, body: { ...m.body, mintRecipient: cctpBytes32('0x70997970C51812dc3A010C7d01b50e0d17dc79C8') } }, '77'.repeat(32)));
    await tick(); p = await getP(prep.proposal.id);
    expect(p.bridge).toMatchObject({ stage: 'attesting', hold: 'message_mismatch' });
    attest(p.txid, asCircle(m, '78'.repeat(32)));
    await tick(); p = await getP(prep.proposal.id);
    expect(p.bridge.stage).toBe('minting');
    const mint = parseTransaction(chain.pending[0]!.raw as Hex);
    expect(mint.to!.toLowerCase()).toBe(CCTP_MESSAGE_TRANSMITTER.toLowerCase());
    chain.mine(); await tick(); p = await getP(prep.proposal.id);
    expect(p.bridge).toMatchObject({ stage: 'done', mintedBy: 'wallet', received: '10000000' });
    expect(store.state.bridges![prep.proposal.id]!.mint!.signatures).toBe(1);

    // the deposit: not before five days (the API says when), then with the passkey
    const early = await api('POST', `/api/v1/bridge/proposals/${prep.proposal.id}/reclaim/options`, {});
    expect(early.status).toBe(409); expect(early.json.error).toBe('reclaim_not_yet');
    clock.skew = 5 * 86400 + 600; // the signer's and the cluster's clocks; the API's own notion comes from the event account
    await sql`update proposals set bridge = jsonb_set(bridge, '{sol,reclaimableAt}', ${String(Math.floor(Date.now() / 1000) - 60)}::jsonb) where id = ${prep.proposal.id}`;
    p = await getP(prep.proposal.id); expect(p.bridge.sol.reclaimState).toBe('available');
    const ro = await api('POST', `/api/v1/bridge/proposals/${prep.proposal.id}/reclaim/options`, {});
    expect(ro.status, JSON.stringify(ro.json)).toBe(200); expect(ro.json.deposit).toBe('2824480');
    const bad = await api('POST', `/api/v1/bridge/proposals/${prep.proposal.id}/reclaim`, { assertion: owner.assert(new Uint8Array(32)) });
    expect(bad.status).toBe(422); expect(bad.json.error).toBe('signer_bad_approval');
    const lam1 = sol.lamports.get(ME_SOL)!;
    const rc = await api('POST', `/api/v1/bridge/proposals/${prep.proposal.id}/reclaim`, { assertion: assert(ro.json.options) });
    expect(rc.status, JSON.stringify(rc.json)).toBe(200); expect(rc.json.bridge.sol.reclaimState).toBe('sent');
    const rd = decodeSolV1Message(sol.pending[0]!.wire.subarray(0, sol.pending[0]!.wire.length - 64));
    expect(rd.instructions[0]!.accounts).toEqual([ME_SOL, cctpSolPda.messageTransmitter(), ev]);
    sol.mine(); await tick(); p = await getP(prep.proposal.id);
    expect(p.bridge.sol).toMatchObject({ reclaimState: 'done', reclaimTxid: rc.json.bridge.sol.reclaimTxid });
    expect(sol.accts.has(ev)).toBe(false); expect(sol.lamports.get(ME_SOL)! - lam1).toBe(CCTP_SOL_EVENT_RENT - 5000n - BigInt(rd.priorityFeeLamports));
    expect((await api('POST', `/api/v1/bridge/proposals/${prep.proposal.id}/reclaim/options`, {})).json.error).toBe('bad_state');
    clock.skew = 0;
    const audit = (await api('GET', '/api/v1/security/audit?limit=200')).json;
    expect(audit.intact).toBe(true);
    expect(audit.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['bridge.prepared', 'bridge.event_account', 'bridge.burned', 'bridge.attested', 'bridge.mint_signed', 'bridge.done', 'bridge.reclaim_signed', 'bridge.deposit_reclaimed']));
  });
  it('refuses BEFORE any approval: not enough USDC, not enough SOL for fee + deposit, no gas on the destination, a changed program, a changed fee recipient, a Token-2022 or frozen account', async () => {
    const post = (amount = '10') => api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'solana', toNetwork: 'base', amount, speed: 'standard' }, crypto.randomUUID());
    expect((await post('1000')).json.error).toBe('insufficient_funds');
    expect((await post('60')).json.error).toBe('policy');
    sol.lamports.set(ME_SOL, 2_000_000n);
    expect((await post()).json).toMatchObject({ error: 'insufficient_gas', message: expect.stringMatching(/refundable deposit of 0\.00282448 SOL/) });
    sol.lamports.set(ME_SOL, 50_000_000n); chain.native = 0n;
    expect((await post()).json).toMatchObject({ error: 'destination_gas', message: expect.stringMatching(/Nothing was burned/) });
    chain.native = 10n ** 17n; sol.pin.slot.m += 1;
    expect((await post()).json).toMatchObject({ error: 'contract_changed', message: expect.stringMatching(/TokenMessengerMinterV2/) });
    sol.pin.slot.m -= 1; sol.pin.feeRecipient = ME_SOL;
    expect((await post()).json).toMatchObject({ error: 'contract_changed', message: expect.stringMatching(/fee recipient/) });
    sol.pin.feeRecipient = CCTP_SOL_FEE_RECIPIENT; sol.tokens.get(MY_ATA)!.state = 'frozen';
    expect((await post()).json.error).toBe('account_frozen');
    sol.tokens.get(MY_ATA)!.state = 'initialized';
    expect(store.state.bridges?.[''] ?? null).toBeNull(); expect(sol.sent).toEqual([]);
    expect((await post()).status).toBe(200);
  });
  it('a burn that was not included in time fails without anything burned', async () => {
    const prep = await prepare({ fromNetwork: 'solana', toNetwork: 'base', amount: '5', speed: 'fast' });
    expect(prep.proposal.bridge).toMatchObject({ speed: 'fast', expectedSeconds: 1, cctpMaxFee: '500' });
    sol.drop = true; await approve(prep); sol.mine(400); await tick();
    const p = await getP(prep.proposal.id);
    expect(p.state).toBe('failed'); expect(p.error).toMatch(/expired before inclusion/); expect(sol.tokens.get(MY_ATA)!.amount).toBe(100_000000n);
  });
});

describe('EVM → Solana', () => {
  const start = async (amount = '10') => prepare({ fromNetwork: 'base', toNetwork: 'solana', amount, speed: 'standard' });
  async function burned(amount = '10') {
    const prep = await start(amount); await approve(prep);
    for (let k = 0; k < 4 && (await getP(prep.proposal.id)).state !== 'finalized'; k++) { chain.mine(); await worker.reconcile(); }
    const intent = (await row(prep.proposal.id)).intent as Intent, src = cctpEnd('base')!, dst = cctpEnd('solana')!;
    const message: CctpMessage = { version: 1, sourceDomain: 6, destinationDomain: 5, nonce: createHash('sha256').update(prep.proposal.id).digest('hex'), sender: src.messenger, recipient: dst.messenger, destinationCaller: '0'.repeat(64), minFinalityThreshold: 2000, finalityThresholdExecuted: 2000,
      body: { version: 1, burnToken: src.usdc, mintRecipient: cctpRecipient32(dst, ME_SOL), amount: BigInt(intent.amount), messageSender: cctpBytes32(ME), maxFee: 0n, feeExecuted: 0n, expirationBlock: 0n } };
    return { id: prep.proposal.id as string, intent, message, txid: (await getP(prep.proposal.id)).txid as string };
  }
  it('refuses to burn toward a token account that does not exist; creating it is a small passkey-approved transaction; then the transfer goes through', async () => {
    sol.tokens.delete(MY_ATA);
    const q = (await api('GET', '/api/v1/bridge/quote?from=base&to=solana&amount=10')).json;
    expect(q.solana).toMatchObject({ role: 'destination', recipient: ME_SOL, tokenAccount: MY_ATA, tokenAccountExists: false, tokenAccountRentDisplay: '0.00148844', nonceRentDisplay: '0.00069596' });
    expect(q.destinationGas).toMatchObject({ symbol: 'SOL', enough: true });
    const no = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'solana', amount: '10', speed: 'standard' }, crypto.randomUUID());
    expect(no.status).toBe(422); expect(no.json).toMatchObject({ error: 'token_account_missing', message: expect.stringMatching(/Nothing was burned/) });
    expect(chain.pending).toEqual([]);
    // create it
    expect((await api('GET', '/api/v1/bridge/solana/token-account')).json).toMatchObject({ owner: ME_SOL, tokenAccount: MY_ATA, exists: false });
    const o = (await api('POST', '/api/v1/bridge/solana/token-account/options', {})).json;
    expect(o).toMatchObject({ tokenAccount: MY_ATA, rentDisplay: '0.00148844', symbol: 'SOL' });
    expect((await api('POST', '/api/v1/bridge/solana/token-account', { requestId: o.requestId, assertion: owner.assert(new Uint8Array(32)) })).json.error).toBe('signer_bad_approval');
    const o2 = (await api('POST', '/api/v1/bridge/solana/token-account/options', {})).json, lam = sol.lamports.get(ME_SOL)!;
    const made = await api('POST', '/api/v1/bridge/solana/token-account', { requestId: o2.requestId, assertion: assert(o2.options) });
    expect(made.status, JSON.stringify(made.json)).toBe(200); expect(made.json).toMatchObject({ sent: true, tokenAccount: MY_ATA });
    expect((await api('POST', '/api/v1/bridge/solana/token-account', { requestId: o2.requestId, assertion: assert(o2.options) })).status).toBe(410); // one use
    sol.mine();
    expect(sol.tokens.get(MY_ATA)).toMatchObject({ owner: ME_SOL, amount: 0n }); expect(lam - sol.lamports.get(ME_SOL)!).toBe(1_488_440n + BigInt(o2.networkFee));
    expect((await api('POST', '/api/v1/bridge/solana/token-account/options', {})).json.error).toBe('bad_state'); // it exists now
    // and the transfer
    const prep = await start();
    expect(prep.proposal.bridge).toMatchObject({ stage: 'review', toNetwork: 'solana', destGasSymbol: 'SOL', sol: { role: 'destination', recipient: ME_SOL, tokenAccount: MY_ATA, nonceRentDisplay: '0.00069596' } });
    const intent = (await row(prep.proposal.id)).intent as Intent;
    expect(intent.bridge).toMatchObject({ toNetwork: 'solana', toDomain: 5, recipient: ME_SOL }); expect(intent.to).toBe(ME);
  });
  it('the whole transfer: EVM burn naming the wallet\'s token account, attestation, the Solana mint built by the signer, received amount read from the chain', async () => {
    const lam0 = sol.lamports.get(ME_SOL)!, b = await burned();
    const burn = parseTransaction((await row(b.id)).raw as Hex), args = decodeFunctionData({ abi: CCTP_ABI, data: burn.data! }).args as readonly unknown[];
    expect(args[1]).toBe(5); expect(args[2]).toBe(`0x${cctpSolBytes32(MY_ATA)}`);
    await tick(); expect((await getP(b.id)).bridge.stage).toBe('attesting');
    // an attested message that would credit the wallet ADDRESS (not its token account) is not used
    attest(b.txid, encodeCctpMessage({ ...b.message, body: { ...b.message.body, mintRecipient: cctpSolBytes32(ME_SOL) } }));
    await tick(); expect((await getP(b.id)).bridge.hold).toBe('message_mismatch');
    attest(b.txid, encodeCctpMessage(b.message));
    await tick(); let p = await getP(b.id);
    expect(p.bridge.stage).toBe('minting'); expect(sol.pending).toHaveLength(1);
    const d = decodeSolV1Message(sol.pending[0]!.wire.subarray(0, sol.pending[0]!.wire.length - 64));
    expect(d.numSigners).toBe(1); expect(d.payer).toBe(ME_SOL); expect(d.instructions[0]!.accounts[15]).toBe(MY_ATA); expect(d.computeUnitLimit).toBe(248_000); // 190 000 simulated × 1.2 + 20 000
    await tick(); expect((await getP(b.id)).bridge.stage).toBe('minting'); // not included yet: waits, signs nothing more
    sol.mine(); await tick(); p = await getP(b.id);
    expect(p.bridge).toMatchObject({ stage: 'done', mintedBy: 'wallet', received: '10000000', mintTxid: sol.sent.at(-1) });
    expect(sol.tokens.get(MY_ATA)!.amount).toBe(110_000000n); expect(lam0 - sol.lamports.get(ME_SOL)!).toBe(5000n + d.priorityFeeLamports + CCTP_SOL_NONCE_RENT);
    expect(store.state.bridges![b.id]!.mint!.signatures).toBe(1);
    // "finish" on a finished transfer does nothing
    expect((await api('POST', `/api/v1/bridge/proposals/${b.id}/finish`, {})).json.bridge.stage).toBe('done'); expect(sol.pending).toEqual([]);
  });
  it('a mint that was not included in time: the single automatic signature is spent, the next one needs the passkey', async () => {
    const b = await burned('7'); attest(b.txid, encodeCctpMessage(b.message));
    sol.drop = true; await tick(); expect((await getP(b.id)).bridge.stage).toBe('minting');
    sol.mine(400); await tick(); let p = await getP(b.id);
    expect(p.bridge).toMatchObject({ stage: 'mint_failed', hold: 'mint_expired', needsPasskey: true }); expect(sol.tokens.get(MY_ATA)!.amount).toBe(100_000000n);
    sol.drop = false; await tick(); expect((await getP(b.id)).bridge.stage).toBe('mint_failed'); // nothing happens without the owner
    const o = await api('POST', `/api/v1/bridge/proposals/${b.id}/retry-mint/options`, {});
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const r = await api('POST', `/api/v1/bridge/proposals/${b.id}/retry-mint`, { assertion: assert(o.json.options) });
    expect(r.status, JSON.stringify(r.json)).toBe(200); expect(r.json.bridge.stage).toBe('minting');
    sol.mine(); await tick(); p = await getP(b.id);
    expect(p.bridge).toMatchObject({ stage: 'done', received: '7000000' }); expect(store.state.bridges![b.id]!.mint!.signatures).toBe(2);
  });
  it('already received (someone else submitted the public message): recorded as done, nothing signed', async () => {
    const b = await burned('3'); const message = encodeCctpMessage(b.message); attest(b.txid, message);
    sol.accts.set(cctpSolPda.usedNonce(b.message.nonce), { owner: CCTP_SOL_MESSAGE_TRANSMITTER, lamports: CCTP_SOL_NONCE_RENT, data: Buffer.alloc(9, 1) }); sol.nonceTx.set(cctpSolPda.usedNonce(b.message.nonce), 'ThirdPartySignature');
    await tick(); const p = await getP(b.id);
    expect(p.bridge).toMatchObject({ stage: 'done', mintedBy: 'other', mintTxid: 'ThirdPartySignature', received: '3000000' });
    expect(store.state.bridges![b.id]!.mint).toBeUndefined(); expect(sol.pending).toEqual([]);
  });
  it('waits, with the reason, when SOL is missing or the token account has gone; refuses to prepare without SOL', async () => {
    const b = await burned('4'); attest(b.txid, encodeCctpMessage(b.message));
    sol.lamports.set(ME_SOL, 700_000n);
    await tick(); let p = await getP(b.id);
    expect(p.bridge).toMatchObject({ stage: 'ready', hold: 'destination_gas' }); expect(sol.pending).toEqual([]);
    sol.lamports.set(ME_SOL, 50_000_000n); sol.tokens.delete(MY_ATA);
    await tick(); p = await getP(b.id);
    expect(p.bridge).toMatchObject({ stage: 'ready', hold: 'token_account_missing' });
    sol.tokens.set(MY_ATA, { owner: ME_SOL, amount: 0n, state: 'initialized' });
    await tick(); sol.mine(); await tick();
    expect((await getP(b.id)).bridge).toMatchObject({ stage: 'done', received: '4000000' });
    sol.lamports.set(ME_SOL, 1_000_000n);
    const no = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'solana', amount: '10', speed: 'standard' }, crypto.randomUUID());
    expect(no.status).toBe(422); expect(no.json).toMatchObject({ error: 'destination_gas', message: expect.stringMatching(/SOL on Solana/) });
  });
});
