/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/cardano-adapter.test.ts
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

// Cardano adapter against two scripted sources (Koios, Yoroi backend; no network): agreement rules, coin selection (plain ADA
// only), fee and minimum-ADA rules checked with the official serialization library, refusals, tracking, broadcast, deposits.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { buildCardanoTx, cardanoParseInputs, cardanoSignedTx, CARDANO_SLOT_ZERO_UNIX, NETWORKS, type Intent } from '@spw/core';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.cardano;
const [K, Y] = n.rpc as [string, string];
const FROM = 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv';
const TO = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
const OTHER = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';
const PIN = { tx: '52430b19d39d66530ae4764a60488e199ff1e9a1b5d9121d867b87f70fd4e836', block: '97e160fc41b9cd751270100dd639202c1b8ae81932f20340bd6dd9f44e429a1d' };
const TIP = 14_187_800, HASH = 'ec'.repeat(32);
const tx = (k: number) => k.toString(16).padStart(2, '0').repeat(32);
interface U { txid: string; index: number; value: string; assets?: boolean; datum?: boolean }
type Reply = { status?: number; body: unknown; text?: string } | 'down';
type Handler = (body: any, url: URL, raw: unknown) => Reply;

function world(over: Record<string, Handler | 'down'> = {}, init: { utxos?: U[]; yoroiUtxos?: U[] } = {}) {
  const state = { now: Math.floor(Date.now() / 1000), utxos: init.utxos ?? [{ txid: tx(1), index: 0, value: '50000000' }], yoroiUtxos: init.yoroiUtxos, conf: {} as Record<string, number | null>, submitted: [] as string[], calls: [] as string[] };
  const slot = () => state.now - CARDANO_SLOT_ZERO_UNIX - 15;
  const routes: Record<string, Handler | 'down'> = {
    [K + '/tip']: () => ({ body: [{ hash: HASH, epoch_no: 667, abs_slot: slot(), block_no: TIP, block_time: slot() + CARDANO_SLOT_ZERO_UNIX }] }),
    [K + '/genesis']: () => ({ body: [{ networkmagic: '764824073', networkid: 'Mainnet' }] }),
    [K + '/epoch_params']: () => ({ body: [{ epoch_no: 667, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: '4310', max_tx_size: 16384 }] }),
    [K + '/tx_info']: (b) => ({ body: (b._tx_hashes as string[]).filter((h) => h === PIN.tx).map((h) => ({ tx_hash: h, block_hash: PIN.block })) }),
    [K + '/address_utxos']: (b) => ({ body: state.utxos.map((u) => ({ tx_hash: u.txid, tx_index: u.index, address: b._addresses[0], value: u.value, asset_list: u.assets ? [{ policy_id: 'ab'.repeat(28), asset_name: '41', quantity: '5' }] : [], datum_hash: u.datum ? 'cd'.repeat(32) : null, inline_datum: null, reference_script: null, is_spent: false })) }),
    [K + '/address_info']: (b) => ({ body: [{ address: b._addresses[0], balance: state.utxos.reduce((s, u) => s + BigInt(u.value), 0n).toString() }] }),
    [K + '/tx_status']: (b) => ({ body: (b._tx_hashes as string[]).map((h) => ({ tx_hash: h, num_confirmations: state.conf[h] ?? null })) }),
    [K + '/ogmios']: () => ({ body: { jsonrpc: '2.0', method: 'evaluateTransaction', result: [] } }),
    [K + '/submittx']: (_b, _u, raw) => { const hex = Buffer.from(raw as Uint8Array).toString('hex'); state.submitted.push(hex); return { status: 202, body: CSL.FixedTransaction.from_hex(hex).transaction_hash().to_hex() }; },
    [K + '/address_txs']: () => ({ body: [] }),
    [Y + '/v2/bestblock']: () => ({ body: { epoch: 667, slot: 1, globalSlot: slot(), hash: HASH, height: TIP } }),
    [Y + '/v2/txs/get']: (b) => ({ body: Object.fromEntries((b.txHashes as string[]).filter((h) => h === PIN.tx).map((h) => [h, { hash: h, block_hash: PIN.block, tx_state: 'Successful' }])) }),
    [Y + '/txs/utxoForAddresses']: (b) => ({ body: (state.yoroiUtxos ?? state.utxos).map((u) => ({ utxo_id: `${u.txid}:${u.index}`, tx_hash: u.txid, tx_index: u.index, receiver: b.addresses[0], amount: u.value, assets: u.assets ? [{ assetId: 'x', amount: '5' }] : [], block_num: 1, script_ref: null })) }),
    [Y + '/txs/utxoSumForAddresses']: () => ({ body: { sum: state.utxos.reduce((s, u) => s + BigInt(u.value), 0n).toString(), tokensBalance: [] } }),
    [Y + '/tx/status']: (b) => ({ body: { depth: Object.fromEntries((b.txHashes as string[]).filter((h) => state.conf[h] != null).map((h) => [h, state.conf[h]])) } }),
    [Y + '/v2/txs/signed']: (b) => { state.submitted.push(Buffer.from(b.signedTx, 'base64').toString('hex')); return { body: {} }; },
    ...over,
  };
  vi.stubGlobal('fetch', async (url: string, req: RequestInit = {}) => {
    const u = new URL(url), key = u.origin + u.pathname;
    state.calls.push(key);
    const h = routes[key];
    if (!h || h === 'down') throw new TypeError('fetch failed');
    const isJson = typeof req.body === 'string';
    const r = h(isJson ? JSON.parse(req.body as string) : undefined, u, req.body);
    if (r === 'down') throw new TypeError('fetch failed');
    return new Response(r.text ?? JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return state;
}

let make: () => Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'x'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off', SPW_CARDANO_RETRY_MS: '0' });
  const { cardanoAdapter } = await import('../src/chains/cardano.ts');
  make = () => cardanoAdapter(n);
});
afterEach(() => vi.unstubAllGlobals());
const req = { asset: 'native', from: FROM, to: TO, amount: 2_500_000n };
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message: string }) => e.code ?? `error:${e.message}`);
const msg = async (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);
const lin = CSL.LinearFee.new(CSL.BigNum.from_str('44'), CSL.BigNum.from_str('155381'));
/** the intent the API would form from a prepared section; built by the plugin exactly as the signer does */
function built(p: { section: Record<string, unknown>; maxFee: bigint }, d = req) {
  const now = Math.floor(Date.now() / 1000);
  const i: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 4, network: 'cardano', chainRef: n.chainRef,
    asset: 'native', symbol: 'ADA', decimals: 6, amount: d.amount.toString(), from: d.from, to: d.to, maxFee: p.maxFee.toString(), x: p.section.x as Record<string, string> };
  const b = buildCardanoTx(i, n);
  return { i, b, sdk: CSL.Transaction.from_hex(Buffer.from(cardanoSignedTx(b.body, new Uint8Array(32).fill(1), new Uint8Array(64).fill(2))).toString('hex')) };
}

