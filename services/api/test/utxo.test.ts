// Dogecoin / Bitcoin Cash adapters without any network access: stub indexers and a stubbed fetch.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { buildBtcTx, IntentSchema, NETWORKS, pluginFor, type Intent } from '@spw/core';

process.env.SPW_ORIGIN ??= 'https://wallet.test';
process.env.SPW_RP_ID ??= 'wallet.test';
process.env.DATABASE_URL ??= 'postgres://unused';
process.env.SPW_SIGNER_SECRET ??= 's'.repeat(48);

type Btc = typeof import('../src/chains/btc.ts');
type Source = import('../src/chains/btc.ts').Source;
let btc: Btc, bchAdapter: typeof import('../src/chains/bch.ts').bchAdapter;
beforeAll(async () => { btc = await import('../src/chains/btc.ts'); ({ bchAdapter } = await import('../src/chains/bch.ts')); });
afterEach(() => vi.unstubAllGlobals());

const DOGE = NETWORKS.dogecoin, BCH = NETWORKS.bitcoincash;
const DOGE_JS: bitcoin.Network = { messagePrefix: '', bech32: 'doge', bip32: { public: 0x02facafd, private: 0x02fac398 }, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e };
const DOGE_FROM = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', DOGE_TO = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L';
const BCH_FROM = 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6', BCH_TO = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';

function prevTx(value: bigint, salt: number) {
  const t = new bitcoin.Transaction();
  t.version = 1;
  t.addInput(new Uint8Array(32).fill(salt), 0, 0xffffffff, Uint8Array.of(0x51));
  t.addOutput(bitcoin.address.toOutputScript(DOGE_FROM, DOGE_JS), value);
  return { hex: t.toHex(), txid: t.getId() };
}

interface Opt { tip?: number; ref?: string; utxos?: { txid: string; vout: number; value: number; confirmed: boolean }[]; fee?: number | Error; raw?: Record<string, string>; down?: boolean }
function stub(name: string, o: Opt, asked: number[] = []): Source {
  const fail = () => { throw new Error('down'); };
  return {
    url: `https://${name}.test/api`,
    tip: async () => (o.down ? fail() : o.tip ?? 1_000_000),
    blockHash: async (h) => { asked.push(h); return o.ref ?? ''; },
    utxos: async () => (o.down ? fail() : o.utxos ?? []),
    balance: async () => (o.utxos ?? []).reduce((s, u) => s + BigInt(u.value), 0n),
    feeRate: async () => { if (o.fee instanceof Error) throw o.fee; return o.fee ?? 1; },
    broadcast: async () => fail(),
    status: async () => ({ found: false, confirmed: false }),
    rawTx: async (id) => { const r = o.raw?.[id]; if (!r) throw new Error('not served'); return r; },
  };
}
const intentOf = (network: string, from: string, to: string, amount: bigint, prep: { section: Record<string, unknown>; maxFee: bigint }): Intent => {
  const n = NETWORKS[network]!;
  return IntentSchema.parse({ v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', network, chainRef: n.chainRef, asset: 'native',
    symbol: n.native.symbol, decimals: n.native.decimals, amount: amount.toString(), from, to, maxFee: prep.maxFee.toString(), createdAt: 1_800_000_000, expiresAt: 1_800_000_120, policyVersion: 4, ...prep.section });
};

