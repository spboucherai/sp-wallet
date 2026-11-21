/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-nft-market.mts
 * Module           : scripts
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

// Read-only smoke of the NFT market layer (delivery 3): what each CONFIGURED market provider answers today for the brief's
// reference item, and what the keyed EVM discovery provider answers per network. Nothing is written, signed or sent on a chain;
// no database is used. Without any variable set it prints which sources are absent and what would turn each one on.
//
//   npx tsx scripts/smoke-nft-market.mts                       (no key: every source absent, with its variable)
//   OPENSEA_API_KEY=… NFT_MARKET_MAGICEDEN=on NFT_EVM_PROVIDER=alchemy ALCHEMY_API_KEY=… npx tsx scripts/smoke-nft-market.mts
//   … --evm-address 0x…   a PUBLIC address to list as a read-only subject of the EVM discovery provider (default: none asked)
//
// A key is read from the environment and is never printed: what is shown of a source is its name and host.
Object.assign(process.env, { SPW_ORIGIN: process.env.SPW_ORIGIN ?? 'http://localhost', SPW_RP_ID: process.env.SPW_RP_ID ?? 'localhost', DATABASE_URL: process.env.DATABASE_URL ?? 'postgres:///spw_smoke_unused', SPW_SIGNER_SECRET: process.env.SPW_SIGNER_SECRET ?? 'k'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { nftConfig } = await import('../services/api/src/nft/config.ts');
const { marketProviders, evmHintSources } = await import('../services/api/src/nft/index.ts');
const { scrubSecrets } = await import('../services/api/src/nft/evm-hints.ts');
const { unitsToDecimal, traitFrequency, NftProviderError } = await import('../packages/nft/src/index.ts');
const { NETWORKS } = await import('@spw/core');
import type { ItemMarket, Known, MarketMoney } from '../packages/nft/src/index.ts';
import type { MarketRef } from '../services/api/src/nft/market/types.ts';

const REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j';
const arg = (name: string): string | null => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] ?? null : null; };
const cfg = nftConfig(), now = () => new Date(), http = (url: string, init?: RequestInit) => fetch(url, init);
const secrets = [cfg.openSeaApiKey, cfg.alchemyApiKey];
const say = (label: string, v: string) => console.log(`  ${label.padEnd(26)} ${scrubSecrets(v, secrets)}`);
const money = (m: MarketMoney) => `${unitsToDecimal(m.amount, m.currency.decimals)} ${m.currency.symbol} [${m.currency.network}:${m.currency.asset}, ${m.amount} base units${m.precision === 'exact' ? '' : ', from the source\'s decimal'}]`;
const known = <T,>(k: Known<T>, f: (v: T) => string): string => (k.state === 'known' ? f(k.value) : k.state === 'none' ? 'none (the source says there is none)' : k.state === 'unsupported' ? 'not applicable' : `unknown${'reason' in k && k.reason ? ` (${k.reason})` : ''}`);
const fail = (e: unknown): string => (e instanceof NftProviderError ? `${e.code}${/\(([a-z0-9_:]+)\)$/.exec(e.message)?.[1] ? ` (${/\(([a-z0-9_:]+)\)$/.exec(e.message)![1]})` : ''}` : 'unexpected failure');