describe('cardano adapter: health and identity', () => {
  it('is ok only when both sources are up, on mainnet, and know the pinned block', async () => {
    world();
    expect(await make().health()).toMatchObject({ ok: true, readable: true, identityVerified: true, height: TIP });
    world({ [Y + '/v2/bestblock']: 'down' });
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    world({ [K + '/genesis']: () => ({ body: [{ networkmagic: '1', networkid: 'Testnet' }] }) });
    expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    world({ [Y + '/v2/txs/get']: () => ({ body: { [PIN.tx]: { hash: PIN.tx, block_hash: 'aa'.repeat(32) } } }) });
    expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    world({ [K + '/tip']: () => ({ body: [{ hash: HASH, epoch_no: 667, abs_slot: 100, block_no: TIP, block_time: 100 + CARDANO_SLOT_ZERO_UNIX + 1 }] }) }); // slot length changed
    expect(await make().health()).toMatchObject({ ok: false });
    const s = world(); s.now -= 3600; // both sources stalled an hour ago
    expect(await make().health()).toMatchObject({ ok: false, readable: false });
  });
  it('reads balances from either source', async () => {
    world({}, { utxos: [{ txid: tx(1), index: 0, value: '50000000' }, { txid: tx(2), index: 1, value: '1500000', assets: true }] });
    expect(await make().balances(FROM)).toEqual({ native: 51_500_000n });
    world({ [Y + '/txs/utxoSumForAddresses']: 'down' });
    expect(await make().balances(FROM)).toEqual({ native: 50_000_000n });
    world({ [Y + '/txs/utxoSumForAddresses']: 'down', [K + '/address_info']: () => ({ body: [] }) });
    expect(await make().balances(FROM)).toEqual({ native: 0n });
    await expect(make().balances('addr1xyz')).rejects.toThrow(/address/);
  });
});

