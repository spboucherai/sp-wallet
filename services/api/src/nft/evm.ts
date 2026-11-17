// EVM NFT provider (read-only): ERC-721 and ERC-1155 on the EVM networks of the registry.
//
// ON-CHAIN TRUTH: `ownerOf` / `balanceOf` / `tokenURI` / `uri` / ERC-165 read with eth_call on EVERY endpoint of the network; an
// answer on which the endpoints agree is `chain_verified`. ERC-165 is read "with caution": a contract that DECLARES ERC-721 is
// treated as one only if `ownerOf` answers; a contract that answers `ownerOf` without declaring the interface is `evm-nonstandard`;
// declaring an interface proves nothing about legitimacy and no badge is derived from it.
//
// DISCOVERY of what an address holds is not possible from the wallet's public endpoints (measured 2026-11-17,
// scripts/nft-measure-evm-logs.mts: wallet-wide `eth_getLogs` without a contract address is refused or capped to a few blocks).
// So: (a) when NFT_EVM_INDEXER_URLS names a Blockscout-compatible instance for the network, its list is used as a HINT and each
// item is re-read on-chain before it enters the inventory; (b) otherwise the section is `blocked_by_provider` and the owner adds
// an NFT by contract + token id (manual list), verified on-chain the same way.
//
// Outbound requests carrying the wallet's EVM address: eth_call balanceOf(wallet, id) to the network's RPC endpoints (already
// receiving it for balances); GET /api/v2/addresses/<wallet>/nft to the configured indexer host, when one is configured.
import { getNetwork, NETWORKS, type NetworkDef } from '@spw/core';
import { NftProviderError, NONE, UNSUPPORTED, evmAssetId, known, nftKey, parseTokenId, plainText, unknown, type Confidence, type DataSourceStamp, type NftAsset, type NftEvent, type NftOwnershipRecord, type NftStandard } from '@spw/nft';
import { decodeAbiParameters, encodeFunctionData, getAddress, keccak256, pad, parseAbi, toHex, type Hex } from 'viem';
import { hostOnly } from './config.ts';
import { buildAsset, emptyMetadata, rpcCodeOf, type CollectionInfo, type EventPage, type InventoryResult, type InventorySection, type NftDataProvider, type RpcFn } from './provider.ts';

const FAMILY = 'evm';
const ABI = parseAbi(['function supportsInterface(bytes4) view returns (bool)', 'function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)',
  'function balanceOf(address,uint256) view returns (uint256)', 'function uri(uint256) view returns (string)', 'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply(uint256) view returns (uint256)']);
const IF_721 = '0x80ac58cd', IF_1155 = '0xd9b67a26';
export const TOPIC_TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
export const TOPIC_SINGLE = keccak256(toHex('TransferSingle(address,address,address,uint256,uint256)'));
export const TOPIC_BATCH = keccak256(toHex('TransferBatch(address,address,address,uint256[],uint256[])'));
const ZERO = '0x0000000000000000000000000000000000000000';

export interface EvmDeps { rpc: RpcFn; now: () => Date; indexers: Record<string, string>; http: (url: string, init?: RequestInit) => Promise<Response> }
type CallResult = { ok: true; data: Hex; stamp: (covers: DataSourceStamp['covers']) => DataSourceStamp } | { ok: false; reverted: true };

