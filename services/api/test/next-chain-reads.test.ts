// NEXT B1 / B2 / H1 / H2 / H3 — the chain adapters against scripted JSON-RPC endpoints (no network, no database):
//   Solana balances   a token is never 0 without a read; truncated / empty lists; sources that disagree
//   EVM balances      both endpoints read at the same block; disagreement; one endpoint down; unreadable token; stale state
//   Bitcoin-style     the same (confirmed, mempool net) rule on every indexer; Esplora's missing unconfirmed change
//   EVM native scan   direct deposit, the wallet's own outgoing transaction, a transfer inside a contract call, a swap paying
//                     out the native coin, endpoints without historical state, endpoints that disagree, the RPC bound
//   EVM token scan    a backlog larger than one pass is read range by range, with no gap
//   Solana scan       paging with `before` until the cursor, oldest first, a slot never split, an unavailable transaction
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, hexToNumber, multicall3Abi, numberToHex, pad } from 'viem';
import { associatedTokenAddress, NETWORKS, TOKEN_PROGRAM, tokenProgramOf, type NetworkDef } from '@spw/core';

Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48) });
let evm: typeof import('../src/chains/evm.ts'), solMod: typeof import('../src/chains/sol.ts'), btc: typeof import('../src/chains/btc.ts'), rpc: typeof import('../src/chains/rpc.ts');
beforeAll(async () => { evm = await import('../src/chains/evm.ts'); solMod = await import('../src/chains/sol.ts'); btc = await import('../src/chains/btc.ts'); rpc = await import('../src/chains/rpc.ts'); });
afterEach(() => { vi.unstubAllGlobals(); rpc.resetRpcHealth(); });

class RpcError extends Error { constructor(message: string, public code = -32000) { super(message); } }
const DOWN = Symbol('down');
type Handler = (method: string, params: any[], url: string) => unknown;
/** every JSON-RPC request goes to the handler of its endpoint; the calls are recorded */
function serve(handlers: Record<string, Handler | typeof DOWN>): { calls: { url: string; method: string; params: any[] }[] } {
  const calls: { url: string; method: string; params: any[] }[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input), h = handlers[url];
    if (h === undefined) throw new Error(`unscripted endpoint ${url}`);
    if (h === DOWN) return new Response('down', { status: 503 });
    const req = JSON.parse(String(init!.body)) as { id: number; method: string; params: any[] };
    calls.push({ url, method: req.method, params: req.params });
    try { return Response.json({ jsonrpc: '2.0', id: req.id, result: h(req.method, req.params, url) }); }
    catch (e) { if (e instanceof RpcError) return Response.json({ jsonrpc: '2.0', id: req.id, error: { code: e.code, message: e.message } }); throw e; }
  });
  return { calls };
}