const ref: MarketRef = { key: `sol:solana:${REF}`, family: 'sol', chain: 'solana', standard: 'metaplex-core', contract: null, tokenId: null, mint: REF };
const { providers, absent, budgets } = marketProviders(cfg, http, now);
console.log(`== market sources for sol:solana:${REF} — ${now().toISOString()}`);
for (const a of absent) { console.log(`-- ${a.name}: ${a.state === 'needs_key' ? 'NEEDS KEY' : 'OFF'} — unlocked by ${a.unlockedBy}`); say('would give', a.unlocks); say('market fields', 'unavailable (the source is not asked; nothing is shown in its place)'); }
for (const p of providers) {
  const d = p.describe();
  console.log(`-- ${p.name}: ON — adapter verified ${d.verification === 'live' ? 'live' : 'against the documentation only'}; sends ${d.sends}; budget ${d.limits.perMinute}/min, ${d.limits.perDay}/day`);
  let it: Omit<ItemMarket, 'status'> | null = null;
  try { it = await p.item(ref); } catch (e) { say('item', `FAILED — ${fail(e)}`); }
  if (it) {
    console.log(`  ${'page (outside SP Wallet)'.padEnd(26)} ${it.url ?? 'none'}`); // a public page of the marketplace: it carries no secret
    say('listed', known(it.listed, (v) => (v ? 'yes' : 'no')));
    say('asking price', known(it.ask, (l) => `${money(l.price)} · seller ${l.seller ?? '?'} · ${l.protocol?.name ?? '?'}${l.expiresAt ? ` · expires ${l.expiresAt}` : ''}`));
    say('best offer', known(it.bestOffer, (o) => `${money(o.price)} · ${o.scope} · bidder ${o.bidder ?? '?'}`));
    say('last sale', known(it.lastSale, (s) => `${money(s.price)} · ${s.at ?? 'no date'} · ${s.seller ?? '?'} → ${s.buyer ?? '?'} · tx ${s.tx ?? '?'}`));
    say('collection (marketplace)', it.collection ? `${it.collection.slug}${it.collection.name ? ` — ${it.collection.name}` : ''}` : 'none named');
    say('verification', it.verification ? `${it.verification.state} — statement of ${it.verification.by} (its value: ${it.verification.providerValue ?? 'none'})` : 'not reported');
    say('rarity', known(it.rarity, (r) => `rank ${r.rank}${r.outOf ? ` of ${r.outOf}` : ''} — method ${r.method}`));
    say('flags', `suspicious: ${known(it.flags.suspicious, String)} · disabled: ${known(it.flags.disabled, String)}`);
    if (p.events) { try { const ev = await p.events(ref, { cursor: null, types: null, after: null, before: null, limit: 20 });
      const by = new Map<string, number>(); for (const e of ev.items) by.set(e.type, (by.get(e.type) ?? 0) + 1);
      say('market events (page 1)', `${ev.items.length}: ${[...by].map(([t, n]) => `${n} ${t}`).join(', ') || 'none'}${ev.cursor ? ' — more pages' : ''}`);
      for (const e of ev.items.filter((x) => x.type !== 'transfer').slice(0, 5)) say(`  ${e.type}`, `${e.at ?? 'no date'} · ${e.price ? money(e.price) : 'no price'} · ${e.from ?? '?'} → ${e.to ?? '?'} · wash trade: ${known(e.flags.washTrade, String)}`);
    } catch (e) { say('market events', `FAILED — ${fail(e)}`); } }
    if (it.collection && p.collection) { try { const c = await p.collection({ chain: 'solana', slug: it.collection.slug });
      say('collection floor', `${known(c.floor, money)}  — a statistic of the collection, NOT the value of this item`);
      for (const v of c.volumes) say(`volume ${v.interval}`, `${v.volume ? money(v.volume) : v.reported ? `${v.reported.value} ${v.reported.symbol} (as reported: unit named by symbol only)` : 'not reported'}${v.sales ? ` · ${v.sales} sales` : ''}`);
      say('items / owners / listed', `${known(c.totalSupply, String)} / ${known(c.owners, String)} / ${known(c.listedCount, String)}`);
      say('fees (as the source gives)', c.fees ? c.fees.map((f) => `${f.bps !== null ? `${f.bps / 100} %` : '?'} → ${f.recipient ?? '?'}${f.required === null ? '' : f.required ? ' (required)' : ' (optional)'}`).join('; ') || 'none' : 'not reported');
      say('trait frequency', c.traits.state === 'known' ? ['Grader|PSA', 'Language|Japanese', 'Name|Pikachu'].map((x) => { const [t, v] = x.split('|') as [string, string]; const f = traitFrequency(c.traits.state === 'known' ? c.traits.value : { total: '0', categories: [] }, t, v); return f ? `${t}=${v}: ${f.percent} % of ${f.total} items (${f.count})` : `${t}=${v}: not computed`; }).join(' · ') : `not computed (${known(c.traits, () => '')})`);
    } catch (e) { say('collection', `FAILED — ${fail(e)}`); } }
  }
  const b = budgets.get(p.id)?.counter(); if (b) say('requests used', `${b.minute.used}/${b.minute.limit} this minute, ${b.day.used}/${b.day.limit} today; refused locally ${b.refused}; upstream 429: ${b.upstreamLimited}`);
}
console.log('  value of this item         unavailable — no source gives one, and none is derived from a floor or a single quote');
console.log('  market actions             none: buy, sell, list, offer, accept and cancel are not built (docs/nft/NFT-MARKET-WRITES.md)');

// ── keyed EVM discovery provider: per network, what it answers for a public read-only subject ────────────────────────────
const hints = evmHintSources(cfg, http), subject = arg('evm-address');
console.log(`\n== EVM discovery provider (NFT_EVM_PROVIDER) — ${hints.length ? hints[0]!.name : cfg.evmProvider ? `absent: ${cfg.evmProvider} needs its key` : 'absent: NFT_EVM_PROVIDER is not set'}`);
if (hints.length && !subject) console.log('  no subject given (--evm-address 0x… : a public address, read-only); the wallet\'s own address is not used by this script');
if (hints.length && subject) for (const n of Object.values(NETWORKS).filter((x) => x.family === 'evm')) {
  const h = hints[0]!, why = h.notCovered(n.id);
  if (why) { say(n.id, `not covered by ${h.name} (${why})`); continue; }
  try { const r = await h.list(n.id, subject, 200); say(n.id, `${r.hints.length} hint(s)${r.truncated ? ' (more exist)' : ''} from ${h.host(n.id)}; flagged as spam by ${h.name}: ${r.hints.filter((x) => x.spam?.flagged).length} — hints only: each would be re-verified on-chain before it is shown as held`); }
  catch (e) { const c = fail(e); say(n.id, c.includes('network_not_enabled') ? `BLOCKED BY PROVIDER — network not enabled for this key (${c}); enable it in the provider's dashboard` : `FAILED — ${c}`); }
}
process.exit(0);
