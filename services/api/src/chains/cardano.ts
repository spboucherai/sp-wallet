// Cardano adapter: native ADA only. Two independent keyless sources over HTTPS:
//   rpc[0]  Koios (community-operated query layer over cardano-db-sync + a node; https://api.koios.rest, public tier)
//   rpc[1]  EMURGO's Yoroi backend (https://api.yoroiwallet.com/api)
// Everything that feeds the signature — the UTxO set of the wallet (ids, values, whether they carry native assets) and the
// chain tip — is read from both and must be identical; otherwise the transfer is refused. The protocol parameters that
// decide amounts (fee coefficients, minimum ADA per output byte, maximum transaction size) are read from Koios and must
// equal the values this file was reviewed for (REVIEWED_PARAMS): a governance action that changes them stops sends until
// the pin is reviewed (a too-low fee is only ever rejected by the chain, never lost; the ceiling bounds a too-high one).
//
// Rules (stated, not worked around):
// - Native assets are out of scope: a UTxO that carries tokens, a datum or a reference script is NEVER spent. The ADA
//   locked with such UTxOs stays where it is and is reported in a warning.
// - Every output must carry the protocol minimum (about 0.97 ADA for a payment to a base address): smaller payments are
//   refused, and so is a payment that would leave change below that minimum (send less, or exactly everything).
// - The fee is the exact linear minimum for the bytes that will be signed (+44 lovelace: the size convention of the official
//   serialization library). There is no fee market on Cardano.
// - Koios' public tier is limited per day: the tip is cached for 20 s and the deposit scan runs at most every 5 minutes.
// - A dry run: Koios exposes Ogmios `evaluateTransaction`, which decodes the transaction with the ledger's own decoder and
//   resolves its inputs; a rejection there refuses the transfer. When that endpoint is unreachable the transfer proceeds
//   (the check is supplementary: the UTxO set was already agreed by two sources).
// - Confirmation: `minConf` blocks (15 ≈ 5 minutes). Cardano has no instant finality; a transaction that disappears after
//   having been seen in a block is reported as reorged and tracked until it reappears or its validity window closes.
import {
  buildCardanoTx, cardanoAddressBytes, cardanoDecodeTx, cardanoDestination, cardanoFormatInputs, cardanoMinAda, cardanoMinFee, cardanoSignedTx, cardanoTxid, cardanoTxSizeOf,
  CARDANO_MAX_INPUTS, CARDANO_SLOT_ZERO_UNIX, type CardanoInput, type Intent, type NetworkDef,
} from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

/** Protocol parameters this adapter was reviewed for (mainnet, epoch 667, 2026-11-11). */
export const REVIEWED_PARAMS = { minFeeA: 44n, minFeeB: 155381n, coinsPerUtxoByte: 4310n, maxTxSize: 16384 } as const;
/** an early Shelley-era transaction and the block that holds it (height 5 000 000): both sources must report this pair */
const PIN = { tx: '52430b19d39d66530ae4764a60488e199ff1e9a1b5d9121d867b87f70fd4e836', block: '97e160fc41b9cd751270100dd639202c1b8ae81932f20340bd6dd9f44e429a1d' };
/** approval window; the transaction itself stays valid TTL_SLOTS seconds (1 slot = 1 s) from preparation */
const TTL_SEC = 120, TTL_SLOTS = 900;
/** blocks arrive every 20 s on average; a tip older than this means the source is stalled */
const MAX_TIP_AGE_SEC = 600;
const FEE_CAP = 500_000n;
const RETRY_MS = Number(process.env.SPW_CARDANO_RETRY_MS ?? 2500);
const TIP_CACHE_MS = 20_000, DEPOSIT_EVERY_MS = 5 * 60_000, FIRST_SCAN_BLOCKS = 4320, KOIOS_PAGE = 1000, DEPOSIT_BATCH = 50;

