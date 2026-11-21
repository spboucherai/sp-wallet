/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/nft/src/uri.ts
 * Module           : nft
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// Deterministic URI resolver for NFT metadata and media (brief §6 "Metadata and URIs"). Pure: it turns the URI a chain or a
// metadata document gives into (a) inline bytes for `data:` URIs or (b) an ordered list of HTTPS candidates to try — it fetches
// nothing. The source URI is never rewritten in place: callers keep `sourceUri` and store which candidate answered.
//
// Accepted: https://, ipfs:// (and ipfs://ipfs/…), ar://, data: (JSON for metadata; images for media). Everything else is
// refused with a code — http:// included (cleartext, and the usual vehicle of requests to internal services).
import { parseTokenId } from './model.ts';

export type UriRefusal = 'empty_uri' | 'uri_too_long' | 'scheme_not_allowed' | 'malformed_uri' | 'credentials_in_url' | 'port_not_allowed' | 'bad_ipfs_path' | 'bad_arweave_id' | 'data_uri_not_allowed' | 'data_uri_malformed' | 'no_gateway';
export type ResolvedUri =
  | { ok: true; kind: 'https' | 'ipfs' | 'arweave'; candidates: string[] }
  | { ok: true; kind: 'data'; mime: string; bytes: Uint8Array }
  | { ok: false; code: UriRefusal };

export interface Gateways { ipfs: string[]; arweave: string[] }
/** Public gateways used when none is configured (NFT_IPFS_GATEWAYS / NFT_ARWEAVE_GATEWAYS). Each receives only the content id. */
export const DEFAULT_GATEWAYS: Gateways = { ipfs: ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'], arweave: ['https://arweave.net/'] };
export const MAX_URI_LENGTH = 2048, MAX_DATA_URI_BYTES = 256 * 1024;

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120}|[zkf][0-9A-Za-z]{20,120})$/;
const AR_ID = /^[A-Za-z0-9_-]{43}$/;
/** path after the content id: no dot segments, no backslash, no control character; percent-escapes are passed through unchanged */
const safePath = (p: string): boolean => !/(^|\/)\.\.?(\/|$)/.test(p) && !/[\\\u0000-\u001f\u007f]/.test(p);

/** A gateway base must be `https://host/…/` with no credentials, query or fragment. */
export function parseGatewayList(raw: string | undefined, dflt: string[]): string[] {
  if (!raw || !raw.trim()) return dflt;
  const out: string[] = [];
  for (const s of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    let u: URL; try { u = new URL(s); } catch { throw new Error('gateway list: invalid URL'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('gateway list: only https://host/path/ entries are accepted');
    out.push(u.href.endsWith('/') ? u.href : `${u.href}/`);
  }
  return out;
}

/** https URL checks that need no network: scheme, credentials, port. (Where the host points is checked at connect time — safe-fetch.) */
export function checkHttpsUrl(uri: string): { ok: true; url: URL } | { ok: false; code: UriRefusal } {
  let u: URL; try { u = new URL(uri); } catch { return { ok: false, code: 'malformed_uri' }; }
  if (u.protocol !== 'https:') return { ok: false, code: 'scheme_not_allowed' };
  if (u.username || u.password) return { ok: false, code: 'credentials_in_url' };
  if (u.port && u.port !== '443') return { ok: false, code: 'port_not_allowed' };
  if (!u.hostname) return { ok: false, code: 'malformed_uri' };
  return { ok: true, url: u };
}

function parseDataUri(uri: string, allow: (mime: string) => boolean): ResolvedUri {
  const comma = uri.indexOf(',');
  if (comma < 0) return { ok: false, code: 'data_uri_malformed' };
  const head = uri.slice(5, comma).split(';').map((x) => x.trim()), mime = (head[0] || 'text/plain').toLowerCase(), b64 = head.some((x) => x.toLowerCase() === 'base64');
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) || !allow(mime)) return { ok: false, code: 'data_uri_not_allowed' };
  const body = uri.slice(comma + 1);
  let bytes: Uint8Array;
  try {
    if (b64) { if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body.replace(/\s+/g, ''))) return { ok: false, code: 'data_uri_malformed' }; bytes = Uint8Array.from(atob(body.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)); }
    else bytes = new TextEncoder().encode(decodeURIComponent(body));
  } catch { return { ok: false, code: 'data_uri_malformed' }; }
  if (bytes.length > MAX_DATA_URI_BYTES) return { ok: false, code: 'uri_too_long' };
  return { ok: true, kind: 'data', mime, bytes };
}