describe('cardano adapter: prepare', () => {
  it('selects plain ADA outputs agreed by both sources and pays the exact minimum fee for the bytes signed', async () => {
    world();
    const p = await make().prepare(req);
    const { b, sdk } = built(p);
    expect(p.section.x).toMatchObject({ inputs: `${tx(1)}:0:50000000` });
    expect(p.ttlSec).toBe(120);
    expect(p.maxFee).toBe(p.feeEstimate);
    expect(p.feeEstimate.toString()).toBe(CSL.min_fee(sdk, lin).to_str());                         // the official library's minimum for these bytes
    expect(p.feeEstimate).toBe(44n * BigInt(b.size) + 155381n);
    expect(b.amount + b.fee + b.change).toBe(50_000_000n);
    expect(b.change).toBe(50_000_000n - 2_500_000n - p.feeEstimate);
    const ttl = Number((p.section.x as Record<string, string>).ttl);
    expect(Math.abs(ttl + CARDANO_SLOT_ZERO_UNIX - (Math.floor(Date.now() / 1000) + 900))).toBeLessThanOrEqual(2);
    expect(p.warnings).toEqual([]);
  });

  it('never spends an output that carries native tokens or script data, and says what stays locked', async () => {
    world({}, { utxos: [{ txid: tx(1), index: 0, value: '90000000', assets: true }, { txid: tx(2), index: 0, value: '70000000', datum: true }, { txid: tx(3), index: 2, value: '4000000' }] });
    const p = await make().prepare(req);
    expect(cardanoParseInputs((p.section.x as Record<string, string>).inputs)).toEqual([{ txid: tx(3), index: 2, value: 4_000_000n }]);
    expect(p.warnings).toEqual(['cd_token_outputs']);
    world({}, { utxos: [{ txid: tx(1), index: 0, value: '90000000', assets: true }] });
    expect(await msg(make().prepare(req))).toMatch(/held in outputs that carry native tokens/);
    expect(await code(make().prepare(req))).toBe('insufficient_funds');
  });

  it('adds inputs largest first, up to the amount, and keeps x.inputs sorted', async () => {
    world({}, { utxos: [{ txid: tx(9), index: 0, value: '3000000' }, { txid: tx(4), index: 1, value: '5000000' }, { txid: tx(4), index: 0, value: '2000000' }, { txid: tx(7), index: 0, value: '1000000' }] });
    const p = await make().prepare({ ...req, amount: 8_500_000n });
    const ins = cardanoParseInputs((p.section.x as Record<string, string>).inputs);
    expect(ins.map((u) => `${u.txid.slice(0, 2)}:${u.index}`)).toEqual(['04:0', '04:1', '09:0']); // 5 + 3 + 2 ADA, sorted by (txid, index)
    const { b, sdk } = built(p, { ...req, amount: 8_500_000n });
    expect(p.feeEstimate.toString()).toBe(CSL.min_fee(sdk, lin).to_str());
    expect(b.change).toBeGreaterThanOrEqual(969_750n);
  });

  it('enforces the minimum ADA of every output: payment, change, and the exact "send everything" case', async () => {
    world();
    expect(await msg(make().prepare({ ...req, amount: 900_000n }))).toMatch(/smallest payment Cardano accepts for this address is 0\.96975 ADA/);
    expect(await code(make().prepare({ ...req, amount: 969_749n }))).toBe('bad_amount');
    expect(await code(make().prepare({ ...req, amount: 969_750n }))).toBe('ok');
    expect(await code(make().prepare({ ...req, to: OTHER, amount: 849_070n }))).toBe('ok');              // enterprise address: shorter, smaller minimum
    // change would be 0.5 ADA: refused with the two amounts that do work
    const m = await msg(make().prepare({ ...req, amount: 49_330_000n }));
    expect(m).toMatch(/would leave 0\.\d+ ADA of change, less than the 0\.96975 ADA an output must carry: send at most (\d+\.\d+) ADA, or exactly (\d+\.\d+) ADA to send everything/);
    const [, most, exact] = /send at most (\d+\.\d+) ADA, or exactly (\d+\.\d+) ADA/.exec(m)!;
    const units = (s: string) => BigInt(s.split('.')[0]!) * 1_000_000n + BigInt((s.split('.')[1] ?? '').padEnd(6, '0'));
    const all = await make().prepare({ ...req, amount: units(exact!) });                                     // everything: one output, no change
    expect((all.section.x as Record<string, string>).change).toBe('0');
    expect(units(exact!) + all.feeEstimate).toBe(50_000_000n);
    expect(built(all, { ...req, amount: units(exact!) }).sdk.body().outputs().len()).toBe(1);
    const mostOk = await make().prepare({ ...req, amount: units(most!) });
    expect(BigInt((mostOk.section.x as Record<string, string>).change!)).toBeGreaterThanOrEqual(969_750n);
    expect(await code(make().prepare({ ...req, amount: units(most!) + 1_000n }))).toBe('bad_amount');
    expect(await code(make().prepare({ ...req, amount: 50_000_000n }))).toBe('insufficient_funds');
    world({}, { utxos: [] });
    expect(await msg(make().prepare(req))).toMatch(/has no ADA/);
  });

  it('refuses when the sources are down or disagree on anything that feeds the signature', async () => {
    world({ [Y + '/txs/utxoForAddresses']: 'down' });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
    world({ [K + '/address_utxos']: 'down' });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
    world({ [K + '/tip']: 'down' });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
    world({}, { yoroiUtxos: [{ txid: tx(1), index: 0, value: '50000001' }] });                               // another value
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world({}, { yoroiUtxos: [{ txid: tx(1), index: 0, value: '50000000' }, { txid: tx(2), index: 0, value: '9000000' }] }); // an output only one source sees
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world({}, { yoroiUtxos: [{ txid: tx(1), index: 0, value: '50000000', assets: true }] });                  // tokens seen by one source only
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world({ [Y + '/v2/bestblock']: () => ({ body: { globalSlot: Math.floor(Date.now() / 1000) - CARDANO_SLOT_ZERO_UNIX - 20, hash: 'ab'.repeat(32), height: TIP - 10 } }) });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');                                       // ten blocks apart
    world({ [K + '/genesis']: () => ({ body: [{ networkmagic: '2', networkid: 'Testnet' }] }) });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');                                           // not mainnet
  });

  it('stops when the protocol parameters are not the reviewed ones', async () => {
    for (const patch of [{ min_fee_a: 45 }, { min_fee_b: 155382 }, { coins_per_utxo_size: '4311' }, { max_tx_size: 32768 }]) {
      world({ [K + '/epoch_params']: () => ({ body: [{ epoch_no: 667, min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: '4310', max_tx_size: 16384, ...patch }] }) });
      expect(await code(make().prepare(req))).toBe('protocol_changed');
    }
    world({ [K + '/epoch_params']: 'down' });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
  });

  it('refuses bad requests', async () => {
    world();
    expect(await code(make().prepare({ ...req, asset: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344' }))).toBe('unsupported_asset');
    expect(await code(make().prepare({ ...req, amount: 0n }))).toBe('bad_amount');
    expect(await code(make().prepare({ ...req, memo: 'hi' }))).toBe('bad_memo');
    expect(await code(make().prepare({ ...req, to: FROM }))).toBe('bad_address');
    expect(await code(make().prepare({ ...req, to: 'addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx' }))).toBe('bad_address');
    expect(await code(make().prepare({ ...req, from: OTHER }))).toBe('bad_address');
  });

  it('uses the node dry run: a ledger rejection refuses the transfer, an unreachable endpoint does not', async () => {
    const seen: string[] = [];
    world({ [K + '/ogmios']: (b) => { seen.push(b.params.transaction.cbor); return { body: { result: [] } }; } });
    const p = await make().prepare(req);
    expect(CSL.FixedTransaction.from_hex(seen[0]!).transaction_hash().to_hex()).toBe(built(p).b.txid);       // the exact body that will be signed
    world({ [K + '/ogmios']: () => ({ status: 400, body: { jsonrpc: '2.0', error: { code: 3117, message: 'The transaction contains unknown UTxO references as inputs.', data: { unknownOutputReferences: [] } } } }) });
    expect(await code(make().prepare(req))).toBe('pending_tx');
    world({ [K + '/ogmios']: () => ({ status: 400, body: { jsonrpc: '2.0', error: { code: -32602, message: 'Invalid transaction; malformed in ALL eras' } } }) });
    expect(await code(make().prepare(req))).toBe('simulation_failed');
    world({ [K + '/ogmios']: 'down' });
    expect(await code(make().prepare(req))).toBe('ok');
    world({ [K + '/ogmios']: () => ({ status: 503, body: {}, text: 'upstream unavailable' }) });
    expect(await code(make().prepare(req))).toBe('ok');
  });
});

describe('cardano adapter: broadcast, tracking, deposits', () => {
  const signed = async () => { world(); const p = await make().prepare(req); const { b } = built(p); return { raw: Buffer.from(cardanoSignedTx(b.body, new Uint8Array(32).fill(1), new Uint8Array(64).fill(2))).toString('hex'), txid: b.txid, x: p.section.x as Record<string, string> }; };

  it('broadcasts to both sources; a refusal is fine only when the transaction is already on chain', async () => {
    const { raw, txid } = await signed();
    let s = world();
    await make().broadcast(raw);
    expect(s.submitted).toEqual([raw, raw]);
    s = world({ [K + '/submittx']: () => ({ status: 400, body: {}, text: 'BadInputsUTxO' }) });
    await make().broadcast(raw);                                                                             // one source is enough
    s = world({ [K + '/submittx']: () => ({ status: 400, body: {}, text: 'BadInputsUTxO' }), [Y + '/v2/txs/signed']: () => ({ status: 500, body: { error: 'x' } }) });
    await expect(make().broadcast(raw)).rejects.toThrow(/koios 400: BadInputsUTxO/);
    s.conf[txid] = 0;                                                                                        // already in a block
    await make().broadcast(raw);
    await expect(make().broadcast('00')).rejects.toThrow(/not a Cardano signed transaction/);
  });

  it('tracks confirming → finalized, reorged, and expiry only when both sources agree the window is closed', async () => {
    const { txid, x } = await signed();
    const p = { txid, intent: { x }, blockRef: null, broadcastAt: 0 };
    let s = world();
    expect(await make().track(p)).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true });
    s.conf[txid] = 0;
    expect(await make().track(p)).toEqual({ state: 'confirming', confirmations: 1, blockRef: 'seen' });
    s.conf[txid] = 14;
    expect(await make().track(p)).toMatchObject({ state: 'finalized', confirmations: 15 });
    s = world();
    expect(await make().track({ ...p, blockRef: 'seen' })).toMatchObject({ state: 'reorged', rebroadcast: true });   // was in a block, no longer known
    s = world({ [Y + '/tx/status']: 'down' });
    expect(await make().track({ ...p, intent: { x: { ...x, ttl: '5' } } })).toMatchObject({ state: 'broadcast' });  // one source cannot tell: no verdict
    s = world();
    expect(await make().track({ ...p, intent: { x: { ...x, ttl: String(Number(x.ttl) - 2000) } } })).toEqual({ state: 'failed', confirmations: 0, error: 'expired before inclusion (validity window closed); no funds moved' });
    expect(await make().track({ ...p, intent: { x: { ...x, ttl: String(Number(x.ttl) - 950) } } })).toMatchObject({ state: 'broadcast' }); // closed 50 s ago: a late block may still carry it
    void s;
  });

  it('reports finalized incoming payments confirmed by both sources, never its own change', async () => {
    const dep = tx(0xd1), own = tx(0xd2), young = tx(0xd3);
    const info = (h: string, inputAddr: string, outs: [string, string][], height: number) => ({ tx_hash: h, block_height: height, tx_timestamp: 1_794_000_000, inputs: [{ payment_addr: { bech32: inputAddr }, value: '1', tx_index: 0 }], outputs: outs.map(([a, v], k) => ({ payment_addr: { bech32: a }, value: v, tx_index: k })) });
    const infos = [info(dep, TO, [[TO, '7000000'], [FROM, '3000000']], TIP - 100), info(own, FROM, [[TO, '1000000'], [FROM, '2000000']], TIP - 90)];
    const routes = (yoroiAmount = '3000000'): Record<string, Handler> => ({
      [K + '/address_txs']: () => ({ body: [{ tx_hash: young, block_height: TIP - 3 }, { tx_hash: own, block_height: TIP - 90 }, { tx_hash: dep, block_height: TIP - 100 }] }),
      [K + '/tx_info']: (b) => ({ body: infos.filter((t) => (b._tx_hashes as string[]).includes(t.tx_hash)) }),
      [Y + '/v2/txs/get']: () => ({ body: { [dep]: { tx_state: 'Successful', outputs: [{ address: TO, amount: '7000000' }, { address: FROM, amount: yoroiAmount }] }, [own]: { tx_state: 'Successful', outputs: [] } } }),
    });
    world(routes());
    const a = make(), r = await a.deposits(FROM, TIP - 500);
    expect(r.items).toEqual([{ txid: dep, idx: 1, asset: 'native', amount: 3_000_000n, from: TO, block: TIP - 100, time: 1_794_000_000 }]);
    expect(r).toMatchObject({ cursor: TIP - 14, finalizedHeight: TIP - 14 });                                // 15 confirmations
    const s = world(routes());
    expect(await a.deposits(FROM, r.cursor)).toMatchObject({ items: [], cursor: r.cursor });                 // throttled: no request at all
    expect(s.calls).toEqual([]);
    world(routes('2999999'));
    await expect(make().deposits(FROM, TIP - 500)).rejects.toThrow(/sources disagree on a deposit/);
    world(routes());
    expect((await make().deposits(FROM, null)).items.length).toBe(1);                                        // first scan: about one day back
  });
});