interface Tip { hash: string; slot: number; height: number; time: number | null }
/** `assets`: carries native tokens (both sources must agree). `extra`: carries a datum or a reference script (either source). */
interface Utxo extends CardanoInput { assets: boolean; extra: boolean }
const fail = (message: string, extra: object = {}) => Object.assign(new Error(message), extra);
const HEX64 = /^[0-9a-f]{64}$/, UINT = /^(0|[1-9]\d{0,19})$/;
const big = (v: unknown, what: string): bigint => { if (typeof v !== 'string' || !UINT.test(v)) throw new Error(`cardano: bad ${what}`); return BigInt(v); };
const int = (v: unknown, what: string): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`cardano: bad ${what}`); return v; };
const fmt = (v: bigint) => { const f = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${v / 1_000_000n}${f ? '.' + f : ''}`; };
const idOf = (u: { txid: string; index: number }) => `${u.txid}#${u.index}`;

async function call<T>(url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const r = await http(url, { method: body === undefined && !init.body ? 'GET' : 'POST', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...init });
  const text = await r.text();
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw fail(`cardano http ${r.status}`, { status: r.status, text: text.slice(0, 400) }); }
  if (!r.ok) throw fail(`cardano http ${r.status}`, { status: r.status, text: text.slice(0, 2000) });
  return j as T;
}