const DATA_JSON = (m: string) => m === 'application/json' || m === 'text/plain';
const DATA_MEDIA = (m: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'].includes(m);

/** `purpose`: a metadata document may be an on-chain `data:application/json`; a media URI may be a `data:image/*`. */
export function resolveUri(source: string, gateways: Gateways = DEFAULT_GATEWAYS, purpose: 'metadata' | 'media' = 'metadata'): ResolvedUri {
  const uri = source.trim().replace(/\0+$/, '');
  if (!uri) return { ok: false, code: 'empty_uri' };
  if (/^data:/i.test(uri)) return uri.length > MAX_DATA_URI_BYTES * 1.4 + 64 ? { ok: false, code: 'uri_too_long' } : parseDataUri(uri, purpose === 'metadata' ? DATA_JSON : DATA_MEDIA);
  if (uri.length > MAX_URI_LENGTH) return { ok: false, code: 'uri_too_long' };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri)?.[1]?.toLowerCase();
  if (scheme === 'ipfs') {
    const rest = uri.slice(7).replace(/^\/+/, '').replace(/^ipfs\//, '');
    const cut = rest.search(/[/?#]/), cid = cut < 0 ? rest : rest.slice(0, cut), tail = cut < 0 ? '' : rest.slice(cut);
    if (!CID.test(cid) || !safePath(tail) || /[?#]/.test(tail)) return { ok: false, code: 'bad_ipfs_path' };
    if (!gateways.ipfs.length) return { ok: false, code: 'no_gateway' };
    return { ok: true, kind: 'ipfs', candidates: gateways.ipfs.map((g) => `${g}${cid}${tail}`) };
  }
  if (scheme === 'ar') {
    const rest = uri.slice(5), cut = rest.search(/[/?#]/), id = cut < 0 ? rest : rest.slice(0, cut), tail = cut < 0 ? '' : rest.slice(cut);
    if (!AR_ID.test(id) || !safePath(tail) || /[?#]/.test(tail)) return { ok: false, code: 'bad_arweave_id' };
    if (!gateways.arweave.length) return { ok: false, code: 'no_gateway' };
    return { ok: true, kind: 'arweave', candidates: gateways.arweave.map((g) => `${g}${id}${tail}`) };
  }
  if (scheme !== 'https') return { ok: false, code: scheme ? 'scheme_not_allowed' : 'malformed_uri' };
  const c = checkHttpsUrl(uri);
  return c.ok ? { ok: true, kind: 'https', candidates: [c.url.href] } : c;
}

/**
 * ERC-1155 metadata URI: "If the string {id} exists in any URI, clients MUST replace this with the actual token ID in
 * hexadecimal form … lowercase alphanumeric … leading zero padded to 64 hex characters length … no 0x prefix" (EIP-1155,
 * section Metadata). Every literal `{id}` is replaced; nothing else is touched.
 */
export function substituteErc1155Id(uri: string, tokenId: string | bigint): string {
  const id = typeof tokenId === 'bigint' ? tokenId : parseTokenId(tokenId);
  return uri.split('{id}').join(id.toString(16).padStart(64, '0'));
}

/** For display: the host of an http(s) link, or null when the link must not be offered (javascript:, data:, anything else). */
export function safeExternalLink(raw: unknown): { href: string; host: string } | null {
  if (typeof raw !== 'string' || raw.length > MAX_URI_LENGTH) return null;
  let u: URL; try { u = new URL(raw.trim()); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || !u.hostname) return null;
  return { href: u.href, host: u.hostname };
}
