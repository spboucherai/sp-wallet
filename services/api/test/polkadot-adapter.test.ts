// Polkadot (Asset Hub) adapter against two scripted JSON-RPC sources (no network), with the REAL runtime metadata and real
// blocks recorded from mainnet: the hand-written metadata reader against @polkadot/types, the runtime-upgrade pins, agreement
// rules, existential-deposit rules, fee and dry run, tracking by nonce, deposits by state comparison + event decoding.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Metadata as SdkMetadata, TypeRegistry } from '@polkadot/types';
import { blake2AsHex, xxhashAsHex } from '@polkadot/util-crypto';
import { buildPolkadotTx, NETWORKS, polkadotAccountId, polkadotDecodeExtrinsic, polkadotExtrinsic, polkadotTxid, POLKADOT_EXTENSIONS, scaleCompact, ScaleReader, ss58Encode, type Intent } from '@spw/core';
import { decodeValue, palletOf, parseMetadata, renderType, storageKey, twox128, typeByPath, variantsOf, xxhash64, type Metadata } from '../src/chains/polkadot-metadata.ts';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.polkadot;
const [A, B] = n.rpc as [string, string];
const fx = JSON.parse(readFileSync(new URL('../../../packages/core/test/fixtures/polkadot-asset-hub.json', import.meta.url), 'utf8')) as { transfers: { block: number; blockHash: string; index: number; hex: string; events?: string }[] };
const META_BYTES = gunzipSync(readFileSync(new URL('../../../packages/core/test/fixtures/polkadot-asset-hub-metadata.hex.gz', import.meta.url)));
const META_HEX = '0x' + META_BYTES.toString('hex');
const meta = parseMetadata(META_BYTES);
const registry = new TypeRegistry();
const sdkMeta = new SdkMetadata(registry, META_BYTES);
registry.setMetadata(sdkMeta);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const FROM = ss58Encode(0, new Uint8Array(32).fill(0x11)), TO = ss58Encode(0, new Uint8Array(32).fill(0x22)), NEW = ss58Encode(0, new Uint8Array(32).fill(0x33));
const GENESIS = '0x' + n.chainRef, FIN = 23_004_000, ED = 100_000_000n, QUOTE = '9058355';
const hashOf = (b: number) => '0x' + b.toString(16).padStart(64, '0');
const numberOf = (h: string) => parseInt(h.slice(2), 16);
const DRY = blake2AsHex('DryRunApi', 64);
const le = (v: bigint, bytes: number) => { const b = new Uint8Array(bytes); for (let k = 0; k < bytes; k++) { b[k] = Number(v & 0xffn); v >>= 8n; } return b; };
const accountRaw = (nonce: number, free: bigint, opt: { reserved?: bigint; frozen?: bigint; providers?: number } = {}) =>
  '0x' + hex(Uint8Array.from([...le(BigInt(nonce), 4), ...le(0n, 4), ...le(BigInt(opt.providers ?? 1), 4), ...le(0n, 4), ...le(free, 16), ...le(opt.reserved ?? 0n, 16), ...le(opt.frozen ?? 0n, 16), ...le(1n << 127n, 16)]));
const keyOf = (addr: string) => storageKey('System', 'Account', polkadotAccountId(addr));
const EVENTS = storageKey('System', 'Events'), NOW = storageKey('Timestamp', 'Now');

