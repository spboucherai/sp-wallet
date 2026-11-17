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
import { blockscoutHints, type EvmHintSource } from './evm-hints.ts';
import { interpretSeaportSale, type ReceiptLog } from './market/seaport.ts';

const FAMILY = 'evm';
/** what turns EVM discovery on: a keyed provider, or a Blockscout-compatible instance per network */
export const UNLOCK_DISCOVERY = 'NFT_EVM_PROVIDER / NFT_EVM_INDEXER_URLS';
const ABI = parseAbi(['function supportsInterface(bytes4) view returns (bool)', 'function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)',
  'function balanceOf(address,uint256) view returns (uint256)', 'function uri(uint256) view returns (string)', 'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply(uint256) view returns (uint256)']);
const IF_721 = '0x80ac58cd', IF_1155 = '0xd9b67a26';
export const TOPIC_TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
export const TOPIC_SINGLE = keccak256(toHex('TransferSingle(address,address,address,uint256,uint256)'));
export const TOPIC_BATCH = keccak256(toHex('TransferBatch(address,address,address,uint256[],uint256[])'));
const ZERO = '0x0000000000000000000000000000000000000000';

export interface EvmDeps { rpc: RpcFn; now: () => Date; indexers: Record<string, string>; http: (url: string, init?: RequestInit) => Promise<Response>;
  /** delivery 3: keyed discovery hint sources (NFT_EVM_PROVIDER), asked before the Blockscout instances of `indexers`; every hint is re-verified on-chain */ hints?: EvmHintSource[] }
type CallResult = { ok: true; data: Hex; stamp: (covers: DataSourceStamp['covers']) => DataSourceStamp } | { ok: false; reverted: true };