describe('Dogecoin adapter (two sources must agree)', () => {
  const a = prevTx(30_000_000_000n, 1), b = prevTx(900_000_000n, 2);
  const coins = [{ txid: a.txid, vout: 0, value: 30_000_000_000, confirmed: true }, { txid: b.txid, vout: 0, value: 900_000_000, confirmed: true }];
  const raw = { [a.txid]: a.hex, [b.txid]: b.hex };
  const mk = (x: Opt, y: Opt) => btc.btcAdapter(DOGE, [stub('one', { ref: DOGE.chainRef, ...x }), stub('two', { ref: DOGE.chainRef, ...y })]);
  const req = { asset: 'native', from: DOGE_FROM, to: DOGE_TO, amount: 10_000_000_000n };

  it('prepares a legacy transfer whose previous transactions the builder accepts', async () => {
    // the second source lists its coins in another order, sees an extra unconfirmed coin and serves no raw transactions
    const ad = mk({ utxos: coins, raw, fee: 39960.905 }, { utxos: [...coins].reverse().concat({ txid: 'ee'.repeat(32), vout: 0, value: 5, confirmed: false }) });
    await expect(ad.prepare(req)).rejects.toMatchObject({ code: 'rpc_degraded' }); // identity not verified yet
    const h = await ad.health();
    expect(h).toMatchObject({ ok: true, identityVerified: true, height: 1_000_000 });
    const p = await ad.prepare(req);
    const s = p.section as { btc: { inputs: { txid: string; value: string }[]; change: string; fee: string } };
    expect(s.btc.inputs).toEqual([{ txid: a.txid, vout: 0, value: '30000000000' }]); // largest coin first, one is enough
    expect(BigInt(s.btc.change) + BigInt(s.btc.fee) + req.amount).toBe(30_000_000_000n);
    // the node's estimate (0.4 DOGE/kB here) is clamped to the registry bounds: 10 000 koinu per byte at most
    expect(p.maxFee).toBe(BigInt(s.btc.fee));
    expect(Number(s.btc.fee)).toBeLessThanOrEqual(230 * 10_000);
    expect(Number(s.btc.fee)).toBeGreaterThanOrEqual(220 * 1000);
    expect(p.maxFee <= BigInt('100000000')).toBe(true);
    expect((p.aux as { prevTx: Record<string, string> }).prevTx).toEqual({ [a.txid]: a.hex });
    const intent = intentOf('dogecoin', DOGE_FROM, DOGE_TO, req.amount, p);
    expect(buildBtcTx(intent, p.aux).outputsLength).toBe(2);
    // an indexer lying about a previous transaction is caught by the builder, not trusted
    expect(() => buildBtcTx(intent, { prevTx: { [a.txid]: b.hex } })).toThrow(/does not match input txid/);
  });

  it('uses the recommended fee floor when no estimate is available, and spends several coins when needed', async () => {
    const ad = mk({ utxos: coins, raw, fee: new Error('no estimate') }, { utxos: coins, fee: new Error('no estimate') });
    await ad.health();
    const p = await ad.prepare({ ...req, amount: 30_500_000_000n });
    const s = p.section as { btc: { inputs: unknown[]; fee: string } };
    expect(s.btc.inputs.length).toBe(2);
    expect(Number(s.btc.fee)).toBeGreaterThanOrEqual(370 * 1000); // 0.01 DOGE/kB
    expect(Number(s.btc.fee)).toBeLessThanOrEqual(380 * 1000);
    expect(Object.keys((p.aux as { prevTx: object }).prevTx).length).toBe(2);
    await expect(ad.prepare({ ...req, amount: 30_900_000_000n })).rejects.toMatchObject({ code: 'insufficient_funds' });
  });

  it('fails closed on disagreement, on a missing source, on a wrong chain and on a stale source', async () => {
    for (const other of [
      [coins[0]!], // a coin missing
      [...coins, { txid: 'ab'.repeat(32), vout: 1, value: 7, confirmed: true }], // an extra coin
      [{ ...coins[0]!, value: 30_000_000_001 }, coins[1]!], // another value
      [{ ...coins[0]!, vout: 1 }, coins[1]!],
      [{ ...coins[0]!, confirmed: false }, coins[1]!], // not confirmed for one of them
      [],
    ]) {
      const ad = mk({ utxos: coins, raw }, { utxos: other });
      await ad.health();
      await expect(ad.prepare(req), JSON.stringify(other)).rejects.toMatchObject({ code: 'rpc_disagreement', status: 503 });
    }
    // a source that answers the first time and is unreachable the second time
    const flaky = stub('two', { ref: DOGE.chainRef, utxos: coins });
    let calls = 0;
    flaky.utxos = async () => { if (++calls > 1) throw new Error('down'); return coins; };
    const downLater = btc.btcAdapter(DOGE, [stub('one', { ref: DOGE.chainRef, utxos: coins, raw }), flaky]);
    await downLater.health();
    await downLater.prepare(req);
    await expect(downLater.prepare(req)).rejects.toMatchObject({ code: 'rpc_degraded', status: 503 });

    const wrongChain = mk({ utxos: coins, raw }, { utxos: coins, ref: NETWORKS.litecoin.chainRef });
    expect(await wrongChain.health()).toMatchObject({ ok: false, identityVerified: false, readable: true });
    await expect(wrongChain.prepare(req)).rejects.toMatchObject({ code: 'rpc_degraded' });

    const oneDown = mk({ utxos: coins, raw }, { down: true });
    expect(await oneDown.health()).toMatchObject({ ok: false, readable: true, identityVerified: false });

    // a source trailing by more than the confirmation depth counts as down (20 blocks for Dogecoin)
    const stale = mk({ utxos: coins, raw, tip: 6_452_441 }, { utxos: coins, tip: 6_452_441 - 21 });
    const hs = await stale.health();
    expect(hs).toMatchObject({ ok: false, identityVerified: false, height: 6_452_441 });
    expect(hs.endpoints.map((e) => e.ok)).toEqual([true, false]);
    const lagging = mk({ utxos: coins, raw, tip: 6_452_441 }, { utxos: coins, tip: 6_452_441 - 20 });
    expect((await lagging.health()).ok).toBe(true);
  });
});