type Handler = (params: any[], url: string) => unknown;
class RpcErr extends Error { code: number; constructor(code: number, message: string) { super(message); this.code = code; } }
interface World {
  fin: Record<string, number>; best: number; version: { specName: string; specVersion: number; transactionVersion: number; apis: [string, number][] }; metadata: Record<string, string>;
  /** account state per address: a function of the block number (undefined = latest) */
  accounts: Record<string, (block: number) => string | null>; nextIndex: Record<string, number>; quote: Record<string, string>; dry: Record<string, string>;
  blocks: Record<number, { extrinsics: string[]; events?: string }>; submitted: string[]; calls: { url: string; method: string; params: any[] }[]; over: Record<string, Handler | 'down'>; perUrl: Record<string, Record<string, Handler | 'down'>>;
}
function world(patch: (w: World) => void = () => {}): World {
  const w: World = {
    fin: { [A]: FIN, [B]: FIN }, best: FIN + 25, version: { specName: 'statemint', specVersion: 2005002, transactionVersion: 15, apis: [[DRY, 2]] }, metadata: { [A]: META_HEX, [B]: META_HEX },
    accounts: { [FROM]: () => accountRaw(7, 100_000_000_000n), [TO]: () => accountRaw(0, 5_000_000_000n) }, nextIndex: { [FROM]: 7 }, quote: { [A]: QUOTE, [B]: QUOTE }, dry: { [A]: '0x0000', [B]: '0x0000' },
    blocks: {}, submitted: [], calls: [], over: {}, perUrl: {},
  };
  patch(w);
  const acct = (key: string, block: number): string | null => { for (const [addr, f] of Object.entries(w.accounts)) if (keyOf(addr) === key) return f(block); return null; };
  const methods: Record<string, Handler> = {
    chain_getBlockHash: ([b]) => (b === 0 ? GENESIS : hashOf(b)),
    chain_getFinalizedHead: (_p, u) => hashOf(w.fin[u]!),
    chain_getHeader: ([h]) => ({ number: '0x' + (h === undefined ? w.best : numberOf(h)).toString(16) }),
    state_getRuntimeVersion: () => w.version,
    state_getMetadata: (_p, u) => w.metadata[u],
    system_accountNextIndex: ([addr]) => w.nextIndex[addr] ?? 0,
    payment_queryInfo: (_p, u) => ({ weight: { refTime: 1, proofSize: 1 }, class: 'normal', partialFee: w.quote[u] }),
    state_call: ([method], u) => { if (method !== 'DryRunApi_dry_run_call') throw new RpcErr(-32000, 'unknown runtime api'); return w.dry[u]; },
    state_getStorage: ([key, at]) => {
      const block = at === undefined ? w.best : numberOf(at);
      if (key === NOW) return '0x' + hex(le(BigInt(Date.now() - 4000), 8));
      if (key === EVENTS) return w.blocks[block]?.events ?? '0x00';
      return acct(key, block);
    },
    chain_getBlock: ([h]) => ({ block: { extrinsics: w.blocks[numberOf(h)]?.extrinsics ?? ['0x280403000b'] } }),
    author_submitExtrinsic: ([raw]) => { w.submitted.push(raw); return polkadotTxid(Buffer.from(raw.slice(2), 'hex')); },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const { id, method, params } = JSON.parse(String(init.body)) as { id: number; method: string; params: any[] };
    w.calls.push({ url, method, params });
    const h = w.perUrl[url]?.[method] ?? w.over[method] ?? methods[method];
    if (!h || h === 'down') throw new TypeError('fetch failed');
    try { return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: h(params, url) })); }
    catch (e) { if (e instanceof RpcErr) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message } })); throw e; }
  });
  return w;
}

let make: () => Adapter, checkPolkadotMetadata: (m: Metadata) => { existentialDeposit: bigint; originPrefix: Uint8Array; dispatchErrorType: number };
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'x'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const mod = await import('../src/chains/polkadot.ts');
  make = () => mod.polkadotAdapter(n);
  checkPolkadotMetadata = mod.checkPolkadotMetadata;
});
afterEach(() => vi.unstubAllGlobals());
const req = { asset: 'native', from: FROM, to: TO, amount: 12_500_000_000n };
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message: string }) => e.code ?? `error:${e.message}`);
const msg = async (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);
const clone = (): Metadata => parseMetadata(META_BYTES);