export function evmProvider(deps: EvmDeps): NftDataProvider {
  const nets = () => (Object.values(NETWORKS) as NetworkDef[]).filter((n) => n.family === FAMILY);
  const netOf = (chain: string): NetworkDef => { const n = getNetwork(chain); if (n.family !== FAMILY) throw new NftProviderError('unsupported_chain', 'evm-rpc'); return n; };
  const iso = () => deps.now().toISOString();
  const isRevert = (e: unknown): boolean => { const c = rpcCodeOf(e), m = String((e as Error).message ?? ''); return c !== undefined && (c === 3 || /revert|invalid opcode|out of gas|execution error|invalid jump|stack (under|over)flow|evm error|vm exception/i.test(m)); };

  /** One read on every endpoint. Agreement of two or more → chain_verified. A revert is an answer ("the contract refuses this call"). */
  async function read(n: NetworkDef, method: string, params: unknown[]): Promise<CallResult> {
    const rs = await Promise.allSettled(n.rpc.map(async (u) => ({ host: hostOnly(u), r: (await deps.rpc(u, method, params)) as Hex })));
    const ok = rs.flatMap((r) => (r.status === 'fulfilled' && typeof r.value.r === 'string' ? [r.value] : []));
    if (!ok.length) {
      const errs = rs.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
      if (errs.some(isRevert)) return { ok: false, reverted: true };
      const m = String((errs[0] as Error | undefined)?.message ?? '');
      throw new NftProviderError(/429|rate|limit/i.test(m) ? 'provider_rate_limited' : 'provider_unavailable', 'evm-rpc', method);
    }
    const same = ok.every((x) => x.r.toLowerCase() === ok[0]!.r.toLowerCase());
    if (!same) throw new NftProviderError('provider_disagreement', 'evm-rpc', method);
    const confidence: Confidence = ok.length > 1 ? 'chain_verified' : 'chain_single_source', hosts = ok.map((x) => x.host).join(', ');
    return { ok: true, data: ok[0]!.r, stamp: (covers) => ({ category: 'onchain', source: 'evm-rpc', detail: hosts, fetchedAt: iso(), blockRef: { commitment: 'latest' }, confidence, freshness: 'fresh', covers }) };
  }
  const call = (n: NetworkDef, to: string, data: Hex) => read(n, 'eth_call', [{ to, data }, 'latest']);
  const fn = (name: string, args: unknown[]): Hex => encodeFunctionData({ abi: ABI, functionName: name as 'ownerOf', args: args as [bigint] });
  const asBool = (r: CallResult): boolean | null => (r.ok && /^0x0{63}[01]$/.test(r.data) ? r.data.endsWith('1') : null);
  const asAddress = (r: CallResult): string | null => (r.ok && /^0x0{24}[0-9a-fA-F]{40}$/.test(r.data) ? getAddress(`0x${r.data.slice(26)}`) : null);
  const asUint = (r: CallResult): bigint | null => (r.ok && /^0x[0-9a-fA-F]{64}$/.test(r.data) ? BigInt(r.data) : null);
  const asString = (r: CallResult): string | null => { if (!r.ok || r.data.length < 130 || r.data.length > 2 + 2 * 600_000) return null; try { return decodeAbiParameters([{ type: 'string' }], r.data)[0]; } catch { return null; } };

  async function lookupOne(chain: string, contractRaw: string, tokenIdRaw: string | undefined, wallet: string | null, origin: NftAsset['origin']): Promise<NftAsset> {
    const n = netOf(chain);
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractRaw)) throw new NftProviderError('bad_identifier', 'evm-rpc', 'not a contract address');
    if (tokenIdRaw === undefined || tokenIdRaw === '') throw new NftProviderError('bad_identifier', 'evm-rpc', 'token_id_required');
    let id: bigint; try { id = parseTokenId(tokenIdRaw); } catch { throw new NftProviderError('bad_identifier', 'evm-rpc', 'bad token id'); }
    const contract = getAddress(contractRaw), assetId = evmAssetId(contract, id), key = nftKey(FAMILY, chain, assetId);
    const code = await read(n, 'eth_getCode', [contract, 'latest']);
    if (!code.ok || code.data === '0x') throw new NftProviderError('not_found', 'evm-rpc', 'no_contract');
    const [s721, s1155] = await Promise.all([call(n, contract, fn('supportsInterface', [IF_721])), call(n, contract, fn('supportsInterface', [IF_1155]))]);
    const declares721 = asBool(s721) === true, declares1155 = asBool(s1155) === true;
    const [nameR, symR] = await Promise.all([call(n, contract, fn('name', [])), call(n, contract, fn('symbol', []))]);
    const collStamp = code.stamp(['collection', 'identity']);
    const collection = { key: nftKey(FAMILY, chain, contract.toLowerCase()), id: contract, verifiedOnChain: UNSUPPORTED, name: plainText(asString(nameR), 200), source: collStamp };
    const explorerUrl = n.explorerAddr + contract;
    const common = { family: FAMILY, chainId: chain, assetId, key, tokenId: id.toString(10), contractAddress: contract, collection, fetchedAt: iso(), origin, explorerUrl, tokenProgram: null, creators: UNSUPPORTED, updateAuthority: UNSUPPORTED, royaltyBps: unknown('not read (ERC-2981 is a market matter)') } as const;

    if (declares1155 && !declares721) {
      const [bal, uri, sup] = await Promise.all([wallet ? call(n, contract, fn('balanceOf', [wallet, id])) : Promise.resolve<CallResult>({ ok: false, reverted: true }), call(n, contract, fn('uri', [id])), call(n, contract, fn('totalSupply', [id]))]);
      const q = wallet ? asUint(bal) : null, stamp = (bal.ok ? bal : code).stamp(['ownership', 'identity', 'state']);
      const ownership: NftOwnershipRecord = { state: q === null ? 'unknown' : q > 0n ? 'in_wallet' : 'not_in_wallet', owner: UNSUPPORTED, tokenAccount: UNSUPPORTED, frozen: UNSUPPORTED, delegate: UNSUPPORTED, tokenRecordState: UNSUPPORTED, heldByWallet: q !== null && q > 0n, source: stamp };
      return buildAsset({ ...common, standard: 'erc1155', ownerAddress: q !== null && q > 0n ? wallet : null, quantity: (q ?? 0n).toString(10), supply: asUint(sup) !== null ? known(asUint(sup)!.toString(10)) : unknown('the contract has no totalSupply(id)'),
        metadata: emptyMetadata(asString(uri)?.trim() || null, { onchainName: null, onchainSymbol: plainText(asString(symR), 40), mutable: unknown('an ERC-1155 URI can be changed by the contract') }), ownership, sources: [stamp, collStamp] });
    }
    const ownerR = await call(n, contract, fn('ownerOf', [id])), owner = asAddress(ownerR);
    if (!owner) {
      if (declares721) throw new NftProviderError('not_found', 'evm-rpc', 'owner_query_reverted'); // never minted, or burned: ERC-721 does not tell them apart
      throw new NftProviderError('unsupported_standard', 'evm-rpc', 'not_erc721_or_erc1155');
    }
    const uriR = await call(n, contract, fn('tokenURI', [id]));
    const standard: NftStandard = declares721 ? 'erc721' : 'evm-nonstandard';
    const stamp = (ownerR as Extract<CallResult, { ok: true }>).stamp(['ownership', 'identity', 'state']);
    const burned = owner === ZERO, held = !!wallet && !burned && owner.toLowerCase() === wallet.toLowerCase();
    const ownership: NftOwnershipRecord = { state: burned ? 'burned' : held ? 'in_wallet' : 'not_in_wallet', owner: burned ? NONE : known(owner), tokenAccount: UNSUPPORTED, frozen: UNSUPPORTED, delegate: unknown('approvals are not read in this version'), tokenRecordState: UNSUPPORTED, heldByWallet: held, source: stamp };
    return buildAsset({ ...common, standard, ownerAddress: held ? wallet : null, quantity: burned ? '0' : held || !wallet ? '1' : '0', supply: known(burned ? '0' : '1'),
      metadata: emptyMetadata(asString(uriR)?.trim() || null, { onchainSymbol: plainText(asString(symR), 40), mutable: unknown('a tokenURI can be changed by the contract') }), ownership, sources: [stamp, collStamp] });
  }

  const section = (s: string, o: Partial<InventorySection> = {}): InventorySection => ({ section: s, status: 'ok', code: null, unlockedBy: null, source: null, count: 0, truncated: false, ...o });

  return {
    id: 'evm', family: FAMILY, chains: () => nets().map((n) => n.id),

    async inventory(chain, owner, o): Promise<InventoryResult> {
      netOf(chain);
      const assets: NftAsset[] = [], sections: InventorySection[] = [], base = deps.indexers[chain];
      if (!base) sections.push(section('indexer', { status: 'blocked_by_provider', code: 'no_indexer_configured', unlockedBy: 'NFT_EVM_INDEXER_URLS' }));
      else {
        try {
          const hints: { contract: string; id: string }[] = []; let next: Record<string, unknown> | null = null, truncated = false;
          for (let page = 0; page < 4; page++) {
            const q = new URLSearchParams({ type: 'ERC-721,ERC-1155', ...(next ? Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) : {}) });
            const r = await deps.http(`${base}/api/v2/addresses/${owner}/nft?${q}`, { headers: { accept: 'application/json', 'user-agent': 'sp-wallet-nft/1' }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
            if (r.status === 429) throw new NftProviderError('provider_rate_limited', 'evm-indexer');
            if (!r.ok) throw new NftProviderError('provider_unavailable', 'evm-indexer', `http ${r.status}`);
            const j = (await r.json()) as { items?: { id?: unknown; token?: { address_hash?: unknown; address?: unknown } }[]; next_page_params?: Record<string, unknown> | null };
            if (!Array.isArray(j.items)) throw new NftProviderError('provider_bad_answer', 'evm-indexer');
            for (const it of j.items) { const c = String(it.token?.address_hash ?? it.token?.address ?? ''), id = String(it.id ?? ''); if (/^0x[0-9a-fA-F]{40}$/.test(c) && /^[0-9]{1,78}$/.test(id)) hints.push({ contract: c, id }); }
            next = j.next_page_params ?? null;
            if (!next || hints.length >= o.max) { truncated = !!next; break; }
            truncated = page === 3;
          }
          let n = 0, unverified = 0;
          for (const h of hints.slice(0, o.max)) {
            // the indexer's list is a hint: only what the chain confirms as held enters the inventory
            try { const a = await lookupOne(chain, h.contract, h.id, owner, 'discovered'); if (a.ownership.heldByWallet) { a.sources.push({ category: 'indexed', source: 'evm-indexer', detail: hostOnly(base), fetchedAt: iso(), confidence: 'indexer_reported', freshness: 'unknown', covers: ['identity'] }); assets.push(a); n++; } else unverified++; }
            catch { unverified++; }
          }
          sections.push(section('indexer', { source: `evm-indexer (${hostOnly(base)})`, count: n, truncated: truncated || hints.length > o.max, code: unverified ? `not_confirmed_on_chain:${unverified}` : null }));
        } catch (e) { sections.push(section('indexer', { status: 'error', code: e instanceof NftProviderError ? e.code : 'provider_unavailable', source: `evm-indexer (${hostOnly(base)})` })); }
      }
      let m = 0;
      for (const id of o.manual) {
        if (assets.some((a) => a.assetId === id)) continue;
        const [c, t] = id.split('/');
        try { assets.push(await lookupOne(chain, c!, t, owner, 'manual')); m++; } catch { /* stays in the manual list; the service reports it as not verifiable now */ }
      }
      sections.push(section('manual', { source: 'evm-rpc', count: m }));
      return { assets, sections };
    },

    lookup: (chain, ref, wallet) => lookupOne(chain, ref.address.trim(), ref.tokenId?.trim(), wallet, 'lookup'),

    /** Transfers of this token in the most recent blocks the public endpoints accept (they keep no searchable history without a key). */
    async events(asset, _cursor): Promise<EventPage> {
      const n = netOf(asset.chainId), contract = asset.contractAddress!, id = BigInt(asset.tokenId!);
      const headR = await read(n, 'eth_blockNumber', []).catch(() => null);
      if (!headR || !headR.ok) return { events: [], cursor: null, completeness: 'unavailable', note: 'head_unavailable' };
      const head = BigInt(headR.data);
      const filterOf = (span: bigint) => ({ address: contract, fromBlock: toHex(head > span ? head - span : 0n), toBlock: 'latest',
        topics: asset.standard === 'erc1155' ? [[TOPIC_SINGLE, TOPIC_BATCH]] : [TOPIC_TRANSFER, null, null, pad(toHex(id), { size: 32 })] });
      type Log = { topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean };
      let logs: Log[] | null = null, span = 0n, host = '';
      for (const s of [1000n, 100n]) {
        for (const u of n.rpc) { try { logs = (await deps.rpc(u, 'eth_getLogs', [filterOf(s)])) as Log[]; host = hostOnly(u); span = s; break; } catch { /* next endpoint / smaller window */ } }
        if (logs) break;
      }
      if (!logs || !Array.isArray(logs)) return { events: [], cursor: null, completeness: 'unavailable', note: 'logs_refused_by_endpoints' };
      const src: DataSourceStamp = { category: 'onchain', source: 'evm-rpc', detail: host, fetchedAt: iso(), blockRef: { number: head.toString(10) }, confidence: 'chain_single_source', freshness: 'fresh', covers: ['events'] };
      const w = asset.ownerAddress?.toLowerCase() ?? null, addr = (t: Hex | undefined) => (t ? getAddress(`0x${t.slice(26)}`) : null), events: NftEvent[] = [];
      const push = (l: Log, sub: string, from: string | null, to: string | null, quantity: string) => {
        const type: NftEvent['type'] = from === ZERO ? 'mint' : to === ZERO ? 'burn' : w && to?.toLowerCase() === w ? 'transfer-in' : w && from?.toLowerCase() === w ? 'transfer-out' : 'transfer';
        events.push({ id: `${asset.key}|${l.transactionHash}|${BigInt(l.logIndex)}${sub}`, assetKey: asset.key, type, interpretation: { by: 'spw:evm-transfer-log', note: 'a Transfer log; a payment in the same transaction is not interpreted as a sale' }, tx: l.transactionHash, index: `${BigInt(l.logIndex)}${sub}`,
          blockRef: { number: BigInt(l.blockNumber).toString(10), hash: l.blockHash }, at: null, from, to, quantity, price: null, finality: l.removed ? 'reorged' : head - BigInt(l.blockNumber) >= BigInt(n.minConf) ? 'finalized' : 'confirmed', source: src });
      };
      for (const l of logs) {
        try {
          if (asset.standard !== 'erc1155') { if (l.topics.length === 4 && l.topics[0] === TOPIC_TRANSFER && BigInt(l.topics[3]!) === id) push(l, '', addr(l.topics[1]), addr(l.topics[2]), '1'); continue; }
          if (l.topics[0] === TOPIC_SINGLE) { const [tid, v] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], l.data); if (tid === id) push(l, '', addr(l.topics[2]), addr(l.topics[3]), v.toString(10)); }
          else if (l.topics[0] === TOPIC_BATCH) { const [ids, vs] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], l.data); ids.forEach((tid, k) => { if (tid === id) push(l, `.${k}`, addr(l.topics[2]), addr(l.topics[3]), (vs[k] ?? 0n).toString(10)); }); }
        } catch { /* a log that does not decode as the standard event is not an event of this token */ }
      }
      events.sort((a, b) => Number(BigInt(b.blockRef.number!) - BigInt(a.blockRef.number!)));
      return { events, cursor: null, completeness: 'recent_window', note: `last_${span}_blocks` };
    },

    async collection(chain, id): Promise<CollectionInfo> {
      const n = netOf(chain);
      if (!/^0x[0-9a-fA-F]{40}$/.test(id)) throw new NftProviderError('bad_identifier', 'evm-rpc');
      const contract = getAddress(id), code = await read(n, 'eth_getCode', [contract, 'latest']);
      if (!code.ok || code.data === '0x') throw new NftProviderError('not_found', 'evm-rpc', 'no_contract');
      const [s721, s1155, nameR] = await Promise.all([call(n, contract, fn('supportsInterface', [IF_721])), call(n, contract, fn('supportsInterface', [IF_1155])), call(n, contract, fn('name', []))]);
      return { key: nftKey(FAMILY, chain, contract.toLowerCase()), id: contract, chain, standard: asBool(s1155) ? 'erc1155' : asBool(s721) ? 'erc721' : 'unknown', onchainName: plainText(asString(nameR), 200), uri: null, size: unknown('not read'), updateAuthority: UNSUPPORTED, features: [], source: code.stamp(['collection']) };
    },
  };
}