// ================================================================================================================ Solana balances
describe('Solana balances: a registry token is never 0 without a read (B1)', () => {
  const N = NETWORKS.solana as NetworkDef, [A, B] = N.rpc as [string, string], ME = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
  const USDC = N.tokens.find((t) => t.symbol === 'USDC')!, OTHER = N.tokens.find((t) => t.id !== USDC.id)!;
  const ata = (mint: string) => associatedTokenAddress(ME, mint, tokenProgramOf(N.tokens.find((t) => t.id === mint)!));
  interface End { lamports: number; slot: number; held: Record<string, string>; /** what the LIST answers (default: held) */ list?: Record<string, string>; /** what the direct account read answers (default: held) */ direct?: Record<string, string> }
  const end = (e: End): Handler => (method, p) => {
    const ctx = { slot: e.slot };
    switch (method) {
      case 'getBalance': return { context: ctx, value: e.lamports };
      case 'getTokenAccountsByOwner': return { context: ctx, value: Object.entries(e.list ?? e.held).filter(([mint]) => tokenProgramOf(N.tokens.find((t) => t.id === mint)!) === p[1].programId)
        .map(([mint, amount]) => ({ pubkey: ata(mint), account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals: 6 } } } } } })) };
      case 'getMultipleAccounts': return { context: ctx, value: (p[0] as string[]).map((k) => { const hit = Object.entries(e.direct ?? e.held).find(([mint]) => ata(mint) === k); return hit ? { data: { parsed: { info: { mint: hit[0], tokenAmount: { amount: hit[1] } } } } } : null; }) };
      case 'getBlockTime': return Math.floor(Date.now() / 1000);
      default: throw new RpcError(`unscripted ${method}`, -32601);
    }
  };
  const ad = () => solMod.solAdapter(N);

  it('both endpoints agree: the amount with its slot and two sources; an absent token is 0 only because both say so', async () => {
    serve({ [A]: end({ lamports: 7_000_000, slot: 300, held: { [USDC.id]: '1234' } }), [B]: end({ lamports: 7_000_000, slot: 302, held: { [USDC.id]: '1234' } }) });
    const d = await ad().balancesDetailed!(ME);
    expect(d.assets.native).toEqual({ amount: 7_000_000n, height: 302, sources: 2, asked: 2, agreed: true, stale: false });
    expect(d.assets[USDC.id]).toEqual({ amount: 1234n, height: 302, sources: 2, asked: 2, agreed: true, stale: false });
    expect(d.assets[OTHER.id]).toMatchObject({ amount: 0n, sources: 2, agreed: true });
    expect(d.unavailable).toEqual({});
  });

  it('one endpoint answers a truncated (empty) token list: its answer is discarded, the token keeps the amount the other one read — not 0', async () => {
    serve({ [A]: end({ lamports: 1, slot: 300, held: { [USDC.id]: '1234' } }), [B]: end({ lamports: 1, slot: 300, held: { [USDC.id]: '1234' }, list: {} }) });
    const a = ad(), d = await a.balancesDetailed!(ME);
    expect(d.assets[USDC.id]).toMatchObject({ amount: 1234n, sources: 1, asked: 2, agreed: true });
    expect((await a.balances(ME))[USDC.id]).toBe(1234n);
  });

  it('every endpoint answers an empty list while the account exists: unavailable, and absent from balances()', async () => {
    const broken = { lamports: 1, slot: 300, held: { [USDC.id]: '1234' }, list: {} };
    serve({ [A]: end(broken), [B]: end(broken) });
    const a = ad(), d = await a.balancesDetailed!(ME), legacy = await a.balances(ME);
    expect(d.assets[USDC.id]).toBeUndefined();
    expect(d.unavailable[USDC.id]).toBe('inconsistent_source');
    expect(Object.hasOwn(legacy, USDC.id)).toBe(false);
    expect(legacy.native).toBe(1n);
  });

  it('a single endpoint saying "no token account" is not a read of zero: every token is unavailable, the lamports are known from one source', async () => {
    serve({ [A]: end({ lamports: 9, slot: 300, held: {} }), [B]: DOWN });
    const a = ad(), d = await a.balancesDetailed!(ME), legacy = await a.balances(ME);
    expect(d.assets.native).toMatchObject({ amount: 9n, sources: 1, asked: 2, agreed: true });
    for (const t of N.tokens) { expect(d.assets[t.id], t.symbol).toBeUndefined(); expect(d.unavailable[t.id], t.symbol).toBe('zero_not_confirmed'); expect(legacy[t.id], t.symbol).toBeUndefined(); }
  });

  it('one endpoint has the account, the other consistently has none: unavailable (neither is taken as fact)', async () => {
    serve({ [A]: end({ lamports: 1, slot: 300, held: { [USDC.id]: '1234' } }), [B]: end({ lamports: 1, slot: 301, held: {} }) });
    const d = await ad().balancesDetailed!(ME);
    expect(d.assets[USDC.id]).toBeUndefined();
    expect(d.unavailable[USDC.id]).toBe('sources_disagree_on_existence');
    expect(d.assets[OTHER.id]).toMatchObject({ amount: 0n, sources: 2 }); // the tokens both agree on are still known
  });

  it('two amounts: not agreed, the higher slot is shown; the list of an endpoint that fails leaves the lamports readable', async () => {
    serve({ [A]: end({ lamports: 10, slot: 300, held: { [USDC.id]: '5' } }), [B]: end({ lamports: 12, slot: 305, held: { [USDC.id]: '7' } }) });
    const d = await ad().balancesDetailed!(ME);
    expect(d.assets[USDC.id]).toEqual({ amount: 7n, height: 305, sources: 1, asked: 2, agreed: false, stale: false });
    expect(d.assets.native).toEqual({ amount: 12n, height: 305, sources: 1, asked: 2, agreed: false, stale: false });
  });

  it('the prepare path refuses a token whose balance is unknown instead of calling it insufficient', async () => {
    const h = end({ lamports: 50_000_000, slot: 300, held: { [USDC.id]: '1234' }, list: {} });
    const more: Handler = (m, p, u) => { if (m === 'getGenesisHash') return N.chainRef; if (m === 'getAccountInfo') return { value: null };
      if (m === 'getMultipleAccounts' && p[1].commitment === 'finalized') return { value: (p[0] as string[]).map((id) => ({ owner: tokenProgramOf(N.tokens.find((t) => t.id === id)!), data: { parsed: { type: 'mint', info: { decimals: N.tokens.find((t) => t.id === id)!.decimals } } } })) };
      return h(m, p, u); };
    serve({ [A]: more, [B]: more });
    await expect(ad().prepare({ asset: USDC.id, from: ME, to: '8vCyX7oB6Pc3pbWMGYYZF5pbSnAdQ7Gyr32JqxqCy8ZR', amount: 10n })).rejects.toMatchObject({ code: 'rpc_degraded' });
  });
  it('TOKEN_PROGRAM is the program of the test token (the fixture lists it under the right program)', () => { expect(tokenProgramOf(USDC)).toBe(TOKEN_PROGRAM); });
});