describe('existing native SegWit chains keep their behaviour', () => {
  it('Litecoin: witness inputs, no helper data, market fee estimate, genesis identity', async () => {
    const LTC = NETWORKS.litecoin, asked: number[] = [];
    const from = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh', to = 'ltc1qg42tkwuuxefutzxezdkdel39gfstuap288mfea';
    const coins = [{ txid: 'cd'.repeat(32), vout: 0, value: 5_000_000, confirmed: true }];
    const ad = btc.btcAdapter(LTC, [stub('one', { ref: LTC.chainRef, utxos: coins, fee: 2 }, asked), stub('two', { ref: LTC.chainRef, utxos: coins, fee: 50 }, asked)]);
    expect((await ad.health()).ok).toBe(true);
    expect(asked).toEqual([0, 0]);
    const p = await ad.prepare({ asset: 'native', from, to, amount: 2_000_000n });
    expect(p.aux).toBeUndefined();
    expect(p.section).toEqual({ btc: { inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: '5000000' }], change: '2999687', fee: '313' } }); // 142 vB × 2.2 (first source's estimate + 10 %), as before the refactor
    expect(buildBtcTx(intentOf('litecoin', from, to, 2_000_000n, p)).outputsLength).toBe(2);
    const noEstimate = btc.btcAdapter(LTC, [stub('one', { ref: LTC.chainRef, utxos: coins, fee: new Error('x') }), stub('two', { ref: LTC.chainRef, utxos: coins, fee: new Error('x') })]);
    await noEstimate.health();
    await expect(noEstimate.prepare({ asset: 'native', from, to, amount: 2_000_000n })).rejects.toThrow(); // no registry bounds: an estimate is required
  });
});

