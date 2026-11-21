/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/nft/src/netguard.ts
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

// Address classification for the server-side fetcher (SSRF defence, brief §6/§7). Pure. An address is fetchable only when it is
// a PUBLIC unicast address; everything else has a reason code. IPv6 forms that embed an IPv4 address (IPv4-mapped, IPv4-compatible,
// NAT64, 6to4, Teredo) are judged by the embedded address AND refused when it is not public.
export type AddressVerdict = { ok: true } | { ok: false; reason: 'loopback' | 'private' | 'link_local' | 'cgnat' | 'cloud_metadata' | 'multicast' | 'reserved' | 'unspecified' | 'documentation' | 'not_an_address' };

const v4 = (s: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
};
function classifyV4(o: number[]): AddressVerdict {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return { ok: false, reason: 'unspecified' };
  if (a === 127) return { ok: false, reason: 'loopback' };
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { ok: false, reason: 'private' };
  if (a === 169 && b === 254) return { ok: false, reason: o[2] === 169 && o[3] === 254 ? 'cloud_metadata' : 'link_local' };
  if (a === 100 && b >= 64 && b <= 127) return { ok: false, reason: o[1] === 100 && o[2] === 100 && o[3] === 200 ? 'cloud_metadata' : 'cgnat' };
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return { ok: false, reason: 'documentation' };
  if ((a === 192 && b === 0 && c === 0) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19))) return { ok: false, reason: 'reserved' };
  if (a >= 224 && a <= 239) return { ok: false, reason: 'multicast' };
  if (a >= 240) return { ok: false, reason: 'reserved' };
  return { ok: true };
}
/** IPv6 text → 16 bytes (handles `::`, an embedded dotted IPv4 tail, a zone id is refused). */
export function parseIPv6(s: string): Uint8Array | null {
  let t = s.replace(/^\[|\]$/g, '');
  if (t.includes('%') || !/^[0-9a-fA-F:.]+$/.test(t)) return null;
  let tail: number[] = [];
  const lastColon = t.lastIndexOf(':');
  if (t.includes('.')) { const q = v4(t.slice(lastColon + 1)); if (!q) return null; tail = q; t = `${t.slice(0, lastColon + 1)}0:0`; }
  const dbl = t.indexOf('::');
  if (dbl !== t.lastIndexOf('::')) return null;
  const part = (x: string) => (x === '' ? [] : x.split(':'));
  const head = part(dbl < 0 ? t : t.slice(0, dbl)), rest = dbl < 0 ? [] : part(t.slice(dbl + 2));
  const fill = 8 - head.length - rest.length;
  if (dbl < 0 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(dbl < 0 ? 0 : fill).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, k) => { const n = parseInt(g, 16); out[k * 2] = n >> 8; out[k * 2 + 1] = n & 255; });
  if (tail.length) out.set(tail, 12);
  return out;
}
function classifyV6(b: Uint8Array): AddressVerdict {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const embedded = (off: number): AddressVerdict => { const r = classifyV4([...b.slice(off, off + 4)]); return r.ok ? { ok: false, reason: 'reserved' } : r; };
  if (zero(0, 16)) return { ok: false, reason: 'unspecified' };
  if (zero(0, 15) && b[15] === 1) return { ok: false, reason: 'loopback' };
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d — never a legitimate public HTTPS destination
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded(12);
  if (zero(0, 12)) return embedded(12);
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return embedded(12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return embedded(12); // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (b[0] === 0x20 && b[1] === 0x02) return embedded(2); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return { ok: false, reason: 'reserved' }; // Teredo 2001::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return { ok: false, reason: 'documentation' };
  if (b[0] === 0x20 && b[1] === 0x01 && b[2]! < 2) return { ok: false, reason: 'reserved' }; // 2001::/23 IETF protocol assignments
  if ((b[0]! & 0xfe) === 0xfc) return { ok: false, reason: b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2 ? 'cloud_metadata' : 'private' }; // fc00::/7 (fd00:ec2::254 = AWS IMDS)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return { ok: false, reason: 'link_local' };
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return { ok: false, reason: 'private' }; // site-local fec0::/10 (deprecated)
  if (b[0] === 0xff) return { ok: false, reason: 'multicast' };
  if (b[0] === 0x01 && zero(1, 8)) return { ok: false, reason: 'reserved' }; // discard 100::/64
  if ((b[0]! & 0xe0) !== 0x20) return { ok: false, reason: 'reserved' }; // global unicast is 2000::/3 only
  return { ok: true };
}
/** Verdict for one IP address in text form (as returned by a resolver, or a URL's literal host). */
export function classifyAddress(addr: string): AddressVerdict {
  const q = v4(addr);
  if (q) return classifyV4(q);
  const b = parseIPv6(addr);
  return b ? classifyV6(b) : { ok: false, reason: 'not_an_address' };
}
export const isIpLiteral = (host: string): boolean => v4(host) !== null || parseIPv6(host) !== null;
/** Host names that never leave the machine or the local network, whatever a resolver says. */
export function forbiddenHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.onion') || (!h.includes('.') && !h.includes(':'));
}