// ================================================================================================================ EVM balances
describe('EVM balances: every endpoint, the same block (B2)', () => {
  const N = NETWORKS.base as NetworkDef, [A, B] = N.rpc as [string, string], ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const T0 = N.tokens[0]!, T1 = N.tokens[1]!;
  interface End { head: number; /** native balance by block tag */ native: (tag: string) => bigint; token?: (id: string, tag: string) => bigint | null; pinned?: boolean; ts?: number }
  const end = (e: End): Handler => (method, p) => {
    switch (method) {
      case 'eth_blockNumber': return numberToHex(e.head);
      case 'eth_getBalance': if (p[1] !== 'latest' && e.pinned === false) throw new RpcError('header not found'); return numberToHex(e.native(p[1]));
      case 'eth_call': {
        if (p[1] !== 'latest' && e.pinned === false) throw new RpcError('header not found');
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: p[0].data });
        const result = (args![0] as unknown as { target: string }[]).map((c) => { const v = e.token ? e.token(c.target.toLowerCase(), p[1]) : 0n; return v === null ? { success: false, returnData: '0x' as const } : { success: true, returnData: pad(numberToHex(v)) }; });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result });
      }
      case 'eth_getBlockByNumber': return { number: p[0], timestamp: numberToHex(e.ts ?? Math.floor(Date.now() / 1000)) };
      default: throw new RpcError(`unscripted ${method}`, -32601);
    }
  };
  const ad = () => evm.evmAdapter(N);

  it('reads both endpoints at min(heads) - 1 and reports the block, two sources, agreed', async () => {
    const tok = (id: string) => (id === T0.id.toLowerCase() ? 2_500_000n : 0n);
    const { calls } = serve({ [A]: end({ head: 100, native: () => 5n * 10n ** 17n, token: tok }), [B]: end({ head: 102, native: () => 5n * 10n ** 17n, token: tok }) });
    const d = await ad().balancesDetailed!(ME);
    expect(d.assets.native).toEqual({ amount: 5n * 10n ** 17n, height: 99, sources: 2, asked: 2, agreed: true, stale: false });
    expect(d.assets[T0.id]).toEqual({ amount: 2_500_000n, height: 99, sources: 2, asked: 2, agreed: true, stale: false });
    expect(d.assets[T1.id]).toMatchObject({ amount: 0n, sources: 2, agreed: true });
    // the state was asked at block 99 on BOTH endpoints, never at `latest`
    const tags = calls.filter((c) => c.method === 'eth_getBalance' || c.method === 'eth_call').map((c) => `${c.url === A ? 'A' : 'B'}:${c.method}:${c.params[1]}`).sort();
    expect([...new Set(tags)]).toEqual(['A:eth_call:0x63', 'A:eth_getBalance:0x63', 'B:eth_call:0x63', 'B:eth_getBalance:0x63']);
    expect(d.unavailable).toEqual({});
  });

  it('two endpoints that disagree: the row is not a fact (agreed false), the amount is the higher block\'s', async () => {
    // B cannot serve the pinned block and answers at its own head (102), where the balance already moved
    serve({ [A]: end({ head: 100, native: () => 10n, token: () => 1n }), [B]: end({ head: 102, native: () => 30n, token: () => 1n, pinned: false }) });
    const d = await ad().balancesDetailed!(ME);
    expect(d.assets.native).toEqual({ amount: 30n, height: 102, sources: 1, asked: 2, agreed: false, stale: false });
    expect(d.assets[T0.id]).toMatchObject({ amount: 1n, height: 102, sources: 2, agreed: true }); // what they agree on stays a fact
  });

  it('the same block, two amounts: neither is a fact; the lower one is displayed', async () => {
    serve({ [A]: end({ head: 100, native: () => 40n }), [B]: end({ head: 100, native: () => 25n }) });
    expect((await ad().balancesDetailed!(ME)).assets.native).toEqual({ amount: 25n, height: 99, sources: 1, asked: 2, agreed: false, stale: false });
  });

  it('one endpoint down: one source, said so; a token no endpoint can read is unavailable, not 0; an old block is stale', async () => {
    serve({ [A]: DOWN, [B]: end({ head: 100, native: () => 8n, token: (id) => (id === T0.id.toLowerCase() ? null : 3n), ts: Math.floor(Date.now() / 1000) - 3600 }) });
    const d = await ad().balancesDetailed!(ME);
    expect(d.assets.native).toEqual({ amount: 8n, height: 99, sources: 1, asked: 2, agreed: true, stale: true });
    expect(d.assets[T0.id]).toBeUndefined();
    expect(d.unavailable[T0.id]).toBe('no_source_answered');
    expect(d.assets[T1.id]).toMatchObject({ amount: 3n, sources: 1 });
  });

  it('no endpoint: the read fails (the portfolio marks the network unavailable)', async () => {
    serve({ [A]: DOWN, [B]: DOWN });
    await expect(ad().balancesDetailed!(ME)).rejects.toThrow(/no endpoint answered/);
  });
});

// ================================================================================================================ Bitcoin-style
describe('Bitcoin-style balances: one rule for the mempool on every indexer (B2)', () => {
  const N = NETWORKS.bitcoin as NetworkDef, ME = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
  const src = (o: { confirmed: bigint; net: bigint; tip: number | Error }) => ({ url: 'https://x.test', tip: async () => { if (o.tip instanceof Error) throw o.tip; return o.tip; }, detail: async () => ({ confirmed: o.confirmed, net: o.net }),
    balance: async () => o.confirmed, blockHash: async () => '', utxos: async () => [], feeRate: async () => 1, broadcast: async () => {}, status: async () => ({ found: false, confirmed: false }), rawTx: async () => '' });

  it('Esplora: a send of 1 from a coin of 5 shows 4 while unconfirmed (it showed 0: the unconfirmed change was not counted back)', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ chain_stats: { funded_txo_sum: 500_000_000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 399_990_000, spent_txo_sum: 500_000_000 } }));
    const s = btc.esplora('https://esplora.test/api');
    expect(await s.detail!(ME)).toEqual({ confirmed: 500_000_000n, net: -100_010_000n });
    expect(await s.balance(ME)).toBe(399_990_000n);
  });
  it('Esplora and Blockbook give the same figures for the same mempool; an unconfirmed receipt is pendingIn, not balance', async () => {
    vi.stubGlobal('fetch', async (u: unknown) => (String(u).includes('bb.test')
      ? Response.json({ balance: '500000000', unconfirmedBalance: '25000' })
      : Response.json({ chain_stats: { funded_txo_sum: 700_000_000, spent_txo_sum: 200_000_000 }, mempool_stats: { funded_txo_sum: 25_000, spent_txo_sum: 0 } })));
    const e = await btc.esplora('https://esplora.test/api').detail!(ME), b = await btc.blockbook('https://bb.test/api/v2').detail!(ME);
    expect(e).toEqual({ confirmed: 500_000_000n, net: 25_000n }); expect(b).toEqual(e);
    expect(await btc.esplora('https://esplora.test/api').balance(ME)).toBe(500_000_000n);
  });
  it('Bitcore: from the coin list — confirmed coins, minus those the mempool spends, plus nothing unconfirmed', async () => {
    vi.stubGlobal('fetch', async () => Response.json([
      { mintTxid: 'a'.repeat(64), mintIndex: 0, mintHeight: 800_000, spentHeight: -2, value: 300 }, { mintTxid: 'b'.repeat(64), mintIndex: 1, mintHeight: 800_001, spentHeight: -1, value: 200 },
      { mintTxid: 'c'.repeat(64), mintIndex: 0, mintHeight: -1, spentHeight: -2, value: 150 }, { mintTxid: 'd'.repeat(64), mintIndex: 0, mintHeight: 799_000, spentHeight: 799_500, value: 999 }]));
    expect(await btc.bitcore('https://bitcore.test/api/BTC/mainnet').detail!(ME)).toEqual({ confirmed: 500n, net: -50n });
  });
  it('the adapter compares `confirmed` between indexers and exposes confirmed / pendingOut / pendingIn', async () => {
    const agree = await btc.btcAdapter(N, [src({ confirmed: 500n, net: -120n, tip: 900_000 }), src({ confirmed: 500n, net: -120n, tip: 900_001 })] as never).balancesDetailed!(ME);
    expect(agree).toEqual({ assets: { native: { amount: 380n, height: 900_001, sources: 2, asked: 2, agreed: true, stale: false, confirmed: 500n, pendingOut: 120n, pendingIn: 0n } }, unavailable: {} });
    // one indexer is a block behind and has not seen a confirmed receipt yet
    const lag = (await btc.btcAdapter(N, [src({ confirmed: 500n, net: 0n, tip: 900_000 }), src({ confirmed: 800n, net: 40n, tip: 900_001 })] as never).balancesDetailed!(ME)).assets.native!;
    expect(lag).toEqual({ amount: 800n, height: 900_001, sources: 1, asked: 2, agreed: false, stale: false, confirmed: 800n, pendingOut: 0n, pendingIn: 40n });
    const one = (await btc.btcAdapter(N, [src({ confirmed: 500n, net: 0n, tip: new Error('x') }), { ...src({ confirmed: 0n, net: 0n, tip: 1 }), detail: async () => { throw new Error('down'); } }] as never).balancesDetailed!(ME)).assets.native!;
    expect(one).toMatchObject({ amount: 500n, height: null, sources: 1, asked: 2, agreed: true });
  });
});