export function cardanoAdapter(n: NetworkDef): Adapter {
  if (n.rpc.length !== 2) throw new Error(`${n.name} needs its two sources (Koios, Yoroi backend)`);
  const [K, Y] = n.rpc as [string, string];
  let identity = false, tipCache: { at: number; tip: Tip } | null = null, lastScan = 0, params: { epoch: number } | null = null;

  const koiosTip = async (fresh = false): Promise<Tip & { epoch: number }> => {
    if (!fresh && tipCache && Date.now() - tipCache.at < TIP_CACHE_MS) return tipCache.tip as Tip & { epoch: number };
    const [t] = await call<{ hash?: string; abs_slot?: number; block_no?: number; block_time?: number; epoch_no?: number }[]>(K + '/tip');
    if (!t || typeof t.hash !== 'string' || !HEX64.test(t.hash)) throw new Error('cardano: bad tip');
    const tip = { hash: t.hash, slot: int(t.abs_slot, 'slot'), height: int(t.block_no, 'height'), time: int(t.block_time, 'block time'), epoch: int(t.epoch_no, 'epoch') };
    // the slot ↔ time relation the signer relies on for the validity window
    if (tip.slot + CARDANO_SLOT_ZERO_UNIX !== tip.time) throw new Error('cardano: slot/time relation changed');
    if (Date.now() / 1000 - tip.time > MAX_TIP_AGE_SEC) throw new Error('cardano: source is behind');
    tipCache = { at: Date.now(), tip };
    return tip;
  };
  const yoroiTip = async (): Promise<Tip> => {
    const t = await call<{ hash?: string; globalSlot?: number; height?: number }>(Y + '/v2/bestblock');
    if (typeof t.hash !== 'string' || !HEX64.test(t.hash)) throw new Error('cardano: bad tip');
    const tip = { hash: t.hash, slot: int(t.globalSlot, 'slot'), height: int(t.height, 'height'), time: null };
    if (Date.now() / 1000 - (tip.slot + CARDANO_SLOT_ZERO_UNIX) > MAX_TIP_AGE_SEC) throw new Error('cardano: source is behind');
    return tip;
  };
  const koiosIdentity = async (): Promise<void> => {
    const [g] = await call<{ networkmagic?: string; networkid?: string }[]>(K + '/genesis');
    if (g?.networkmagic !== n.chainRef || g.networkid !== 'Mainnet') throw new Error('identity: network magic mismatch');
    const [t] = await call<{ tx_hash?: string; block_hash?: string }[]>(K + '/tx_info', { _tx_hashes: [PIN.tx], _inputs: false, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
    if (t?.tx_hash !== PIN.tx || t.block_hash !== PIN.block) throw new Error('identity: pinned block mismatch');
  };
  const yoroiIdentity = async (): Promise<void> => {
    const r = await call<Record<string, { hash?: string; block_hash?: string }>>(Y + '/v2/txs/get', { txHashes: [PIN.tx] });
    if (r[PIN.tx]?.hash !== PIN.tx || r[PIN.tx]?.block_hash !== PIN.block) throw new Error('identity: pinned block mismatch');
  };
  const degraded = (what: string) => new UserError('rpc_degraded', `${n.name} data source unavailable (${what}); transfer refused`, 503);
  const both = async <A, B>(what: string, a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> => {
    const [ra, rb] = await Promise.allSettled([a(), b()]);
    for (const r of [ra, rb]) if (r.status === 'rejected') { if (r.reason instanceof UserError) throw r.reason; throw degraded(what); }
    return [(ra as PromiseFulfilledResult<A>).value, (rb as PromiseFulfilledResult<B>).value];
  };

  const koiosUtxos = async (addr: string): Promise<Utxo[]> => {
    const rows = await call<{ tx_hash?: string; tx_index?: number; value?: string; asset_list?: unknown[] | null; datum_hash?: string | null; inline_datum?: unknown; reference_script?: unknown; is_spent?: boolean; address?: string }[]>(K + '/address_utxos', { _addresses: [addr], _extended: true });
    if (!Array.isArray(rows) || rows.length >= KOIOS_PAGE) throw new Error('cardano: UTxO listing unusable');
    return rows.filter((u) => u.is_spent !== true).map((u) => {
      if (u.address !== addr || typeof u.tx_hash !== 'string' || !HEX64.test(u.tx_hash) || !Array.isArray(u.asset_list)) throw new Error('cardano: bad UTxO');
      return { txid: u.tx_hash, index: int(u.tx_index, 'UTxO index'), value: big(u.value, 'UTxO value'), assets: u.asset_list.length > 0, extra: u.datum_hash != null || u.inline_datum != null || u.reference_script != null };
    });
  };
  const yoroiUtxos = async (addr: string): Promise<Utxo[]> => {
    const rows = await call<{ tx_hash?: string; tx_index?: number; amount?: string; assets?: unknown[]; receiver?: string; script_ref?: unknown }[]>(Y + '/txs/utxoForAddresses', { addresses: [addr] });
    if (!Array.isArray(rows)) throw new Error('cardano: UTxO listing unusable');
    return rows.map((u) => {
      if (u.receiver !== addr || typeof u.tx_hash !== 'string' || !HEX64.test(u.tx_hash) || !Array.isArray(u.assets)) throw new Error('cardano: bad UTxO');
      return { txid: u.tx_hash, index: int(u.tx_index, 'UTxO index'), value: big(u.amount, 'UTxO value'), assets: u.assets.length > 0, extra: u.script_ref != null };
    });
  };
  /** The wallet's UTxO set, identical on both sources: same outputs, same values, same verdict on native assets. */
  const agreedUtxos = async (addr: string): Promise<Utxo[]> => {
    const key = (us: Utxo[]) => us.map((u) => `${idOf(u)}=${u.value}${u.assets ? '+assets' : ''}`).sort().join(',');
    for (let attempt = 0; ; attempt++) {
      const [a, b] = await both('UTxO set', () => koiosUtxos(addr), () => yoroiUtxos(addr));
      if (key(a) === key(b)) {
        const other = new Map(b.map((u) => [idOf(u), u]));
        return a.map((u) => ({ ...u, extra: u.extra || other.get(idOf(u))!.extra }));
      }
      // one source may be a block ahead of the other: look again once
      if (attempt >= 1) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (UTxO set); transfer refused`, 503);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  };
  const checkParams = async (epoch: number): Promise<void> => {
    if (params?.epoch === epoch) return;
    const [p] = await call<{ epoch_no?: number; min_fee_a?: number; min_fee_b?: number; coins_per_utxo_size?: string; max_tx_size?: number }[]>(`${K}/epoch_params?_epoch_no=${epoch}`);
    if (!p || p.epoch_no !== epoch) throw new Error('cardano: bad protocol parameters');
    if (BigInt(int(p.min_fee_a, 'minFeeA')) !== REVIEWED_PARAMS.minFeeA || BigInt(int(p.min_fee_b, 'minFeeB')) !== REVIEWED_PARAMS.minFeeB || big(p.coins_per_utxo_size, 'coinsPerUTxOByte') !== REVIEWED_PARAMS.coinsPerUtxoByte || int(p.max_tx_size, 'maxTxSize') !== REVIEWED_PARAMS.maxTxSize)
      throw new UserError('protocol_changed', `${n.name} protocol parameters changed (fees or minimum ADA); sending is paused until this wallet is updated`, 503);
    params = { epoch };
  };
  /** confirmations of a transaction per source: a number, or null when the source does not know it */
  const koiosConf = async (txid: string): Promise<number | null> => {
    const [s] = await call<{ tx_hash?: string; num_confirmations?: number | null }[]>(K + '/tx_status', { _tx_hashes: [txid] });
    if (!s || s.tx_hash !== txid) throw new Error('cardano: bad status');
    return s.num_confirmations == null ? null : int(s.num_confirmations, 'confirmations');
  };
  const yoroiConf = async (txid: string): Promise<number | null> => {
    const s = await call<{ depth?: Record<string, number> }>(Y + '/tx/status', { txHashes: [txid] });
    if (!s || typeof s.depth !== 'object' || s.depth === null) throw new Error('cardano: bad status');
    const d = s.depth[txid];
    return d === undefined ? null : int(d, 'confirmations');
  };

  const draft = (d: { from: string; to: string; amount: bigint }, inputs: CardanoInput[], fee: bigint, change: bigint, ttl: number, createdAt: number): Intent => ({
    v: 1, proposalId: '00000000-0000-4000-8000-000000000000', keyId: 'simulation', createdAt, expiresAt: createdAt + TTL_SEC, policyVersion: 0, network: n.id, chainRef: n.chainRef,
    asset: 'native', symbol: n.native.symbol, decimals: n.native.decimals, amount: d.amount.toString(), from: d.from, to: d.to, maxFee: fee.toString(),
    x: { inputs: cardanoFormatInputs(inputs), fee: fee.toString(), change: change.toString(), ttl: String(ttl) } });

  return {
    async health(): Promise<Health> {
      const probe = async (url: string, f: () => Promise<Tip>, id: () => Promise<void>) => {
        const t = Date.now();
        try { const tip = await f(); if (!identity) await id(); return { url: hostOf(url), ok: true, ms: Date.now() - t, tip: tip as Tip | null }; }
        catch { return { url: hostOf(url), ok: false, ms: null, tip: null as Tip | null }; }
      };
      const endpoints = await Promise.all([probe(K, () => koiosTip(), koiosIdentity), probe(Y, yoroiTip, yoroiIdentity)]);
      const ok = endpoints.every((e) => e.ok);
      // both passed their identity checks and stand within a few blocks of each other
      if (ok && !identity && Math.abs(endpoints[0]!.tip!.height - endpoints[1]!.tip!.height) <= 5) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.tip?.height ?? 0)) || null,
        endpoints: endpoints.map(({ tip: _t, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      cardanoAddressBytes(addr);
      // total ADA at the address (display); Yoroi first to spare Koios' daily allowance
      try {
        const s = await call<{ sum?: string }>(Y + '/txs/utxoSumForAddresses', { addresses: [addr] });
        return { native: big(s.sum, 'balance') };
      } catch {
        const [a] = await call<{ address?: string; balance?: string }[]>(K + '/address_info', { _addresses: [addr] });
        if (a === undefined) return { native: 0n }; // an address Koios has never seen
        if (a.address !== addr) throw new Error('cardano: bad balance');
        return { native: big(a.balance, 'balance') };
      }
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', `only ${n.native.symbol} can be sent on ${n.name}`);
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
      if (d.memo !== undefined) throw new UserError('bad_memo', `${n.name} transfers do not carry a memo`);
      try { if (cardanoAddressBytes(d.from).type !== 0) throw new Error('the source must be a base address'); cardanoDestination(d.to); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (!identity) { await both('identity', koiosIdentity, yoroiIdentity); }

      const [kt, yt] = await both('chain tip', () => koiosTip(true), yoroiTip);
      if (Math.abs(kt.height - yt.height) > 3) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same block; transfer refused`, 503);
      identity = true;
      try { await checkParams(kt.epoch); } catch (e) { if (e instanceof UserError) throw e; throw degraded('protocol parameters'); }
      const P = REVIEWED_PARAMS;

      const minOut = cardanoMinAda(d.to, d.amount, P.coinsPerUtxoByte);
      if (d.amount < minOut) throw new UserError('bad_amount', `the smallest payment ${n.name} accepts for this address is ${fmt(minOut)} ADA (every output must carry a minimum of ADA)`);

      const utxos = await agreedUtxos(d.from);
      const plain = (u: Utxo) => !u.assets && !u.extra;
      const spendable = utxos.filter(plain).sort((a, b) => (a.value === b.value ? (idOf(a) < idOf(b) ? -1 : 1) : a.value > b.value ? -1 : 1));
      const locked = utxos.filter((u) => !plain(u)), lockedAda = locked.reduce((s, u) => s + u.value, 0n), spendableAda = spendable.reduce((s, u) => s + u.value, 0n);
      // warning codes are translated by the web app (`w_<code>`): outputs carrying native tokens or script data are never spent, their ADA stays with them
      const warnings = locked.length ? ['cd_token_outputs'] : [];
      if (spendable.length === 0) throw new UserError('insufficient_funds', utxos.length ? `this wallet's ADA (${fmt(lockedAda)} ADA) is held in outputs that carry native tokens, which this wallet does not spend` : `this wallet has no ${n.native.symbol}`);

      const now = Math.floor(Date.now() / 1000), ttl = now - CARDANO_SLOT_ZERO_UNIX + TTL_SLOTS;
      const minFee = (size: number) => cardanoMinFee(size, P.minFeeA, P.minFeeB);
      /**
       * Fee of the transaction spending `ins`, with or without a change output. The fee depends on the size, which depends on
       * the width of the fee and of the change: iterate to the fixed point (if two values alternate, the larger one is taken —
       * it covers the size it produces).
       */
      const feeFor = (ins: CardanoInput[], total: bigint, withChange: boolean): bigint => {
        let fee: bigint = P.minFeeB;
        for (let r = 0; r < 6; r++) {
          const left = total - d.amount - fee;
          const next = minFee(cardanoTxSizeOf({ inputs: ins, from: d.from, to: d.to, amount: d.amount, change: withChange ? (left > 0n ? left : 1n) : 0n, fee, ttl: BigInt(ttl) }));
          if (next === fee) return fee;
          if (r === 5) return next > fee ? next : fee;
          fee = next;
        }
        return fee;
      };
      const minChange = cardanoMinAda(d.from, 1n, P.coinsPerUtxoByte);
      let chosen: { inputs: CardanoInput[]; fee: bigint; change: bigint } | null = null, dust: { exact: bigint; most: bigint; left: bigint } | null = null;
      for (let k = 1; k <= Math.min(spendable.length, CARDANO_MAX_INPUTS); k++) {
        const ins = spendable.slice(0, k).map(({ txid, index, value }) => ({ txid, index, value })), total = ins.reduce((s, u) => s + u.value, 0n);
        const feeNo = feeFor(ins, total, false);
        if (total < d.amount + feeNo) continue;                                                        // not enough yet: add an input
        if (total === d.amount + feeNo) { chosen = { inputs: ins, fee: feeNo, change: 0n }; break; }   // exactly everything: no change output
        const fee = feeFor(ins, total, true), change = total - d.amount - fee;
        if (change > 0n && change >= cardanoMinAda(d.from, change, P.coinsPerUtxoByte)) { chosen = { inputs: ins, fee, change }; break; }
        // the remainder cannot form a change output (below the minimum an output must carry): try with one more input
        const most = total - fee - minChange;
        dust = { exact: total - feeNo, most: most > 0n ? most : 0n, left: total - d.amount - feeNo };
      }
      if (!chosen) {
        if (dust) throw new UserError('bad_amount', `this payment would leave ${fmt(dust.left)} ADA of change, less than the ${fmt(minChange)} ADA an output must carry: send at most ${fmt(dust.most)} ADA, or exactly ${fmt(dust.exact)} ADA to send everything`);
        if (spendable.length > CARDANO_MAX_INPUTS) throw new UserError('insufficient_funds', `this payment needs more than ${CARDANO_MAX_INPUTS} inputs; send a smaller amount first`);
        throw new UserError('insufficient_funds', `insufficient ${n.native.symbol}: the amount plus the network fee (about 0.17 ADA) exceeds the spendable balance (${fmt(spendableAda)} ADA)`);
      }
      if (chosen.fee > FEE_CAP) throw new UserError('fee_too_high', `the network fee (${fmt(chosen.fee)} ADA) is above this wallet's ceiling`);

      const x = { inputs: cardanoFormatInputs(chosen.inputs), fee: chosen.fee.toString(), change: chosen.change.toString(), ttl: String(ttl) };
      // the exact transaction the signer will rebuild (throws here, before approval, if anything is off)
      const built = buildCardanoTx(draft(d, chosen.inputs, chosen.fee, chosen.change, ttl, now), n);
      if (built.size > P.maxTxSize || chosen.fee < minFee(built.size)) throw new Error('cardano: fee computation inconsistent');

      // dry run: the ledger decoder of a node reads the transaction (with a placeholder signature) and resolves its inputs
      try {
        const unsigned = cardanoSignedTx(built.body, new Uint8Array(32), new Uint8Array(64));
        await call(K + '/ogmios', { jsonrpc: '2.0', method: 'evaluateTransaction', params: { transaction: { cbor: Buffer.from(unsigned).toString('hex') } } });
      } catch (e) {
        const status = (e as { status?: number }).status, text = String((e as { text?: string }).text ?? '');
        if (status === 400 && /"code":\s*(-32602|3\d{3})/.test(text)) {
          if (/unknownOutputReferences|Unknown transaction input/i.test(text)) throw new UserError('pending_tx', 'an output of this wallet has just been spent or is not confirmed yet; retry in a minute', 409);
          throw new UserError('simulation_failed', `the network refused the transaction in a dry run: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        // endpoint unavailable: supplementary check skipped
      }
      return { section: { x }, maxFee: chosen.fee, feeEstimate: chosen.fee, warnings, ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const txid = cardanoTxid(raw), bytes = Buffer.from(raw, 'hex');
      const rs = await Promise.allSettled([
        (async () => {
          const r = await http(K + '/submittx', { method: 'POST', headers: { 'content-type': 'application/cbor' }, body: bytes });
          const text = await r.text();
          if (r.ok && text.includes(txid)) return;
          throw new Error(`koios ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
        })(),
        call<unknown>(Y + '/v2/txs/signed', { signedTx: bytes.toString('base64') }).then(() => undefined, (e) => { throw new Error(`yoroi ${(e as { status?: number }).status ?? ''}: ${String((e as { text?: string }).text ?? (e as Error).message).replace(/\s+/g, ' ').slice(0, 200)}`); }),
      ]);
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // refused by both ("inputs already spent", "already in the mempool"): fine only if this very transaction is on chain
      const seen = await Promise.allSettled([koiosConf(txid), yoroiConf(txid)]);
      if (seen.some((s) => s.status === 'fulfilled' && s.value !== null)) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const rs = await Promise.allSettled([koiosConf(p.txid), yoroiConf(p.txid)]);
      const depths = rs.flatMap((r) => (r.status === 'fulfilled' && r.value !== null ? [r.value] : []));
      if (depths.length) {
        // the deeper view decides nothing: use the shallower one (a source can lag, never lead the chain)
        const conf = Math.min(...depths) + 1;
        return { state: conf >= n.minConf ? 'finalized' : 'confirming', confirmations: conf, blockRef: 'seen' };
      }
      const pending: Tracked = { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0, rebroadcast: true };
      if (!rs.every((r) => r.status === 'fulfilled')) return pending;
      // unknown to both: dead once the validity window is closed on both (plus a margin for a late block)
      const ttl = Number(p.intent?.x?.ttl);
      if (!Number.isSafeInteger(ttl) || ttl < 1) return pending;
      const tips = await Promise.allSettled([koiosTip(true), yoroiTip()]);
      if (!tips.every((t) => t.status === 'fulfilled')) return pending;
      const slot = Math.min(...tips.map((t) => (t as PromiseFulfilledResult<Tip>).value.slot));
      if (slot <= ttl + 120) return pending;
      const again = await Promise.allSettled([koiosConf(p.txid), yoroiConf(p.txid)]);
      if (!again.every((r) => r.status === 'fulfilled' && r.value === null)) return { ...pending, rebroadcast: false };
      return { state: 'failed', confirmations: 0, error: 'expired before inclusion (validity window closed); no funds moved' };
    },

    async deposits(addr, cursor) {
      cardanoAddressBytes(addr);
      const items: Deposit[] = [];
      if (cursor !== null && Date.now() - lastScan < DEPOSIT_EVERY_MS) return { items, cursor, finalizedHeight: cursor };
      const tip = await koiosTip(), final = tip.height - n.minConf + 1;
      if (cursor !== null && cursor >= final) return { items, cursor, finalizedHeight: final };
      const after = cursor ?? Math.max(0, final - FIRST_SCAN_BLOCKS);
      const rows = await call<{ tx_hash?: string; block_height?: number; block_time?: number }[]>(K + '/address_txs', { _addresses: [addr], _after_block_height: after });
      if (!Array.isArray(rows) || rows.length >= KOIOS_PAGE) throw new Error('cardano: transaction listing unusable');
      const all = rows.filter((r) => typeof r.tx_hash === 'string' && HEX64.test(r.tx_hash) && int(r.block_height, 'height') > after && r.block_height! <= final).sort((a, b) => a.block_height! - b.block_height!);
      const fresh = all.slice(0, DEPOSIT_BATCH);
      if (fresh.length) {
        const ids = fresh.map((r) => r.tx_hash!);
        type Out = { payment_addr?: { bech32?: string }; value?: string; tx_index?: number };
        const infos = await call<{ tx_hash?: string; block_height?: number; tx_timestamp?: number; inputs?: Out[]; outputs?: Out[] }[]>(K + '/tx_info', { _tx_hashes: ids, _inputs: true, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
        // each incoming output is confirmed by the second source before it is reported
        const second = await call<Record<string, { tx_state?: string; outputs?: { address?: string; amount?: string }[] }>>(Y + '/v2/txs/get', { txHashes: ids });
        for (const t of infos) {
          if (typeof t.tx_hash !== 'string' || !ids.includes(t.tx_hash) || !Array.isArray(t.inputs) || !Array.isArray(t.outputs)) throw new Error('cardano: bad transaction');
          if (t.inputs.some((u) => u.payment_addr?.bech32 === addr)) continue; // spent by this wallet: its own change, not a deposit
          const y = second[t.tx_hash];
          for (const o of t.outputs) {
            if (o.payment_addr?.bech32 !== addr) continue;
            const idx = int(o.tx_index, 'output index'), amount = big(o.value, 'output value');
            const yo = y?.outputs?.[idx];
            if (!y || y.tx_state !== 'Successful' || yo?.address !== addr || yo.amount !== amount.toString()) throw new Error('cardano: sources disagree on a deposit');
            if (amount > 0n) items.push({ txid: t.tx_hash, idx, asset: 'native', amount, from: t.inputs[0]?.payment_addr?.bech32 ?? '', block: int(t.block_height, 'height'), time: typeof t.tx_timestamp === 'number' ? t.tx_timestamp : null });
          }
        }
      }
      lastScan = Date.now();
      // when a pass was truncated, resume from the last block fully read
      const last = fresh.length ? fresh[fresh.length - 1]!.block_height! : final;
      const next = all.length > fresh.length ? (last - 1 > after ? last - 1 : last) : final;
      return { items: items.filter((i) => i.block <= next), cursor: next, finalizedHeight: final };
    },
  };
}

/** Decode a signed payload for display and tests (strict). */
export const cardanoDescribeRaw = (raw: string) => cardanoDecodeTx(Buffer.from(raw, 'hex'));
