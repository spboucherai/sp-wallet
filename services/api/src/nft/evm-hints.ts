// EVM discovery HINT sources (delivery 3). Public RPC endpoints cannot say what an address holds (NFT-SOURCES.md §4.1), so an
// indexer is asked — and its answer is only ever a HINT: every item it names is re-read on-chain on the wallet's own two
// endpoints (evm.ts `lookupOne`) and enters the inventory only if the chain confirms the wallet holds it. An indexer can
// therefore hide an NFT (by not naming it) but cannot invent one, change a quantity or an owner.
//
//   NFT_EVM_PROVIDER=alchemy   Alchemy NFT API v3 `getNFTsForOwner` (key: ALCHEMY_API_KEY, or NFT_EVM_PROVIDER_API_KEY) — verified live
//   NFT_EVM_PROVIDER=opensea   OpenSea API v2 `GET /chain/{chain}/account/{address}/nfts` (key: OPENSEA_API_KEY) — verified live
//   NFT_EVM_INDEXER_URLS       a Blockscout-compatible instance per network (keyless; delivery 1)
//
// Each one RECEIVES THE WALLET'S EVM ADDRESS: none is on by default, and the capability list says who receives it.
//
// SECRETS. Alchemy carries its key IN THE URL PATH. Consequences, all enforced here and tested (nft-market.test.ts):
//  - a URL is built in ONE place (`alchemyUrl`) and never leaves this module: not in an error, a log, a stamp, a section, the
//    database or a fixture. What is reported outward is the HOST;
//  - an upstream or transport failure is turned into a stable code. The upstream's message is never forwarded as text — the
//    "network not enabled" answer carries a dashboard URL with the app's identifier: only its network token is kept;
//  - `scrubSecrets` removes the key (and anything of a URL after the host) from any text, for the callers that format errors.
import { NftProviderError } from '@spw/nft';
import { hostOnly } from './config.ts';

export type HttpFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface EvmHint { contract: string; id: string; /** the indexer's own spam signal, passed through — never used to drop an item */ spam: { flagged: boolean; classifications: string[] } | null }
export interface EvmHistoryHint { tx: string; block: string }
export interface EvmHintSource {
  id: string; name: string;
  /** null when the source can be asked for this network; else a stable reason */
  notCovered(chain: string): string | null;
  host(chain: string): string;
  /** the variable (or action) that would unlock a refused network */
  unlockedBy: string;
  list(chain: string, owner: string, max: number): Promise<{ hints: EvmHint[]; truncated: boolean }>;
  /** transactions in which tokens of `contract` moved to or from `owner` — hints for the history, each re-read from the chain by the caller */
  history?(chain: string, owner: string, contract: string): Promise<EvmHistoryHint[]>;
}