describe('metadata reader (hand-written) against @polkadot/types on the real Asset Hub metadata', () => {
  const latest = sdkMeta.asLatest as any;
  it('reads the same pallets, calls, extensions and constants', () => {
    expect(meta.pallets.map((p) => [p.name, p.index])).toEqual(latest.pallets.map((p: any) => [p.name.toString(), p.index.toNumber()]));
    expect(meta.extrinsic.extensions.map((e) => e.id)).toEqual(latest.extrinsic.transactionExtensions.map((e: any) => e.identifier.toString()));
    expect(meta.extrinsic.extensions.map((e) => [e.id, renderType(meta, e.type), renderType(meta, e.implicit)])).toEqual(POLKADOT_EXTENSIONS);
    expect(meta.types.length).toBe(registry.lookup.types.length);
    for (const p of latest.pallets) {
      if (p.calls.isNone) continue;
      const sdkCalls = registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants.map((v: any) => [v.name.toString(), v.index.toNumber(), v.fields.length]);
      expect(variantsOf(meta, palletOf(meta, p.name.toString()).calls).map((v) => [v.name, v.index, v.fields.length])).toEqual(sdkCalls);
    }
    const call = registry.findMetaCall(Uint8Array.of(10, 3));
    expect([call.section, call.method]).toEqual(['balances', 'transferKeepAlive']);
    expect(variantsOf(meta, palletOf(meta, 'Balances').calls).find((v) => v.name === 'transfer_keep_alive')!.index).toBe(3);
    const c = checkPolkadotMetadata(meta);
    expect(c.existentialDeposit).toBe(ED);
    expect([...c.originPrefix]).toEqual([0, 1]);
  });

  it('computes storage keys as @polkadot/util-crypto does', () => {
    for (const s of ['System', 'Account', 'Events', 'Balances', 'TotalIssuance', 'Timestamp', 'Now', '', 'a', 'x'.repeat(31), 'y'.repeat(32), 'z'.repeat(77)]) expect('0x' + hex(twox128(s))).toBe(xxhashAsHex(s, 128));
    expect(xxhash64(new Uint8Array(0), 0n)).toBe(0xef46db3751d8e999n); // XXH64 reference value for empty input
    const acc = polkadotAccountId(FROM);
    expect(storageKey('System', 'Account', acc)).toBe(xxhashAsHex('System', 128) + xxhashAsHex('Account', 128).slice(2) + blake2AsHex(acc, 128).slice(2) + hex(acc));
    expect(storageKey('System', 'Events')).toBe('0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7');
  });

  it('decodes the events of real blocks exactly as @polkadot/types does', () => {
    const system = palletOf(meta, 'System'), eventsType = system.storage.find((s) => s.name === 'Events')!.value;
    const withEvents = fx.transfers.filter((t) => t.events);
    expect(withEvents.length).toBeGreaterThan(0);
    const outcomes: string[] = [];
    for (const t of withEvents) {
      const r = new ScaleReader(Buffer.from(t.events!.slice(2), 'hex'));
      const mine = decodeValue(meta, eventsType, r) as any[];
      expect(r.done).toBe(true);
      const sdk = registry.createType('Vec<EventRecord>', t.events) as any;
      expect(mine.length).toBe(sdk.length);
      mine.forEach((rec, k) => {
        expect(rec.event.variant.toLowerCase()).toBe(sdk[k].event.section.toLowerCase());
        expect(rec.event.value.variant).toBe(sdk[k].event.method);
        if (sdk[k].phase.isApplyExtrinsic) expect(rec.phase.value).toBe(BigInt(sdk[k].phase.asApplyExtrinsic.toNumber()));
      });
      // the transfer of the recorded extrinsic, as an event
      const d = polkadotDecodeExtrinsic(Buffer.from(t.hex.slice(2), 'hex'));
      const outcome = mine.find((rec) => rec.event.variant === 'System' && /^Extrinsic(Success|Failed)$/.test(rec.event.value.variant) && rec.phase.value === BigInt(t.index));
      outcomes.push(outcome.event.value.variant);
      const ev = mine.find((rec) => rec.event.variant === 'Balances' && rec.event.value.variant === 'Transfer' && rec.phase.value === BigInt(t.index));
      if (outcome.event.value.variant === 'ExtrinsicFailed') { expect(ev).toBeUndefined(); continue; }       // a real transfer that the chain rejected
      expect(hex(ev.event.value.value.to)).toBe(hex(d.dest));
      expect(ev.event.value.value.amount).toBe(d.value);
    }
    expect(outcomes).toContain('ExtrinsicSuccess');
  });

  it('refuses a runtime whose metadata differs from the reviewed pins in any way the encoder relies on', () => {
    const changes: [string, (m: Metadata) => void, RegExp][] = [
      ['an extension added', (m) => m.extrinsic.extensions.push({ id: 'CheckSomethingNew', type: m.extrinsic.extensions[0]!.type, implicit: m.extrinsic.extensions[0]!.implicit }), /extensions differ at position 13/],
      ['an extension removed', (m) => m.extrinsic.extensions.splice(9, 1), /extensions differ at position 9/],
      ['two extensions swapped', (m) => { const e = m.extrinsic.extensions; [e[5], e[6]] = [e[6]!, e[5]!]; }, /extensions differ at position 5/],
      ['an extension gaining explicit data', (m) => { m.extrinsic.extensions[7]!.type = m.extrinsic.extensions[6]!.type; }, /extensions differ at position 7/],
      ['an implicit field changing type', (m) => { m.extrinsic.extensions[2]!.implicit = m.extrinsic.extensions[4]!.implicit; }, /extensions differ at position 2/],
      ['extrinsic version 5', (m) => { m.extrinsic.version = 5; }, /extrinsic version 5/],
      ['Balances moved', (m) => { palletOf(m, 'Balances').index = 11; }, /pallet Balances has index 11/],
      ['transfer_keep_alive renumbered', (m) => { variantsOf(m, palletOf(m, 'Balances').calls).find((v) => v.name === 'transfer_keep_alive')!.index = 7; }, /transfer_keep_alive is index 7/],
      ['transfer_keep_alive renamed', (m) => { variantsOf(m, palletOf(m, 'Balances').calls).find((v) => v.name === 'transfer_keep_alive')!.name = 'transfer_preserve'; }, /transfer_keep_alive is missing/],
      ['transfer_keep_alive arguments swapped', (m) => { variantsOf(m, palletOf(m, 'Balances').calls).find((v) => v.name === 'transfer_keep_alive')!.fields.reverse(); }, /transfer_keep_alive is index 3 \(value:Compact<u128>,dest:MultiAddress\)/],
      ['System.Account hashed differently', (m) => { palletOf(m, 'System').storage.find((s) => s.name === 'Account')!.hashers = [5]; }, /System\.Account layout changed/],
      ['existential deposit constant missing', (m) => { palletOf(m, 'Balances').constants = []; }, /ExistentialDeposit changed/],
      ['SS58 prefix changed', (m) => { palletOf(m, 'System').constants.find((c) => c.name === 'SS58Prefix')!.value = Uint8Array.of(2, 0); }, /SS58 prefix changed/],
    ];
    for (const [name, mutate, re] of changes) { const m = clone(); mutate(m); expect(() => checkPolkadotMetadata(m), name).toThrow(re); }
    expect(() => parseMetadata(Uint8Array.from([...META_BYTES.subarray(0, 4), 15, ...META_BYTES.subarray(5)]))).toThrow(/unsupported version/);
    expect(() => parseMetadata(META_BYTES.subarray(0, META_BYTES.length - 1))).toThrow();
  });
});