describe('Bitcoin Cash adapter', () => {
  const coins = [{ txid: 'aa'.repeat(32), vout: 1, value: 150_000, confirmed: true }, { txid: 'bb'.repeat(32), vout: 0, value: 60_000, confirmed: true }];
  const req = { asset: 'native', from: BCH_FROM, to: BCH_TO, amount: 180_000n };

  it('checks identity at the first block after the last chain split and prepares a section the plugin rebuilds', async () => {
    const asked: number[] = [];
    const ad = bchAdapter(BCH, [stub('one', { ref: BCH.chainRef, utxos: coins, tip: 976_826 }, asked), stub('two', { ref: BCH.chainRef, utxos: [...coins].reverse(), tip: 976_826 }, asked)]);
    expect((await ad.health()).ok).toBe(true);
    expect(asked).toEqual([661648, 661648]);
    const p = await ad.prepare(req);
    expect(p.aux).toBeUndefined();
    const x = (p.section as { x: Record<string, string> }).x;
    expect(Object.keys(x).sort()).toEqual(['change', 'fee', 'inputs']);
    expect(x.inputs).toBe(`${'aa'.repeat(32)}:1:150000,${'bb'.repeat(32)}:0:60000`);
    expect(BigInt(x.change!) + BigInt(x.fee!) + 180_000n).toBe(210_000n);
    expect(Number(x.fee)).toBeGreaterThanOrEqual(374); // ≥ 1 sat/byte on the upper-bound size (2 inputs, 2 outputs)
    expect(Number(x.fee)).toBeLessThanOrEqual(500);
    const intent = intentOf('bitcoincash', BCH_FROM, BCH_TO, req.amount, p);
    expect(pluginFor(BCH).build(intent, BCH, p.aux).signDocs.length).toBe(2);
    // dust change is given to the fee instead of creating an unspendable output
    const q = await ad.prepare({ ...req, amount: 209_400n });
    expect((q.section as { x: Record<string, string> }).x).toMatchObject({ change: '0', fee: '600' });
    expect(pluginFor(BCH).build(intentOf('bitcoincash', BCH_FROM, BCH_TO, 209_400n, q), BCH).signDocs.length).toBe(2);
  });

  it('a node of another chain with the same genesis block is not accepted as Bitcoin Cash', async () => {
    expect(BCH.chainRef).not.toBe(NETWORKS.bitcoin.chainRef);
    const otherChain = '00'.repeat(31) + '01'; // any other block hash at that height
    const ad = bchAdapter(BCH, [stub('one', { ref: BCH.chainRef, utxos: coins }), stub('two', { ref: otherChain, utxos: coins })]);
    expect(await ad.health()).toMatchObject({ ok: false, identityVerified: false });
    await expect(ad.prepare(req)).rejects.toMatchObject({ code: 'rpc_degraded' });
  });

  it('fails closed on disagreement', async () => {
    const ad = bchAdapter(BCH, [stub('one', { ref: BCH.chainRef, utxos: coins }), stub('two', { ref: BCH.chainRef, utxos: [coins[0]!] })]);
    await ad.health();
    await expect(ad.prepare(req)).rejects.toMatchObject({ code: 'rpc_disagreement' });
  });
});