/** Remove secrets from a text: each given value, and the path + query of anything that looks like a URL (a key may sit in either). */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text.replace(/\b(https?:\/\/[^\/\s"'<>]+)\/[^\s"'<>]*/g, '$1/<redacted>');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('<redacted>');
  return out;
}
const ADDR = /^0x[0-9a-fA-F]{40}$/, DEC = /^[0-9]{1,78}$/;
const fail = (code: ConstructorParameters<typeof NftProviderError>[0], source: string, detail = ''): NftProviderError => new NftProviderError(code, source, detail);

// ── Alchemy NFT API v3 ──────────────────────────────────────────────────────────────────────────────────────────────────
/** registry network → Alchemy network subdomain (NFT API `network` enum of github.com/alchemyplatform/docs src/openapi/nft/nft.yaml, read 2026-11-17; HyperEVM is not in it) */
export const ALCHEMY_NETWORKS: Record<string, string> = { ethereum: 'eth-mainnet', base: 'base-mainnet', arbitrum: 'arb-mainnet', polygon: 'polygon-mainnet', optimism: 'opt-mainnet', bsc: 'bnb-mainnet', avalanche: 'avax-mainnet' };
export function alchemyHints(deps: { http: HttpFn; apiKey: string }): EvmHintSource {
  const KEY = deps.apiKey;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(KEY)) throw new Error('ALCHEMY_API_KEY: unexpected format'); // it goes into a URL path: nothing but its own alphabet
  /** the ONLY place a URL with the key exists */
  const alchemyUrl = (chain: string, kind: 'nft' | 'rpc', path = ''): string => `https://${ALCHEMY_NETWORKS[chain]}.g.alchemy.com/${kind === 'nft' ? `nft/v3/${KEY}${path}` : `v2/${KEY}`}`;
  async function call(chain: string, kind: 'nft' | 'rpc', path: string, body?: unknown): Promise<unknown> {
    let r: Response;
    try { r = await deps.http(alchemyUrl(chain, kind, path), { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { throw fail('provider_unavailable', 'alchemy'); } // the transport's own message may quote the URL: it is dropped
    if (r.status === 429) throw fail('provider_rate_limited', 'alchemy');
    if (!r.ok) {
      let t = ''; try { t = (await r.text()).slice(0, 300); } catch { /* no body */ }
      // 403 "<NETWORK> is not enabled for this app. Visit this page …/apps/<app id>/networks" (observed 2026-11-17): only the network token is kept
      const m = /^([A-Z][A-Z0-9_]{2,40}) is not enabled for this app/.exec(t);
      if (r.status === 403 && m) throw fail('provider_not_configured', 'alchemy', `network_not_enabled:${m[1]!.toLowerCase()}`);
      if (r.status === 401 || r.status === 403) throw fail('provider_not_configured', 'alchemy', r.status === 401 ? 'key_refused' : 'forbidden');
      throw fail('provider_unavailable', 'alchemy', `http_${r.status}`);
    }
    try { return (await r.json()) as unknown; } catch { throw fail('provider_bad_answer', 'alchemy', 'not_json'); }
  }
  return {
    id: 'alchemy', name: 'Alchemy', unlockedBy: 'ALCHEMY_API_KEY',
    notCovered: (chain) => (ALCHEMY_NETWORKS[chain] ? null : 'chain_not_covered'),
    host: (chain) => `${ALCHEMY_NETWORKS[chain] ?? 'unknown'}.g.alchemy.com`,
    async list(chain, owner, max) {
      const hints: EvmHint[] = []; let pageKey: string | null = null, truncated = false;
      for (let page = 0; page < 10; page++) {
        // withMetadata=false: only identifiers are wanted (the flat shape: contractAddress, tokenId, balance, isSpam, spamClassifications)
        const q = new URLSearchParams({ owner, withMetadata: 'false', pageSize: '100', ...(pageKey ? { pageKey } : {}) });
        const j = (await call(chain, 'nft', `/getNFTsForOwner?${q}`)) as { ownedNfts?: unknown; pageKey?: unknown };
        if (!Array.isArray(j?.ownedNfts)) throw fail('provider_bad_answer', 'alchemy', 'no_owned_nfts');
        for (const it of j.ownedNfts as Record<string, unknown>[]) {
          const c = String(it?.contractAddress ?? (it?.contract as { address?: unknown } | undefined)?.address ?? ''), id = String(it?.tokenId ?? '');
          if (ADDR.test(c) && DEC.test(id)) hints.push({ contract: c, id, spam: typeof it.isSpam === 'boolean' ? { flagged: it.isSpam, classifications: Array.isArray(it.spamClassifications) ? it.spamClassifications.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(x)).slice(0, 10) : [] } : null });
        }
        pageKey = typeof j.pageKey === 'string' && j.pageKey.length <= 400 ? j.pageKey : null;
        if (!pageKey || hints.length >= max) { truncated = !!pageKey; break; }
        truncated = page === 9;
      }
      return { hints: hints.slice(0, max), truncated: truncated || hints.length > max };
    },
    async history(chain, owner, contract) {
      const out = new Map<string, EvmHistoryHint>();
      for (const side of ['toAddress', 'fromAddress'] as const) {
        const j = (await call(chain, 'rpc', '', { jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [{ fromBlock: '0x0', toBlock: 'latest', [side]: owner, contractAddresses: [contract], category: ['erc721', 'erc1155'], withMetadata: false, maxCount: '0x32', order: 'desc' }] })) as { result?: { transfers?: unknown }; error?: unknown };
        if (j?.error || !Array.isArray(j?.result?.transfers)) throw fail('provider_bad_answer', 'alchemy', 'no_transfers');
        for (const t of j.result!.transfers as Record<string, unknown>[]) if (typeof t.hash === 'string' && /^0x[0-9a-f]{64}$/.test(t.hash) && typeof t.blockNum === 'string' && /^0x[0-9a-f]{1,16}$/.test(t.blockNum)) out.set(t.hash, { tx: t.hash, block: BigInt(t.blockNum).toString(10) });
      }
      return [...out.values()];
    },
  };
}

// ── OpenSea API v2: NFTs by account ─────────────────────────────────────────────────────────────────────────────────────
const OPENSEA_EVM: Record<string, string> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon', optimism: 'optimism', avalanche: 'avalanche', hyperevm: 'hyperevm' };
export function openSeaHints(deps: { http: HttpFn; apiKey: string }): EvmHintSource {
  return {
    id: 'opensea', name: 'OpenSea', unlockedBy: 'OPENSEA_API_KEY',
    notCovered: (chain) => (OPENSEA_EVM[chain] ? null : 'chain_not_covered'),
    host: () => 'api.opensea.io',
    async list(chain, owner, max) {
      const hints: EvmHint[] = []; let next: string | null = null, truncated = false;
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({ limit: '200', ...(next ? { next } : {}) });
        let r: Response;
        try { r = await deps.http(`https://api.opensea.io/api/v2/chain/${OPENSEA_EVM[chain]}/account/${owner}/nfts?${q}`, { headers: { accept: 'application/json', 'x-api-key': deps.apiKey, 'user-agent': 'sp-wallet-nft/1' }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
        catch { throw fail('provider_unavailable', 'opensea'); }
        if (r.status === 429) throw fail('provider_rate_limited', 'opensea');
        if (r.status === 401 || r.status === 403) throw fail('provider_not_configured', 'opensea', 'key_refused');
        if (!r.ok) throw fail('provider_unavailable', 'opensea', `http_${r.status}`);
        let j: { nfts?: unknown; next?: unknown };
        try { j = (await r.json()) as typeof j; } catch { throw fail('provider_bad_answer', 'opensea', 'not_json'); }
        if (!Array.isArray(j?.nfts)) throw fail('provider_bad_answer', 'opensea', 'no_nfts');
        for (const it of j.nfts as Record<string, unknown>[]) { const c = String(it?.contract ?? ''), id = String(it?.identifier ?? ''); if (ADDR.test(c) && DEC.test(id)) hints.push({ contract: c, id, spam: null }); }
        next = typeof j.next === 'string' && j.next.length <= 600 ? j.next : null;
        if (!next || hints.length >= max) { truncated = !!next; break; }
        truncated = page === 9;
      }
      return { hints: hints.slice(0, max), truncated: truncated || hints.length > max };
    },
  };
}

// ── Blockscout-compatible instance (delivery 1; unchanged behaviour) ────────────────────────────────────────────────────
export function blockscoutHints(deps: { http: HttpFn; instances: Record<string, string> }): EvmHintSource {
  return {
    id: 'evm-indexer', name: 'Blockscout', unlockedBy: 'NFT_EVM_INDEXER_URLS',
    notCovered: (chain) => (deps.instances[chain] ? null : 'no_indexer_configured'),
    host: (chain) => hostOnly(deps.instances[chain] ?? ''),
    async list(chain, owner, max) {
      const base = deps.instances[chain]!, hints: EvmHint[] = []; let next: Record<string, unknown> | null = null, truncated = false;
      for (let page = 0; page < 4; page++) {
        const q = new URLSearchParams({ type: 'ERC-721,ERC-1155', ...(next ? Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) : {}) });
        let r: Response;
        try { r = await deps.http(`${base}/api/v2/addresses/${owner}/nft?${q}`, { headers: { accept: 'application/json', 'user-agent': 'sp-wallet-nft/1' }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
        catch { throw fail('provider_unavailable', 'evm-indexer'); }
        if (r.status === 429) throw fail('provider_rate_limited', 'evm-indexer');
        if (!r.ok) throw fail('provider_unavailable', 'evm-indexer', `http ${r.status}`);
        const j = (await r.json()) as { items?: { id?: unknown; token?: { address_hash?: unknown; address?: unknown } }[]; next_page_params?: Record<string, unknown> | null };
        if (!Array.isArray(j.items)) throw fail('provider_bad_answer', 'evm-indexer');
        for (const it of j.items) { const c = String(it.token?.address_hash ?? it.token?.address ?? ''), id = String(it.id ?? ''); if (ADDR.test(c) && DEC.test(id)) hints.push({ contract: c, id, spam: null }); }
        next = j.next_page_params ?? null;
        if (!next || hints.length >= max) { truncated = !!next; break; }
        truncated = page === 3;
      }
      return { hints: hints.slice(0, max), truncated: truncated || hints.length > max };
    },
  };
}