describe('polkadot adapter: health, balances', () => {
  it('is ok only when both sources are up, on Asset Hub, and finalizing', async () => {
    world();
    expect(await make().health()).toMatchObject({ ok: true, readable: true, identityVerified: true, height: FIN });
    world((w) => { w.perUrl[B] = { chain_getFinalizedHead: 'down' }; });
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    world((w) => { w.perUrl[B] = { chain_getBlockHash: () => '0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3' }; }); // the relay chain
    expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    world((w) => { w.over.state_getStorage = () => '0x' + hex(le(BigInt(Date.now() - 3_600_000), 8)); }); // finality stalled for an hour
    expect(await make().health()).toMatchObject({ ok: false, readable: false });
  });
  it('reads the free balance; an account that does not exist reads as 0', async () => {
    world();
    expect(await make().balances(FROM)).toEqual({ native: 100_000_000_000n });
    expect(await make().balances(NEW)).toEqual({ native: 0n });
    await expect(make().balances('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY')).rejects.toThrow(/address/);
  });
});

describe('polkadot adapter: prepare', () => {
  const intentOf = (p: { section: Record<string, unknown>; maxFee: bigint }, d = req): Intent => ({ v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: 1, expiresAt: 91, policyVersion: 4,
    network: 'polkadot', chainRef: n.chainRef, asset: 'native', symbol: 'DOT', decimals: 10, amount: d.amount.toString(), from: d.from, to: d.to, maxFee: p.maxFee.toString(), x: p.section.x as Record<string, string> });

  it('builds on a finalized block known to both sources, quotes the fee on the exact bytes and dry-runs the exact call', async () => {
    const w = world();
    const p = await make().prepare(req);
    expect(p.section.x).toEqual({ spec_version: '2005002', tx_version: '15', nonce: '7', era_block: String(FIN), era_hash: hashOf(FIN), era_period: '256' });
    expect(p).toMatchObject({ feeEstimate: BigInt(QUOTE), maxFee: 2n * BigInt(QUOTE), warnings: [], ttlSec: 90 });
    const b = buildPolkadotTx(intentOf(p), n);
    const quoted = w.calls.filter((c) => c.method === 'payment_queryInfo');
    expect(quoted.map((c) => c.url).sort()).toEqual([A, B].sort());
    for (const q of quoted) {
      expect(q.params[1]).toBe(hashOf(FIN));
      const xt = registry.createType('Extrinsic', Buffer.from(polkadotExtrinsic(b, polkadotAccountId(FROM), new Uint8Array(64).fill(9))));
      expect(q.params[0].length).toBe(xt.toHex().length);                                  // same length as what will be signed
      expect(hex(polkadotDecodeExtrinsic(Buffer.from(q.params[0].slice(2), 'hex')).call)).toBe(hex(b.call));
    }
    const dry = w.calls.filter((c) => c.method === 'state_call');
    expect(dry.length).toBe(2);
    // OriginCaller::system(RawOrigin::Signed(account)) ‖ call ‖ XCM version
    expect(dry[0]!.params).toEqual(['DryRunApi_dry_run_call', '0x0001' + hex(polkadotAccountId(FROM)) + hex(b.call) + '05000000', hashOf(FIN)]);
    expect(registry.createType('Call', b.call).method).toBe('transferKeepAlive');
    // every state read names the reference block
    for (const c of w.calls.filter((x) => x.method === 'state_getStorage')) expect(c.params[1]).toBe(hashOf(FIN));
  });

  it('uses the lower finalized head when the sources are a few blocks apart, and refuses when they are not on the same chain', async () => {
    world((w) => { w.fin[B] = FIN - 4; });
    expect((await make().prepare(req)).section.x).toMatchObject({ era_block: String(FIN - 4), era_hash: hashOf(FIN - 4) });
    world((w) => { w.fin[B] = FIN - 500; });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world((w) => { w.perUrl[B] = { chain_getBlockHash: ([b]) => (b === 0 ? GENESIS : '0x' + 'ab'.repeat(32)) }; });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
  });

  it('pauses on a runtime it was not reviewed for', async () => {
    world((w) => { w.version.transactionVersion = 16; });
    expect(await msg(make().prepare(req))).toMatch(/runtime changed \(transaction version 16, reviewed 15\); sending is paused/);
    world((w) => { w.version.specName = 'asset-hub-polkadot'; });
    expect(await code(make().prepare(req))).toBe('runtime_changed');
    world((w) => { w.version.specVersion = 2005001; });
    expect(await code(make().prepare(req))).toBe('runtime_changed');
    // a new spec version with the same transaction version: the metadata is read again and checked by name
    const renamed = Buffer.from(META_BYTES);
    const at = renamed.lastIndexOf(Buffer.from('CheckNonZeroSender')); // the extension identifier (the type of the same name comes earlier)
    renamed.write('CheckNonZeroSendeR', at);
    world((w) => { w.version.specVersion = 2006000; w.metadata = { [A]: '0x' + renamed.toString('hex'), [B]: '0x' + renamed.toString('hex') }; });
    expect(await msg(make().prepare(req))).toMatch(/runtime changed \(transaction extensions differ at position 1/);
    world((w) => { w.version.specVersion = 2006000; w.metadata[B] = '0x' + renamed.toString('hex'); });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world((w) => { w.version.specVersion = 2006000; });
    expect(await code(make().prepare(req))).toBe('ok');                                                      // same layout under a newer spec version: fine
    world((w) => { w.perUrl[B] = { state_getRuntimeVersion: () => ({ ...w.version, specVersion: 2005003 }) }; });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    const a = make();
    const w = world();
    await a.prepare(req); await a.prepare(req);
    expect(w.calls.filter((c) => c.method === 'state_getMetadata').length).toBe(2);                          // once per source, then cached for that spec version
  });

  it('applies the existential-deposit rules on both sides', async () => {
    world();
    // the sender keeps 0.01 DOT and the fee ceiling: 10 − 0.01 − 2 × quote
    const most = 100_000_000_000n - ED - 2n * BigInt(QUOTE);
    expect(await code(make().prepare({ ...req, amount: most }))).toBe('ok');
    expect(await msg(make().prepare({ ...req, amount: most + 1n }))).toMatch(/keeps 0\.01 DOT in the account \(the existential deposit: an account below it is deleted\).*the most that can be sent is 9\.9881883[0-9]* DOT/);
    expect(await code(make().prepare({ ...req, amount: 100_000_000_000n }))).toBe('insufficient_funds');
    world((w) => { w.accounts[FROM] = () => accountRaw(7, 100_000_000_000n, { frozen: 60_000_000_000n, reserved: 10_000_000_000n }); });
    expect(await msg(make().prepare({ ...req, amount: 60_000_000_000n }))).toMatch(/keeps 5 DOT in the account \(locked funds\)/);
    expect(await code(make().prepare({ ...req, amount: 40_000_000_000n }))).toBe('ok');
    world((w) => { w.accounts[FROM] = () => accountRaw(7, 105_000_000n); });
    expect(await msg(make().prepare({ ...req, amount: 1n }))).toMatch(/of which 0\.01 must stay/);
    world((w) => { w.accounts[FROM] = () => null; });
    expect(await msg(make().prepare(req))).toMatch(/holds no DOT/);
    // a destination that does not exist yet must receive at least the existential deposit
    world();
    expect(await msg(make().prepare({ ...req, to: NEW, amount: ED - 1n }))).toMatch(/does not exist yet: it must receive at least 0\.01 DOT/);
    expect(await make().prepare({ ...req, to: NEW, amount: ED })).toMatchObject({ warnings: ['dt_new_account'] });
    expect(await make().prepare({ ...req, amount: 1n })).toMatchObject({ warnings: [] });                    // an existing account can receive any amount
  });

  it('refuses while a previous transaction of the account is not finalized', async () => {
    world((w) => { w.nextIndex[FROM] = 8; });
    expect(await code(make().prepare(req))).toBe('pending_tx');
    world((w) => { w.perUrl[B] = { system_accountNextIndex: () => 8 }; });
    expect(await code(make().prepare(req))).toBe('pending_tx');
  });

  it('refuses when the sources are down or disagree on anything that feeds the signature', async () => {
    for (const method of ['chain_getFinalizedHead', 'state_getRuntimeVersion', 'state_getStorage', 'system_accountNextIndex', 'payment_queryInfo', 'state_call']) {
      world((w) => { w.perUrl[B] = { [method]: 'down' }; });
      expect(await code(make().prepare(req)), method).toBe('rpc_degraded');
    }
    world((w) => { w.perUrl[B] = { state_getStorage: ([key]) => (key === keyOf(FROM) ? accountRaw(8, 100_000_000_000n) : accountRaw(0, 5_000_000_000n)) }; });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world((w) => { w.quote[B] = '9058356'; });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world((w) => { w.perUrl[A] = { chain_getBlockHash: ([b]) => (b === 0 ? '0x' + '00'.repeat(32) : hashOf(b)) }; });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');                                           // not Asset Hub
    world((w) => { w.quote = { [A]: '300000000', [B]: '300000000' }; });
    expect(await code(make().prepare(req))).toBe('fee_too_high');
  });

  it('refuses what the chain would reject in the dry run, with the chain\'s own reason', async () => {
    const err = variantsOf(meta, typeByPath(meta, 'sp_runtime', 'DispatchError')), token = err.find((v) => v.name === 'Token')!;
    const below = variantsOf(meta, token.fields[0]!.type).find((v) => v.name === 'BelowMinimum')!;
    // Ok(effects { execution_result: Err { post_info { actual_weight: Some(…), pays_fee }, error: Token(BelowMinimum) } })
    const failing = '0x' + hex(Uint8Array.from([0, 1, 1, ...scaleCompact(1000n), ...scaleCompact(2000n), 0, token.index, below.index, 0, 0]));
    world((w) => { w.dry = { [A]: failing, [B]: failing }; });
    expect(await msg(make().prepare(req))).toBe('simulation failed: Token.BelowMinimum');
    world((w) => { w.dry[B] = failing; });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world((w) => { w.dry = { [A]: '0x0100', [B]: '0x0100' }; });
    expect(await msg(make().prepare(req))).toMatch(/could not run the simulation/);
    const w = world((x) => { x.version.apis = []; });                                                        // a runtime without the dry-run API: skipped
    expect(await code(make().prepare(req))).toBe('ok');
    expect(w.calls.some((c) => c.method === 'state_call')).toBe(false);
  });

  it('refuses bad requests', async () => {
    world();
    expect(await code(make().prepare({ ...req, asset: '1984' }))).toBe('unsupported_asset');
    expect(await code(make().prepare({ ...req, amount: 0n }))).toBe('bad_amount');
    expect(await code(make().prepare({ ...req, memo: 'hi' }))).toBe('bad_memo');
    expect(await code(make().prepare({ ...req, to: FROM }))).toBe('bad_address');
    expect(await code(make().prepare({ ...req, to: 'G9xV2EatmrjRC1FLPexc3ddqNRRzCsAdURU8RFiAAJX6ppY' }))).toBe('bad_address');
  });
});

describe('polkadot adapter: broadcast, tracking, deposits (real recorded blocks)', () => {
  // a real transfer and the real events of its block
  const outcomeOf = (t: { events?: string; index: number }) => (t.events ? (registry.createType('Vec<EventRecord>', t.events) as any).find((r: any) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === t.index && r.event.section === 'system')?.event.method : undefined);
  const real = fx.transfers.find((t) => outcomeOf(t) === 'ExtrinsicSuccess')!, realFailed = fx.transfers.find((t) => outcomeOf(t) === 'ExtrinsicFailed');
  const d = polkadotDecodeExtrinsic(Buffer.from(real.hex.slice(2), 'hex'));
  const SENDER = ss58Encode(0, d.signer), RECIPIENT = ss58Encode(0, d.dest), TXID = polkadotTxid(Buffer.from(real.hex.slice(2), 'hex')), NONCE = Number(d.nonce);
  // the block as recorded: every real transfer of that block at its own index, placeholders elsewhere
  const sameBlock = fx.transfers.filter((t) => t.block === real.block);
  const xts = (): string[] => { const list = Array.from({ length: Math.max(...sameBlock.map((t) => t.index)) + 2 }, () => '0x280403000b'); for (const t of sameBlock) list[t.index] = t.hex; return list; };
  const chain = (w: World, head = real.block + 60) => {
    w.fin = { [A]: head, [B]: head }; w.best = head + 20;
    w.blocks[real.block] = { extrinsics: xts(), events: real.events! };
    w.accounts[SENDER] = (b) => accountRaw(b >= real.block ? NONCE + 1 : NONCE, 50_000_000_000n);
    w.accounts[RECIPIENT] = (b) => accountRaw(3, b >= real.block ? 20_000_000_000n + d.value : 20_000_000_000n);
  };
  const tracked = (over: Record<string, string> = {}) => ({ txid: TXID, intent: { from: SENDER, x: { nonce: String(NONCE), era_block: String(real.block - 30), era_period: '256', ...over } }, blockRef: null, broadcastAt: 0 });

  it('broadcasts to both sources; "already imported" is success, a refusal is fine only when the extrinsic is in a block', async () => {
    let w = world();
    await make().broadcast(real.hex);
    expect(w.submitted).toEqual([real.hex, real.hex]);
    w = world((x) => { x.over.author_submitExtrinsic = () => { throw new RpcErr(1013, 'Transaction Already Imported'); }; });
    await make().broadcast(real.hex);
    w = world((x) => { x.perUrl[A] = { author_submitExtrinsic: () => { throw new RpcErr(1010, 'Invalid Transaction'); } }; });
    await make().broadcast(real.hex);                                                                        // one source is enough
    w = world((x) => { x.over.author_submitExtrinsic = () => { throw new RpcErr(1010, 'Invalid Transaction: Transaction is outdated'); }; });
    await expect(make().broadcast(real.hex)).rejects.toThrow(/outdated/);
    w = world((x) => { chain(x, real.block + 5); x.over.author_submitExtrinsic = () => { throw new RpcErr(1010, 'Invalid Transaction: Transaction is outdated'); }; });
    await make().broadcast(real.hex);                                                                        // outdated because it is already on chain
    await expect(make().broadcast('0x00')).rejects.toThrow(/not a Polkadot signed extrinsic/);
    void w;
  });

  it('finds a finalized transfer by the account nonce and reads its outcome from the events', async () => {
    const w = world(chain);
    expect(await make().track(tracked())).toEqual({ state: 'finalized', confirmations: 1, blockRef: String(real.block) });
    expect(w.calls.filter((c) => c.method === 'chain_getBlock').length).toBe(1);                              // bisection over state, one block read
    expect(w.calls.filter((c) => c.method === 'state_getStorage').length).toBeLessThan(16);
    // the nonce was used by another extrinsic (this id is not in that block), confirmed by both sources
    world(chain);
    expect(await make().track({ ...tracked(), txid: '0x' + 'ab'.repeat(32) })).toMatchObject({ state: 'replaced' });
    world((x) => { chain(x); x.perUrl[B] = { chain_getBlock: 'down' }; });
    expect(await make().track({ ...tracked(), txid: '0x' + 'ab'.repeat(32) })).toEqual({ state: 'broadcast', confirmations: 0 }); // one source cannot confirm: no verdict
  });

  it('reports a transfer the chain rejected, with its reason', async () => {
    if (realFailed) { // a REAL transfer that failed on mainnet (the sender's funds were frozen), with the real events of its block
      const f = polkadotDecodeExtrinsic(Buffer.from(realFailed.hex.slice(2), 'hex')), who = ss58Encode(0, f.signer);
      world((x) => {
        x.fin = { [A]: realFailed.block + 60, [B]: realFailed.block + 60 };
        x.blocks[realFailed.block] = { extrinsics: Array.from({ length: realFailed.index + 1 }, (_, k) => (k === realFailed.index ? realFailed.hex : '0x280403000b')), events: realFailed.events! };
        x.accounts[who] = (b) => accountRaw(b >= realFailed.block ? Number(f.nonce) + 1 : Number(f.nonce), 50_000_000_000n);
      });
      const r = await make().track({ txid: polkadotTxid(Buffer.from(realFailed.hex.slice(2), 'hex')), intent: { from: who, x: { nonce: f.nonce.toString(), era_block: String(realFailed.block - 20), era_period: '64' } }, blockRef: null, broadcastAt: 0 });
      expect(r).toMatchObject({ state: 'failed', blockRef: String(realFailed.block), error: expect.stringMatching(/^rejected by the chain \(Token\.\w+\)/) });
    }
    const err = variantsOf(meta, typeByPath(meta, 'sp_runtime', 'DispatchError')), token = err.find((v) => v.name === 'Token')!;
    const funds = variantsOf(meta, token.fields[0]!.type).find((v) => v.name === 'FundsUnavailable')!;
    const sysEvents = variantsOf(meta, palletOf(meta, 'System').events), failedIx = sysEvents.find((v) => v.name === 'ExtrinsicFailed')!.index;
    // one EventRecord: phase ApplyExtrinsic(index), System.ExtrinsicFailed { dispatch_error: Token(FundsUnavailable), dispatch_info { weight, class, pays_fee } }, no topics
    const rec = Uint8Array.from([...scaleCompact(1n), 0, ...le(BigInt(real.index), 4), palletOf(meta, 'System').index, failedIx, token.index, funds.index, ...scaleCompact(1000n), ...scaleCompact(2000n), 0, 0, 0]);
    const sdk = registry.createType('Vec<EventRecord>', rec) as any;
    expect([sdk[0].event.section, sdk[0].event.method]).toEqual(['system', 'ExtrinsicFailed']);              // the hand-made record is what @polkadot/types reads
    world((x) => { chain(x); x.blocks[real.block]!.events = '0x' + hex(rec); });
    expect(await make().track(tracked())).toEqual({ state: 'failed', confirmations: 0, blockRef: String(real.block), error: 'rejected by the chain (Token.FundsUnavailable): the transfer was not made (only the network fee was charged)' });
  });

  it('declares expiry only when the mortal era has ended on the finalized chain of every source', async () => {
    const idle = (head: number) => (x: World) => { x.fin = { [A]: head, [B]: head }; x.best = head + 20; x.accounts[SENDER] = () => accountRaw(NONCE, 50_000_000_000n); };
    world(idle(real.block + 100));
    expect(await make().track(tracked())).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true });
    world(idle(real.block - 30 + 257));
    expect(await make().track(tracked())).toEqual({ state: 'failed', confirmations: 0, error: 'expired before inclusion (mortal era ended); no funds moved' });
    world((x) => { idle(real.block - 30 + 257)(x); x.fin[B] = real.block - 30 + 250; });
    expect(await make().track(tracked())).toMatchObject({ state: 'broadcast' });                             // the other source has not finalized past the era yet
    // included in a block that is not finalized yet
    world((x) => { chain(x, real.block - 5); x.best = real.block + 3; });
    expect(await make().track(tracked())).toEqual({ state: 'confirming', confirmations: 0, blockRef: 'best:' + real.block });
    world(idle(real.block + 100));
    expect(await make().track({ ...tracked(), blockRef: 'best:1' })).toMatchObject({ state: 'reorged', rebroadcast: true });
  });

  it('falls back to reading every block of the era when the account no longer exists (its nonce says nothing)', async () => {
    const w = world((x) => { chain(x); x.accounts[SENDER] = (b) => (b >= real.block ? null : accountRaw(NONCE, 50_000_000_000n)); });
    expect(await make().track(tracked())).toEqual({ state: 'finalized', confirmations: 1, blockRef: String(real.block) });
    expect(w.calls.filter((c) => c.method === 'chain_getBlock').length).toBe(30);                             // era start + 1 … the block that holds it
    world((x) => { chain(x, real.block - 30 + 300); x.blocks = {}; x.accounts[SENDER] = () => null; });
    expect(await make().track(tracked())).toMatchObject({ state: 'failed', error: expect.stringMatching(/expired/) }); // all 256 blocks read, not there
  });

  it('finds deposits by comparing the account between two finalized blocks and decoding only the blocks where it changed', async () => {
    let w = world(chain);
    const a = make();
    expect(await a.deposits(RECIPIENT, null)).toEqual({ items: [], cursor: real.block + 60, finalizedHeight: real.block + 60 }); // first pass: from the head on
    const r = await a.deposits(RECIPIENT, real.block - 3000);
    expect(r.items[0]).toEqual({ txid: TXID, idx: expect.any(Number), asset: 'native', amount: d.value, from: SENDER, block: real.block, time: expect.any(Number) });
    // the same real block may pay the same recipient again (an exchange deposit address): each such event maps to its own extrinsic
    for (const i of r.items) { const t = sameBlock.find((x) => polkadotTxid(Buffer.from(x.hex.slice(2), 'hex')) === i.txid)!, dd = polkadotDecodeExtrinsic(Buffer.from(t.hex.slice(2), 'hex')); expect([ss58Encode(0, dd.dest), dd.value, ss58Encode(0, dd.signer)]).toEqual([RECIPIENT, i.amount, i.from]); }
    expect(r.cursor).toBe(real.block + 60);
    expect(w.calls.filter((c) => c.method === 'state_getStorage' && c.params[0] === EVENTS).length).toBe(1);   // one block decoded out of 3060
    w = world(chain);
    expect(await make().deposits(RECIPIENT, real.block + 1)).toMatchObject({ items: [], cursor: real.block + 60 }); // nothing changed since: no block read
    expect(w.calls.some((c) => c.method === 'chain_getBlock' || c.params[0] === EVENTS)).toBe(false);
    world(chain);
    expect((await make().deposits(SENDER, real.block - 10)).items).toEqual([]);                               // the sender's own transfer is not a deposit
    world((x) => { chain(x); x.version.transactionVersion = 16; });
    expect(await make().deposits(RECIPIENT, real.block - 10)).toMatchObject({ items: [], cursor: real.block - 10 }); // unreviewed runtime: events are not decoded, the cursor waits
    world((x) => { chain(x, real.block + 100_000); });
    expect(await make().deposits(RECIPIENT, real.block - 10)).toMatchObject({ cursor: real.block - 10 + 43_200 }); // long gaps are caught up in bounded passes
  });
});