describe('indexer clients (stubbed fetch)', () => {
  const serve = (routes: Record<string, { status?: number; body: unknown }>) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      if (!key) return new Response('not found', { status: 404 });
      const r = routes[key]!;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
    });
    return calls;
  };
  const coin = (o: object) => ({ mintTxid: 'cc'.repeat(32), mintIndex: 0, mintHeight: 600000, spentHeight: -2, value: 926600, ...o });

  it('Bitcore: strips the CashAddr prefix, keeps only unspent coins, refuses a truncated page and inexact amounts', async () => {
    const s = btc.sourceOf('bitcore:https://bitcore.test/api/BCH/mainnet');
    const path = '/address/qzeer89eku4hkh3w7mrzra8ppwty27jq6vdpg7tpa0/?unspent=true&limit=1000';
    const calls = serve({ [path]: { body: [coin({}), coin({ mintIndex: 1, spentHeight: -1 }), coin({ mintIndex: 2, mintHeight: -1 }), coin({ mintIndex: 3, mintHeight: -3 }), coin({ mintIndex: 4, spentHeight: 700000 })] } });
    expect(await s.utxos('bitcoincash:qzeer89eku4hkh3w7mrzra8ppwty27jq6vdpg7tpa0')).toEqual([
      { txid: 'cc'.repeat(32), vout: 0, value: 926600, confirmed: true }, { txid: 'cc'.repeat(32), vout: 2, value: 926600, confirmed: false }]);
    expect(calls[0]!.url).toBe('https://bitcore.test/api/BCH/mainnet' + path);
    serve({ [path]: { body: Array.from({ length: 1000 }, (_, k) => coin({ mintIndex: k })) } });
    await expect(s.utxos('qzeer89eku4hkh3w7mrzra8ppwty27jq6vdpg7tpa0')).rejects.toThrow(/too many coins/);
    for (const value of [1.5, 2 ** 53, -1, '12']) {
      serve({ [path]: { body: [coin({ value })] } });
      if (value === '12') expect((await s.utxos('qzeer89eku4hkh3w7mrzra8ppwty27jq6vdpg7tpa0'))[0]!.value).toBe(12);
      else await expect(s.utxos('qzeer89eku4hkh3w7mrzra8ppwty27jq6vdpg7tpa0'), String(value)).rejects.toThrow(/exact integer/);
    }
    serve({ [path]: { body: [coin({ mintTxid: 'zz' })] } });
    await expect(s.utxos('qzeer89eku4hkh3w7mrzra8ppwty27jq6vdpg7tpa0')).rejects.toThrow(/malformed/);
  });

  it('Bitcore: tip, identity block, fee, status; a broadcast counts only when a transaction id comes back', async () => {
    const s = btc.sourceOf('bitcore:https://bitcore.test/api/DOGE/mainnet');
    const id = 'ab'.repeat(32);
    const calls = serve({
      '/block/tip': { body: { height: 6452441 } }, '/block/0': { body: { hash: DOGE.chainRef } }, '/fee/3': { body: { feerate: 0.01 } },
      [`/tx/${id}`]: { body: { blockHeight: 6423225, blockHash: 'ff'.repeat(32) } }, [`/tx/${'cd'.repeat(32)}`]: { body: { blockHeight: -1 } },
      '/tx/send': { body: { txid: id } },
    });
    expect(await s.tip()).toBe(6452441);
    expect(await s.blockHash(0)).toBe(DOGE.chainRef);
    expect(await s.feeRate()).toBe(1000); // 0.01 DOGE/kB = 1000 koinu per byte
    expect(await s.status(id)).toEqual({ found: true, confirmed: true, height: 6423225, hash: 'ff'.repeat(32) });
    expect(await s.status('cd'.repeat(32))).toEqual({ found: true, confirmed: false });
    expect(await s.status('ef'.repeat(32))).toEqual({ found: false, confirmed: false });
    await expect(s.rawTx(id)).rejects.toThrow(/not served/);
    await s.broadcast('0100');
    const sent = calls[calls.length - 1]!;
    expect([sent.url, sent.init?.method, sent.init?.body]).toEqual(['https://bitcore.test/api/DOGE/mainnet/tx/send', 'POST', '{"rawTx":"0100"}']);
    serve({ '/tx/send': { status: 500, body: 'TX decode failed' } });
    await expect(s.broadcast('00')).rejects.toThrow(/TX decode failed/);
    serve({ '/tx/send': { body: {} } });
    await expect(s.broadcast('00')).rejects.toThrow(/not acknowledged/);
    serve({ '/tx/send': { body: 'ok' } });
    await expect(s.broadcast('00')).rejects.toThrow(/not acknowledged/);
    serve({ '/fee/3': { body: { feerate: -1 } } });
    await expect(s.feeRate()).rejects.toThrow(/no fee estimate/);
  });

  it('adapter broadcast: success needs one acknowledgement; "already known" is success; anything else is an error', async () => {
    const mk = (m1: string | null, m2: string | null) => btc.btcAdapter(DOGE, [m1, m2].map((m, k) => ({ ...stub(`s${k}`, {}), broadcast: async () => { if (m !== null) throw new Error(m); } })));
    await mk(null, 'down').broadcast('00');
    await mk('down', null).broadcast('00');
    await mk('down', 'transaction already in block chain').broadcast('00');
    await mk('txn-already-known', 'down').broadcast('00');
    await expect(mk('TX decode failed', '-26: dust').broadcast('00')).rejects.toThrow(/TX decode failed/);
  });

  it('Blockbook: exact amounts only, identity block by height, deposit history without the wallet\'s own sends', async () => {
    const s = btc.sourceOf('blockbook:https://bb.test/api/v2');
    const me = BCH_FROM, other = BCH_TO;
    serve({
      '/block-index/661648': { body: { blockHash: BCH.chainRef } },
      [`/utxo/${me}`]: { body: [{ txid: 'aa'.repeat(32), vout: 0, value: '926600', confirmations: 3 }, { txid: 'bb'.repeat(32), vout: 1, value: '5', confirmations: 0 }] },
      [`/address/${me}?details=txs&pageSize=50`]: { body: { transactions: [
        { txid: 'a1'.repeat(32), vin: [{ addresses: [other] }], vout: [{ value: '700', n: 0, addresses: [other] }, { value: '926600', n: 1, addresses: [me] }], blockHeight: 600000, confirmations: 9, blockTime: 1568338904 },
        { txid: 'a2'.repeat(32), vin: [{ addresses: [me] }], vout: [{ value: '100', n: 0, addresses: [other] }, { value: '50', n: 1, addresses: [me] }], blockHeight: 600001, confirmations: 8 }, // own send: change is not a deposit
        { txid: 'a3'.repeat(32), vin: [{ addresses: [other] }], vout: [{ value: '9', n: 0, addresses: [me] }], blockHeight: -1, confirmations: 0 }, // unconfirmed
      ] } },
    });
    expect(await s.blockHash(661648)).toBe(BCH.chainRef);
    expect(await s.utxos(me)).toEqual([{ txid: 'aa'.repeat(32), vout: 0, value: 926600, confirmed: true }, { txid: 'bb'.repeat(32), vout: 1, value: 5, confirmed: false }]);
    expect(await s.history!(me)).toEqual([{ txid: 'a1'.repeat(32), idx: 1, asset: 'native', amount: 926600n, from: other, block: 600000, time: 1568338904 }]);
    serve({ [`/utxo/${me}`]: { body: [{ txid: 'aa'.repeat(32), vout: 0, value: '9007199254740993', confirmations: 3 }] } });
    await expect(s.utxos(me)).rejects.toThrow(/exact integer/);
    const ad = bchAdapter(BCH, [s, stub('two', { tip: 600010 })]);
    serve({ '/api/v2': { body: { blockbook: { bestHeight: 600010 } } }, [`/address/${me}?details=txs&pageSize=50`]: { body: { transactions: [] } } });
    expect(await ad.deposits(me, null)).toEqual({ items: [], cursor: 600010, finalizedHeight: 600005 });
  });

  it('source specifications in the registry resolve to the intended clients', () => {
    expect(DOGE.rpc.map((r) => r.split(':')[0])).toEqual(['blockbook', 'bitcore']);
    expect(BCH.rpc.map((r) => r.split(':')[0])).toEqual(['blockbook', 'bitcore']);
    expect(new Set([...DOGE.rpc, ...BCH.rpc].map((r) => new URL(r.replace(/^[a-z]+:(?=https:)/, '')).host.split('.').slice(-2).join('.'))).size).toBe(2); // two operators
    for (const r of [...DOGE.rpc, ...BCH.rpc]) expect(btc.sourceOf(r).url.startsWith('https://')).toBe(true);
    expect(btc.sourceOf('https://mempool.space/api').history).toBeTypeOf('function');
  });
});