export function evmProvider(deps: EvmDeps): NftDataProvider {
  const nets = () => (Object.values(NETWORKS) as NetworkDef[]).filter((n) => n.family === FAMILY);
  const netOf = (chain: string): NetworkDef => { const n = getNetwork(chain); if (n.family !== FAMILY) throw new NftProviderError('unsupported_chain', 'evm-rpc'); return n; };
  const iso = () => deps.now().toISOString();
  const sources: EvmHintSource[] = [...(deps.hints ?? []), blockscoutHints({ http: deps.http, instances: deps.indexers })];
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
      const assets: NftAsset[] = [], sections: InventorySection[] = [];
      const able = sources.filter((x) => x.notCovered(chain) === null);
      if (!able.length) sections.push(section('indexer', { status: 'blocked_by_provider', code: 'no_indexer_configured', unlockedBy: UNLOCK_DISCOVERY }));
      else {
        // the first source that answers is used; a source that refuses THIS network (a key whose plan does not enable it) is a
        // "blocked by provider" with its reason — never an empty inventory — and the next source, if any, is asked
        let done = false, lastFail: InventorySection | null = null;
        for (const src of able) {
          const label = `${src.id} (${src.host(chain)})`;
          try {
            const { hints, truncated } = await src.list(chain, owner, o.max);
            let n = 0, unverified = 0;
            for (const h of hints) {
              // the indexer's list is a hint: only what the chain confirms as held enters the inventory
              try { const a = await lookupOne(chain, h.contract, h.id, owner, 'discovered');
                if (a.ownership.heldByWallet) { a.sources.push({ category: 'indexed', source: src.id, detail: src.host(chain), fetchedAt: iso(), confidence: 'indexer_reported', freshness: 'unknown', covers: ['identity'] });
                  if (h.spam) a.indexerFlags = { spam: h.spam.flagged, by: src.name, classifications: h.spam.classifications };
                  assets.push(a); n++; } else unverified++; }
              catch { unverified++; }
            }
            sections.push(section('indexer', { source: label, count: n, truncated, code: unverified ? `not_confirmed_on_chain:${unverified}` : null }));
            done = true; break;
          } catch (e) {
            const pe = e instanceof NftProviderError ? e : null, detail = pe ? /\(([a-z0-9_:]{1,80})\)$/.exec(pe.message)?.[1] ?? '' : '';
            lastFail = detail.startsWith('network_not_enabled') ? section('indexer', { status: 'blocked_by_provider', code: `network_not_enabled_for_key:${detail.split(':')[1] ?? ''}`, unlockedBy: src.unlockedBy, source: label })
              : pe?.code === 'provider_not_configured' ? section('indexer', { status: 'blocked_by_provider', code: `key_refused:${detail || 'forbidden'}`, unlockedBy: src.unlockedBy, source: label })
              : section('indexer', { status: 'error', code: pe ? pe.code : 'provider_unavailable', source: label });
          }
        }
        if (!done && lastFail) sections.push(lastFail);
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
      type Log = { address?: string; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean };
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
      const decode = (l: Log): void => {
        try {
          if (asset.standard !== 'erc1155') { if (l.topics.length === 4 && l.topics[0] === TOPIC_TRANSFER && BigInt(l.topics[3]!) === id) push(l, '', addr(l.topics[1]), addr(l.topics[2]), '1'); return; }
          if (l.topics[0] === TOPIC_SINGLE) { const [tid, v] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], l.data); if (tid === id) push(l, '', addr(l.topics[2]), addr(l.topics[3]), v.toString(10)); }
          else if (l.topics[0] === TOPIC_BATCH) { const [ids, vs] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], l.data); ids.forEach((tid, k) => { if (tid === id) push(l, `.${k}`, addr(l.topics[2]), addr(l.topics[3]), (vs[k] ?? 0n).toString(10)); }); }
        } catch { /* a log that does not decode as the standard event is not an event of this token */ }
      };
      for (const l of logs) decode(l);
      // delivery 3 — history beyond the window: a keyed provider names the transactions in which this contract's tokens moved to or
      // from the wallet; each one is then READ FROM THE CHAIN (its receipt, on the wallet's own endpoints) and decoded like a log above
      let extended = false;
      const hs = asset.ownerAddress ? sources.find((x) => x.history && x.notCovered(asset.chainId) === null) : undefined;
      const receiptOf = async (tx: string): Promise<{ logs: (Log & ReceiptLog)[]; blockNumber: Hex; blockHash: Hex } | null> => { for (const u of n.rpc) { try { const r = (await deps.rpc(u, 'eth_getTransactionReceipt', [tx])) as { logs?: (Log & ReceiptLog)[]; blockNumber: Hex; blockHash: Hex } | null; if (r && Array.isArray(r.logs)) return r as never; } catch { /* next endpoint */ } } return null; };
      if (hs) { try {
        const seen = new Set(events.map((e) => e.tx));
        for (const h of (await hs.history!(asset.chainId, asset.ownerAddress!, contract)).filter((x) => !seen.has(x.tx)).sort((a, b) => Number(BigInt(b.block) - BigInt(a.block))).slice(0, 20)) {
          const r = await receiptOf(h.tx); if (!r) continue;
          const before = events.length;
          for (const l of r.logs) if (l.address?.toLowerCase() === contract.toLowerCase()) decode({ ...l, blockNumber: r.blockNumber, blockHash: r.blockHash });
          for (const e of events.slice(before)) e.source = { ...src, detail: `${host}; transaction named by ${hs.name}, read from the chain` };
        }
        extended = true;
      } catch { /* the provider failing leaves the recent window as it is */ } }
      // delivery 3 — sale interpretation, keyless: the receipt of a transfer's transaction is read, and a price is linked ONLY when it
      // holds a Seaport OrderFulfilled naming this token and one payment currency (market/seaport.ts). At most 12 receipts per call.
      if (asset.standard === 'erc721' || asset.standard === 'erc1155') {
        const txs = [...new Set(events.filter((e) => e.type === 'transfer' || e.type === 'transfer-in' || e.type === 'transfer-out').map((e) => e.tx))].slice(0, 12);
        for (const tx of txs) { try {
          const r = await receiptOf(tx); if (!r) continue;
          const sale = interpretSeaportSale(asset.chainId, r.logs, { contract, tokenId: id.toString(10), standard: asset.standard });
          if (!sale) continue;
          const t = sale.token === 'native' ? { asset: 'native', symbol: n.native.symbol, decimals: n.native.decimals } : (() => { const d = n.tokens.find((x) => x.id.toLowerCase() === sale.token.toLowerCase()); return d ? { asset: sale.token.toLowerCase(), symbol: d.symbol, decimals: d.decimals } : null; })();
          if (!t) continue; // a payment token this wallet's registry does not know: its decimals are not guessed — no price
          const base = events.find((e) => e.tx === tx)!;
          events.push({ ...base, id: `${asset.key}|${tx}|seaport:${sale.logIndex}`, index: `seaport:${sale.logIndex}`, type: 'sale', from: sale.seller, to: sale.buyer, quantity: sale.quantity,
            price: { amount: sale.amount, currency: { network: asset.chainId, ...t } },
            interpretation: { by: 'spw:seaport-order-fulfilled', note: `interpreted from the transaction by SP Wallet: Seaport ${sale.seaport.version} OrderFulfilled ${sale.orderHash} (${sale.side === 'offer' ? 'an offer was accepted' : 'a listing was filled'}); ${sale.fees.length} payment item(s) went to other recipients than the seller` },
            market: { provider: 'spw-seaport', venue: `Seaport ${sale.seaport.version}`, orderId: sale.orderHash, washTrade: { state: 'unknown', reason: 'not judged by SP Wallet' }, fees: sale.fees.map((f) => ({ kind: 'other' as const, bps: null, amount: { amount: f.amount, currency: { network: asset.chainId, ...t }, precision: 'exact' as const }, recipient: f.recipient, required: null })) } });
        } catch { /* a receipt that cannot be read or decoded gives no price */ } }
      }
      events.sort((a, b) => Number(BigInt(b.blockRef.number!) - BigInt(a.blockRef.number!)));
      return { events, cursor: null, completeness: extended ? 'partial' : 'recent_window', note: extended ? `last_${span}_blocks_and_provider_history` : `last_${span}_blocks` };
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
