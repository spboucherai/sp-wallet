/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/scripts/check-sources.mts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// First source of the token rule, checked by machine: for every deployment of research/candidates.json, fetch the issuer / network
// document named in `source` and look for the address in it. Writes research/evidence.json ("<SYMBOL>@<network>" -> where the
// address was found). gen-tokens.mts refuses a deployment that has no evidence entry for its exact address.
//   node packages/core/scripts/check-sources.mts            (run from the repository root)
// - a document that is a token list ({ tokens: [{ chainId, address }] }) must list the address under the right chain id;
//   any other document must contain the address as text (EVM: case-insensitive; Solana/TRON: exact);
// - a page that needs JavaScript to show its content cannot be checked this way: such a deployment is accepted only with a
//   hand-written entry { via: 'manual', note } in evidence.json (who read what, when); the script keeps those and never creates one.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CHAIN_ID: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137, optimism: 10, bsc: 56, avalanche: 43114, hyperevm: 999 };
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: 'text/html,application/json,text/plain,*/*' };
type Evidence = { address: string; url: string; via: 'document' | 'tokenlist' | 'manual'; sha256?: string; at: string; note?: string };
const OUT = 'research/evidence.json';
const cand = JSON.parse(readFileSync('research/candidates.json', 'utf8'));
const prev: Record<string, Evidence> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const docs = new Map<string, Promise<{ text: string; sha: string; list: { chainId: number; address: string }[] | null } | null>>();
const load = (url: string) => { if (!docs.has(url)) docs.set(url, (async () => {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(String(r.status));
      const text = await r.text();
      let list: { chainId: number; address: string }[] | null = null;
      try { const j = JSON.parse(text); if (Array.isArray(j?.tokens) && j.tokens.every((t: any) => typeof t.address === 'string' && typeof t.chainId === 'number')) list = j.tokens; } catch { /* not JSON */ }
      return { text, sha: createHash('sha256').update(text).digest('hex'), list };
    } catch { await new Promise((r) => setTimeout(r, 1500 * (k + 1))); }
  }
  return null;
})()); return docs.get(url)!; };

const out: Record<string, Evidence> = {}, missing: string[] = [], today = new Date().toISOString().slice(0, 10);
const jobs: Promise<void>[] = [];
for (const t of cand.tokens) for (const [net, raw] of Object.entries(t.d as Record<string, any>)) jobs.push((async () => {
  const dep = typeof raw === 'string' ? { a: raw } : raw, tag = `${t.symbol}@${net}`, evm = net in CHAIN_ID;
  const urls = String(dep.source ?? t.source).split(/\s+;\s+/).filter((u) => /^https:\/\//.test(u));
  for (const url of urls) {
    const d = await load(url);
    if (!d) continue;
    if (d.list) {
      if (evm && d.list.some((x) => x.chainId === CHAIN_ID[net] && x.address.toLowerCase() === dep.a.toLowerCase())) { out[tag] = { address: dep.a, url, via: 'tokenlist', sha256: d.sha, at: today }; return; }
    } else if (evm ? d.text.toLowerCase().includes(dep.a.toLowerCase()) : d.text.includes(dep.a)) { out[tag] = { address: dep.a, url, via: 'document', sha256: d.sha, at: today }; return; }
  }
  const p = prev[tag];
  if (p?.via === 'manual' && p.address.toLowerCase() === String(dep.a).toLowerCase()) { out[tag] = p; return; }
  missing.push(`${tag} ${dep.a} — not found in: ${urls.join(' , ') || '(no fetchable source)'}`);
})());
await Promise.all(jobs);
writeFileSync(OUT, JSON.stringify(Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n');
const n = Object.values(out);
console.log(`${n.length} deployments with evidence (${n.filter((e) => e.via === 'document').length} document, ${n.filter((e) => e.via === 'tokenlist').length} token list, ${n.filter((e) => e.via === 'manual').length} manual); ${missing.length} without`);
for (const m of missing.sort()) console.log('MISSING', m);