// ================================================================================================================ EVM native scan
describe('EVM native deposits without a trace API (H1)', () => {
  const N = NETWORKS.base as NetworkDef, [A, B] = N.rpc as [string, string], ME = '0x9858effd232b4033e47d90003d41ec34ecaeda94', OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';
  const ETH = 10n ** 18n, GWEI = 10n ** 9n;
  interface Tx { hash: string; from: string; to: string | null; value: bigint; gasUsed?: bigint; gasPrice?: bigint; status?: number; l1Fee?: bigint }
  /** a scripted chain: what happens to the wallet in each block; balance and nonce at any block follow from it */
  class Chain {
    head = 1000; start = 3n * ETH; blocks = new Map<number, { txs: Tx[]; internal: bigint }>();
    /** per endpoint: the oldest block whose state it keeps (a pruned node), and a lie about one block's balance */
    keep: Record<string, number> = {}; lie: Record<string, { block: number; add: bigint }> = {};
    at(b: number) { let x = this.blocks.get(b); if (!x) this.blocks.set(b, (x = { txs: [], internal: 0n })); return x; }
    tx(b: number, t: Tx) { this.at(b).txs.push(t); return t.hash; }
    cost(t: Tx) { return (t.gasUsed ?? 21_000n) * (t.gasPrice ?? GWEI) + (t.l1Fee ?? 0n) + ((t.status ?? 1) === 1 && t.to !== ME ? t.value : 0n); }
    balance(b: number) { let v = this.start; for (const [k, x] of this.blocks) if (k <= b) { v += x.internal; for (const t of x.txs) { if (t.from === ME) v -= this.cost(t); else if (t.to === ME && (t.status ?? 1) === 1) v += t.value; } } return v; }
    nonce(b: number) { let n = 5; for (const [k, x] of this.blocks) if (k <= b) n += x.txs.filter((t) => t.from === ME).length; return n; }
    hashOf(b: number) { return pad(numberToHex(b + 0xb10c0000)); }
    find(h: string) { for (const [k, x] of this.blocks) { const t = x.txs.find((y) => y.hash === h); if (t) return { t, block: k }; } return null; }
    handler: Handler = (method, p, url) => {
      const state = (tag: string) => { const b = hexToNumber(tag as `0x${string}`); if (b < (this.keep[url] ?? 0)) throw new RpcError('missing trie node 4f2a (path ) state is not available'); return b; };
      switch (method) {
        case 'eth_blockNumber': return numberToHex(this.head);
        case 'eth_getBalance': { const b = state(p[1]); return numberToHex(this.balance(b) + (this.lie[url]?.block === b ? this.lie[url]!.add : 0n)); }
        case 'eth_getTransactionCount': return numberToHex(this.nonce(state(p[1])));
        case 'eth_getBlockByNumber': { const b = hexToNumber(p[0]); const txs = this.blocks.get(b)?.txs ?? [];
          return { number: p[0], hash: this.hashOf(b), timestamp: numberToHex(1_700_000_000 + b * 2), transactions: p[1] ? txs.map((t) => ({ hash: t.hash, from: t.from, to: t.to, value: numberToHex(t.value), gasPrice: numberToHex(t.gasPrice ?? GWEI) })) : txs.map((t) => t.hash) }; }
        case 'eth_getTransactionReceipt': { const f = this.find(p[0]); return f ? { status: numberToHex(f.t.status ?? 1), blockNumber: numberToHex(f.block), from: f.t.from, to: f.t.to, gasUsed: numberToHex(f.t.gasUsed ?? 21_000n), effectiveGasPrice: numberToHex(f.t.gasPrice ?? GWEI), ...(f.t.l1Fee ? { l1Fee: numberToHex(f.t.l1Fee) } : {}) } : null; }
        case 'eth_getTransactionByHash': { const f = this.find(p[0]); return f ? { hash: f.t.hash, from: f.t.from, to: f.t.to, value: numberToHex(f.t.value), gasPrice: numberToHex(f.t.gasPrice ?? GWEI) } : null; }
        default: throw new RpcError(`unscripted ${method}`, -32601);
      }
    };
  }
  const h = (n: number) => pad(numberToHex(n));
  const ad = () => evm.evmAdapter(N);
  const world = () => { const c = new Chain(); const s = serve({ [A]: c.handler, [B]: c.handler }); return { c, calls: s.calls }; };
  const SAFE = 1000 - N.minConf; // 988
  const baseline = (c: Chain, block = 100) => ({ block, balance: c.balance(block), nonce: c.nonce(block) });

  it('the first pass takes a baseline at head - minConf and records nothing', async () => {
    const { c } = world();
    c.tx(500, { hash: h(1), from: OTHER, to: ME, value: ETH });
    const r = await ad().nativeDeposits!(ME, null);
    expect(r.items).toEqual([]);
    expect(r.state).toEqual({ block: SAFE, balance: 4n * ETH, nonce: 5 });
  });

  it('a quiet window costs one head read and one state read per endpoint', async () => {
    const { c, calls } = world();
    const r = await ad().nativeDeposits!(ME, baseline(c, 900));
    expect(r.items).toEqual([]); expect(r.state.block).toBe(SAFE);
    expect(calls.map((x) => x.method).sort()).toEqual(['eth_blockNumber', 'eth_getBalance', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionCount']);
    expect(r.calls).toBe(5);
  });

  it('one window with a direct deposit, the wallet\'s own outgoing transaction and a transfer made inside a contract call', async () => {
    const { c, calls } = world();
    const dep = c.tx(150, { hash: h(1), from: OTHER, to: ME, value: ETH });
    const own = c.tx(170, { hash: h(2), from: ME, to: OTHER, value: ETH / 5n, gasUsed: 21_000n, gasPrice: 3n * GWEI, l1Fee: 4_000n });
    c.at(190).internal = ETH / 20n; // a contract paid the wallet: no transaction `to == wallet` in that block
    c.tx(190, { hash: h(3), from: OTHER, to: ROUTER, value: 0n });
    const prev = baseline(c), r = await ad().nativeDeposits!(ME, prev, { own: [own] });
    expect(r.items).toEqual([
      { txid: dep, idx: evm.NATIVE_IDX, asset: 'native', amount: ETH, from: OTHER, block: 150, time: 1_700_000_300, via: 'tx', blockHash: c.hashOf(150) },
      { txid: c.hashOf(190), idx: evm.NATIVE_IDX, asset: 'native', amount: ETH / 20n, from: '', block: 190, time: 1_700_000_380, via: 'internal_call', blockHash: c.hashOf(190) },
    ]);
    expect(r.notes).toEqual([]);
    // the end state is the chain's: the own transaction (value + gas + L1 fee) is fully accounted for, nothing is invented
    expect(r.state).toEqual({ block: SAFE, balance: prev.balance + ETH + ETH / 20n - (ETH / 5n + 63_000n * GWEI + 4_000n), nonce: 6 });
    // the own transaction was never mistaken for a deposit, and its block was not even read: its receipt explains it
    expect(calls.filter((x) => x.method === 'eth_getBlockByNumber' && x.params[1] === true).map((x) => hexToNumber(x.params[0])).sort()).toEqual([150, 190]);
    expect(r.calls).toBeLessThanOrEqual(1 + 2 * 2 * (40 + 4) + 6 * 27 + 50); // the bound stated in chains/evm.ts
  });

  it('an own transaction the API knows explains its window with two receipts lookups and no bisection', async () => {
    const { c, calls } = world();
    const own = c.tx(940, { hash: h(2), from: ME, to: OTHER, value: ETH });
    const r = await ad().nativeDeposits!(ME, baseline(c, 900), { own: [own, h(77)] });
    expect(r.items).toEqual([]); expect(r.notes).toEqual([]); expect(r.state.nonce).toBe(6);
    expect(calls.some((x) => x.method === 'eth_getBlockByNumber')).toBe(false);
  });

  it('an own transaction the API does NOT know is found by the bisection and still produces no deposit', async () => {
    const { c } = world();
    c.tx(940, { hash: h(2), from: ME, to: OTHER, value: ETH, gasUsed: 50_000n });
    c.tx(940, { hash: h(4), from: OTHER, to: ME, value: 7n }); // and a deposit in the very same block
    const r = await ad().nativeDeposits!(ME, baseline(c, 900));
    expect(r.items.map((d) => [d.txid, d.amount, d.via])).toEqual([[h(4), 7n, 'tx']]);
    expect(r.notes).toEqual([]);
  });

  it('a swap paying out the native coin: the value is recorded under the wallet\'s own transaction (so that it is classified internal)', async () => {
    const { c } = world();
    const swap = c.tx(950, { hash: h(9), from: ME, to: ROUTER, value: 0n, gasUsed: 180_000n });
    c.at(950).internal = ETH / 2n;
    const r = await ad().nativeDeposits!(ME, baseline(c, 900), { own: [swap] });
    expect(r.items).toEqual([{ txid: swap, idx: evm.NATIVE_IDX, asset: 'native', amount: ETH / 2n, from: ROUTER, block: 950, time: 1_700_001_900, via: 'internal_call', blockHash: c.hashOf(950) }]);
  });

  it('a transfer to the wallet that reverted is not a deposit', async () => {
    const { c } = world();
    c.tx(950, { hash: h(5), from: OTHER, to: ME, value: ETH, status: 0 });
    c.tx(951, { hash: h(6), from: OTHER, to: ME, value: 3n });
    expect((await ad().nativeDeposits!(ME, baseline(c, 900))).items.map((d) => d.txid)).toEqual([h(6)]);
  });

  it('endpoints that refuse historical state: the part that cannot be located becomes ONE aggregate deposit at its end block, with a note', async () => {
    const { c } = world();
    c.tx(930, { hash: h(1), from: OTHER, to: ME, value: ETH });
    c.keep = { [A]: 980, [B]: 985 }; // pruned nodes: only the last blocks
    const prev = baseline(c, 900), r = await ad().nativeDeposits!(ME, prev);
    expect(r.items).toEqual([{ txid: c.hashOf(SAFE), idx: evm.NATIVE_IDX + 1, asset: 'native', amount: ETH, from: '', block: SAFE, time: null, via: 'aggregate' }]);
    expect(r.notes).toEqual([{ code: 'state_unavailable', fromBlock: 901, toBlock: SAFE, amount: ETH.toString(), unknownOwnTxs: 0 }]);
    expect(r.state).toEqual({ block: SAFE, balance: prev.balance + ETH, nonce: 5 });
  });

  it('a window too old (long downtime, pruned endpoints): recorded as an aggregate at the recent block — never dropped', async () => {
    const { c } = world();
    c.head = 20_000;
    c.tx(3_000, { hash: h(1), from: OTHER, to: ME, value: 2n * ETH });
    const own = c.tx(9_000, { hash: h(2), from: ME, to: OTHER, value: ETH, gasUsed: 21_000n });
    c.keep = { [A]: 19_900, [B]: 19_900 };
    const prev = baseline(c, 100), r = await ad().nativeDeposits!(ME, prev, { own: [own] });
    const safe = 20_000 - N.minConf;
    // the net increase is +1 ETH - gas, but the own transaction is known: the deposit recorded is the full 2 ETH
    expect(r.items).toEqual([{ txid: c.hashOf(safe), idx: evm.NATIVE_IDX + 1, asset: 'native', amount: 2n * ETH, from: '', block: safe, time: null, via: 'aggregate' }]);
    expect(r.notes).toEqual([{ code: 'window_too_old', fromBlock: 101, toBlock: safe, amount: (2n * ETH).toString(), unknownOwnTxs: 0 }]);
    expect(r.state.block).toBe(safe);
  });

  it('an unexplained decrease records nothing and is reported', async () => {
    const { c } = world();
    c.at(950).internal = -5n;
    const r = await ad().nativeDeposits!(ME, baseline(c, 900));
    expect(r.items).toEqual([]);
    expect(r.notes).toEqual([{ code: 'unexplained_decrease', fromBlock: 950, toBlock: 950, amount: '-5' }]);
  });

  it('endpoints that disagree on a state: nothing is recorded and the state does not move', async () => {
    const { c } = world();
    c.tx(950, { hash: h(1), from: OTHER, to: ME, value: ETH });
    c.lie = { [B]: { block: SAFE, add: 1n } };
    const prev = baseline(c, 900), r = await ad().nativeDeposits!(ME, prev);
    expect(r.items).toEqual([]); expect(r.state).toEqual(prev);
  });

  it('every endpoint down in the middle of a pass: what was resolved is kept, the rest is retried', async () => {
    const c = new Chain(); let fail = false;
    c.tx(905, { hash: h(1), from: OTHER, to: ME, value: ETH }); c.tx(980, { hash: h(2), from: OTHER, to: ME, value: 2n * ETH });
    const flaky: Handler = (m, p, u) => { if (fail && m !== 'eth_blockNumber') throw new RpcError('rate limited', -32005); if (m === 'eth_getBlockByNumber' && hexToNumber(p[0]) === 905) fail = true; return c.handler(m, p, u); };
    serve({ [A]: flaky, [B]: flaky });
    const prev = baseline(c, 900), a = ad(), r1 = await a.nativeDeposits!(ME, prev);
    expect(r1.items).toEqual([]); // the block of the first deposit could not be completed (its receipt failed): nothing recorded past the frontier
    expect(r1.state.block).toBeLessThan(905);
    fail = false; serve({ [A]: c.handler, [B]: c.handler });
    const r2 = await a.nativeDeposits!(ME, r1.state);
    expect(r2.items.map((d) => [d.txid, d.block])).toEqual([[h(1), 905], [h(2), 980]]);
    expect(r2.state).toEqual({ block: SAFE, balance: prev.balance + 3n * ETH, nonce: 5 });
  });

  it('the RPC bound: a pass stops at the bound and the next ones finish, each deposit recorded exactly once', async () => {
    const { c } = world();
    const want = [905, 931, 958, 984].map((b, k) => [c.tx(b, { hash: h(10 + k), from: OTHER, to: ME, value: BigInt(k + 1) }), b]);
    const a = ad(), got: [string, number][] = []; let state = baseline(c, 900), passes = 0, sawBound = false;
    while (state.block < SAFE) {
      const r = await a.nativeDeposits!(ME, state, { maxPoints: 9, maxLeaves: 2 });
      expect(r.state.block).toBeGreaterThanOrEqual(state.block);
      sawBound ||= r.notes.some((x) => x.code === 'budget_exhausted');
      got.push(...r.items.map((d) => [d.txid, d.block] as [string, number])); state = r.state;
      if (++passes > 20) throw new Error('no progress');
    }
    expect(sawBound).toBe(true); expect(passes).toBeGreaterThan(1);
    expect(got).toEqual(want);
    expect(state).toEqual({ block: SAFE, balance: c.balance(SAFE), nonce: 5 });
  });

  it('a backlog longer than one window is walked window by window', async () => {
    const { c } = world();
    c.head = 12_000;
    c.tx(2_500, { hash: h(1), from: OTHER, to: ME, value: 11n }); c.tx(9_100, { hash: h(2), from: OTHER, to: ME, value: 22n });
    const a = ad(), got: string[] = []; let state = baseline(c, 100), passes = 0;
    while (state.block < 12_000 - N.minConf) { const r = await a.nativeDeposits!(ME, state); got.push(...r.items.map((d) => d.txid)); expect(r.state.block - state.block).toBeLessThanOrEqual(4 * 2048); state = r.state; if (++passes > 10) throw new Error('no progress'); }
    expect(got).toEqual([h(1), h(2)]); expect(passes).toBe(2);
  });
});

// ================================================================================================================ EVM token scan
describe('EVM token deposit scan: a backlog is never jumped over (H2)', () => {
  const N = NETWORKS.base as NetworkDef, [A, B] = N.rpc as [string, string], ME = '0x9858effd232b4033e47d90003d41ec34ecaeda94', T0 = N.tokens[0]!;
  const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  it('60 000 blocks behind: every block is read once, in order, over several passes, and both transfers are found', async () => {
    const head = 100_000, at = [12_345, 71_000], ranges: [number, number][] = [];
    const handler: Handler = (m, p) => {
      if (m === 'eth_blockNumber') return numberToHex(head);
      if (m === 'eth_getBlockByNumber') return { number: numberToHex(head - 50) };
      if (m === 'eth_getLogs') { const from = hexToNumber(p[0].fromBlock), to = hexToNumber(p[0].toBlock); ranges.push([from, to]);
        expect(p[0].topics).toEqual([TOPIC, null, pad(ME as `0x${string}`)]);
        return at.filter((b) => b >= from && b <= to).map((b) => ({ address: T0.id, transactionHash: pad(numberToHex(b)), logIndex: '0x3', data: pad(numberToHex(b * 10)), topics: [TOPIC, pad('0x70997970c51812dc3a010c7d01b50e0d17dc79c8'), pad(ME as `0x${string}`)], blockNumber: numberToHex(b) })); }
      throw new RpcError(`unscripted ${m}`, -32601);
    };
    serve({ [A]: handler, [B]: handler });
    const a = evm.evmAdapter(N), found: [number, bigint][] = []; let cursor = 40_000, passes = 0;
    while (cursor < head) {
      const r = await a.deposits(ME, cursor);
      expect(r.cursor).toBeGreaterThan(cursor); expect(r.cursor - cursor).toBeLessThanOrEqual(24_000); // bounded per pass
      found.push(...r.items.map((d) => [d.block, d.amount] as [number, bigint])); cursor = r.cursor; passes++;
    }
    expect(passes).toBe(3);
    expect(found).toEqual([[71_000, 710_000n]]); // 12 345 is before the cursor: not this scan's business
    // contiguous, no hole, no jump: 40 001 … 100 000
    expect(ranges[0]![0]).toBe(40_001); expect(ranges.at(-1)![1]).toBe(head);
    for (let k = 1; k < ranges.length; k++) expect(ranges[k]![0]).toBe(ranges[k - 1]![1] + 1);
  });
  it('a range that keeps failing stops the cursor there (it is retried, not skipped)', async () => {
    const head = 50_000;
    const handler: Handler = (m, p) => { if (m === 'eth_blockNumber') return numberToHex(head); if (m === 'eth_getBlockByNumber') return { number: numberToHex(head) };
      if (m === 'eth_getLogs') { if (hexToNumber(p[0].toBlock) >= 14_000) throw new RpcError('query returned more than 10000 results'); return []; } throw new RpcError('x', -32601); };
    serve({ [A]: handler, [B]: handler });
    const r = await evm.evmAdapter(N).deposits(ME, 10_000);
    expect(r.cursor).toBeGreaterThanOrEqual(12_000); expect(r.cursor).toBeLessThan(14_000);
  });
});

// ================================================================================================================ Solana scan
describe('Solana deposit scan: paged to the cursor, oldest first (H3)', () => {
  const N = NETWORKS.solana as NetworkDef, [A, B] = N.rpc as [string, string], ME = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', PAYER = '8vCyX7oB6Pc3pbWMGYYZF5pbSnAdQ7Gyr32JqxqCy8ZR';
  interface Sig { signature: string; slot: number; err: unknown; blockTime: number }
  /** `count` signatures, oldest first; two per slot from index 200 on (a slot must never be split); every 50th failed on-chain */
  const history = (count: number): Sig[] => Array.from({ length: count }, (_, k) => ({ signature: `sig${String(k).padStart(5, '0')}`, slot: 10_000 + (k < 200 ? k * 2 : 400 + Math.floor((k - 200) / 2)), err: k % 50 === 49 ? { InstructionError: [0, 'Custom'] } : null, blockTime: Math.floor(Date.now() / 1000) - 600 }));
  function cluster(sigs: Sig[], o: { gone?: Set<string>; finalized?: number } = {}): { handler: Handler; pages: { limit: number; before?: string; n: number }[]; asked: string[] } {
    const pages: { limit: number; before?: string; n: number }[] = [], asked: string[] = [];
    const handler: Handler = (m, p) => {
      switch (m) {
        case 'getSlot': return o.finalized ?? sigs.at(-1)!.slot;
        case 'getTokenAccountsByOwner': return { context: { slot: 1 }, value: [] };
        case 'getSignaturesForAddress': { expect(p[0]).toBe(ME); expect(p[1].commitment).toBe('finalized'); expect(typeof p[1].minContextSlot).toBe('number');
          const newest = [...sigs].reverse(), from = p[1].before ? newest.findIndex((s) => s.signature === p[1].before) + 1 : 0, page = newest.slice(from, from + p[1].limit);
          pages.push({ limit: p[1].limit, before: p[1].before, n: page.length }); return page; }
        case 'getTransaction': { asked.push(p[0]); if (o.gone?.has(p[0])) return null; const s = sigs.find((x) => x.signature === p[0])!;
          return { slot: s.slot, blockTime: s.blockTime, transaction: { message: { accountKeys: [{ pubkey: PAYER }, { pubkey: ME }] } }, meta: { err: null, preBalances: [10, 100], postBalances: [5, 100 + Number(s.signature.slice(3))], preTokenBalances: [], postTokenBalances: [] } }; }
        default: throw new RpcError(`unscripted ${m}`, -32601);
      }
    };
    return { handler, pages, asked };
  }

  it('1 300 signatures behind the cursor: three pages, then 40 transactions per pass oldest first, until all are processed once', async () => {
    const sigs = history(1400), c = cluster(sigs);
    serve({ [A]: c.handler, [B]: c.handler });
    const start = sigs[99]!.slot, want = sigs.filter((s) => s.slot > start && !s.err);
    const a = solMod.solAdapter(N), seen: string[] = []; let cursor = start, passes = 0;
    const first = await a.deposits(ME, cursor);
    // page 1: the newest 25; then pages of 1 000 with `before`, until a signature at or below the cursor is met
    expect(c.pages).toEqual([{ limit: 25, before: undefined, n: 25 }, { limit: 1000, before: sigs[1375]!.signature, n: 1000 }, { limit: 1000, before: sigs[375]!.signature, n: 375 }]);
    expect(first.items.map((d) => d.txid)).toEqual(want.slice(0, first.items.length).map((s) => s.signature)); // oldest first
    expect(first.items.length).toBe(40);
    expect(first.cursor).toBe(sigs.find((s) => s.signature === first.items.at(-1)!.txid)!.slot); // the last slot fully processed, not the newest seen
    seen.push(...first.items.map((d) => d.txid)); cursor = first.cursor;
    while (cursor < sigs.at(-1)!.slot) { const r = await a.deposits(ME, cursor); expect(r.cursor).toBeGreaterThan(cursor); seen.push(...r.items.map((d) => d.txid)); cursor = r.cursor; if (++passes > 200) throw new Error('no progress'); }
    expect(seen).toEqual(want.map((s) => s.signature)); // every one, once, in order: nothing skipped, nothing twice
    expect(c.asked.length).toBe(new Set(c.asked).size); // a slot was never split, so no transaction was fetched twice
    const last = await a.deposits(ME, cursor);
    expect(last).toMatchObject({ items: [], cursor });
  });

  it('amounts and senders come from the transaction; a failed one is passed over without a call', async () => {
    const sigs = history(60), c = cluster(sigs);
    serve({ [A]: c.handler, [B]: c.handler });
    const r = await solMod.solAdapter(N).deposits(ME, sigs[44]!.slot);
    expect(r.items.map((d) => [d.txid, d.amount, d.from, d.asset])).toEqual([45, 46, 47, 48, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59].map((k) => [sigs[k]!.signature, BigInt(k), PAYER, 'native']));
    expect(c.asked).not.toContain(sigs[49]!.signature);
    expect(r.cursor).toBe(sigs[59]!.slot);
  });

  it('a transaction no endpoint serves yet stops the pass just before it; once served, the scan goes on from there', async () => {
    const sigs = history(30), gone = new Set([sigs[20]!.signature]), c = cluster(sigs, { gone });
    serve({ [A]: c.handler, [B]: c.handler });
    const a = solMod.solAdapter(N), r1 = await a.deposits(ME, sigs[9]!.slot);
    expect(r1.items.map((d) => d.txid)).toEqual(sigs.slice(10, 20).map((s) => s.signature));
    expect(r1.cursor).toBe(sigs[19]!.slot); expect(r1.gaps).toBeUndefined();
    gone.clear();
    const r2 = await a.deposits(ME, r1.cursor);
    expect(r2.items.map((d) => d.txid)).toEqual(sigs.slice(20).map((s) => s.signature));
  });

  it('a transaction that is old and served by no endpoint is reported as a gap, not silently skipped', async () => {
    const sigs = history(30); sigs[20]!.blockTime = Math.floor(Date.now() / 1000) - 5 * 86_400;
    const c = cluster(sigs, { gone: new Set([sigs[20]!.signature]) });
    serve({ [A]: c.handler, [B]: c.handler });
    const r = await solMod.solAdapter(N).deposits(ME, sigs[9]!.slot);
    expect(r.gaps).toEqual([{ txid: sigs[20]!.signature, block: sigs[20]!.slot }]);
    expect(r.items.length).toBe(19); expect(r.cursor).toBe(sigs[29]!.slot);
  });

  it('signatures above the finalized slot read at the start of the pass are left for the next pass', async () => {
    const sigs = history(30), c = cluster(sigs, { finalized: sigs[24]!.slot });
    serve({ [A]: c.handler, [B]: c.handler });
    const r = await solMod.solAdapter(N).deposits(ME, sigs[19]!.slot);
    expect(r.items.map((d) => d.txid)).toEqual(sigs.slice(20, 25).map((s) => s.signature));
    expect(r.cursor).toBe(sigs[24]!.slot);
  });

  it('the first pass of a wallet (no cursor) reads the newest page only', async () => {
    const sigs = history(500), c = cluster(sigs);
    serve({ [A]: c.handler, [B]: c.handler });
    const r = await solMod.solAdapter(N).deposits(ME, null);
    expect(c.pages).toEqual([{ limit: 25, before: undefined, n: 25 }]);
    expect(r.cursor).toBe(sigs.at(-1)!.slot);
  });
});
