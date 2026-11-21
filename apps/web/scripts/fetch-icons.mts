/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/scripts/fetch-icons.mts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-15
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

// One-off importer of the logo set (run by hand, never by the build): downloads each logo from the source named in the table
// below, sanitises SVGs (svg-sanitize.mts), converts large PNGs to WebP when `cwebp` is installed, and writes
// apps/web/src/logos/<kind>/<slug>.<ext> plus the manifest apps/web/src/logos/icons.json (symbol → file, source, licence).
//
//   npx tsx apps/web/scripts/fetch-icons.mts            # everything
//   npx tsx apps/web/scripts/fetch-icons.mts ADA DOT    # only these ids
//
// Rule of the table: a token's logo is taken BY CONTRACT ADDRESS of a registry deployment (SmolDapp/tokenAssets, Trust Wallet
// assets), never by ticker — two different tokens can share a ticker (the ticker-keyed collections return Skycoin for SKY,
// Velo for VELO, another token for DEGEN and TOSHI). Ticker-keyed collections are used only for coins that are native to a
// network (BTC, ETH, SOL…), and each of those was compared by eye with the address- or chain-keyed logo of Trust Wallet.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKENS } from '../../../packages/core/src/tokens.ts';
import { cleanSvg, rasterSize, unsafeReason } from './svg-sanitize.mts';

const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, '../src/logos');
const RAW = 'https://raw.githubusercontent.com/';
export const LICENCES = {
  w3i: { name: 'Web3Icons (0xa3k5/web3icons)', licence: 'MIT', url: 'https://github.com/0xa3k5/web3icons/blob/main/LICENCE' },
  cci: { name: 'cryptocurrency-icons (spothq)', licence: 'CC0-1.0', url: 'https://github.com/spothq/cryptocurrency-icons/blob/master/LICENSE.md' },
  smol: { name: 'SmolDapp/tokenAssets (logos keyed by chain id and contract address)', licence: 'MIT', url: 'https://github.com/SmolDapp/tokenAssets/blob/main/LICENSE' },
  tw: { name: 'Trust Wallet assets (logos keyed by chain and contract address, submitted by the projects)', licence: 'MIT', url: 'https://github.com/trustwallet/assets/blob/master/LICENSE' },
  lifi: { name: 'lifinance/types (icons of the bridges, exchanges and chains LI.FI integrates)', licence: 'Apache-2.0', url: 'https://github.com/lifinance/types/blob/main/LICENSE.md' },
  cr: { name: 'cosmos/chain-registry (images each chain publishes about itself)', licence: 'CC-BY-4.0', url: 'https://github.com/cosmos/chain-registry/blob/master/LICENSE' },
} as const;
type Lic = keyof typeof LICENCES;
const SMOL_CHAIN: Record<string, string> = { ethereum: '1', base: '8453', arbitrum: '42161', polygon: '137', optimism: '10', bsc: '56', avalanche: '43114', solana: '1151111081099710' };
const TW_CHAIN: Record<string, string> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon', optimism: 'optimism', bsc: 'smartchain', avalanche: 'avalanchec', solana: 'solana', tron: 'tron' };

interface Src { lic: Lic; url: string; verified: string; plate?: string; scale?: number }
const addr = (sym: string, net: string) => { const d = TOKENS.find((t) => t.symbol === sym)?.deployments[net]; if (!d) throw new Error(`${sym} has no ${net} deployment in the registry`); return d.address; };
const w3 = (dir: string, name: string, o: Partial<Src> = {}): Src => ({ lic: 'w3i', url: `${RAW}0xa3k5/web3icons/main/raw-svgs/${dir}/${name}.svg`, verified: 'native coin: ticker match, compared by eye with the Trust Wallet chain logo', ...o });
const smol = (sym: string, net: string): Src => ({ lic: 'smol', url: `${RAW}SmolDapp/tokenAssets/main/tokens/${SMOL_CHAIN[net]}/${net === 'solana' ? addr(sym, net) : addr(sym, net).toLowerCase()}/logo.svg`, verified: `contract ${addr(sym, net)} on ${net}` });
const tw = (sym: string, net: string): Src => ({ lic: 'tw', url: `${RAW}trustwallet/assets/master/blockchains/${TW_CHAIN[net]}/assets/${addr(sym, net)}/logo.png`, verified: `contract ${addr(sym, net)} on ${net}` });
const lifi = (path: string, verified: string, o: Partial<Src> = {}): Src => ({ lic: 'lifi', url: `${RAW}lifinance/types/main/src/assets/icons/${path}`, verified, ...o });
const cr = (path: string, verified: string, o: Partial<Src> = {}): Src => ({ lic: 'cr', url: `${RAW}cosmos/chain-registry/master/${path}`, verified, ...o });

/** symbol → where its logo comes from; `{ of }` = this asset has no mark of its own: the underlying's logo + a network badge that is always shown. */
const ASSETS: Record<string, Src | { of: string; note: string }> = {
  // coins native to a network
  BTC: w3('tokens/background', 'BTC'), ETH: w3('tokens/branded', 'ETH', { plate: '#14161f', scale: 0.72 }), SOL: w3('tokens/branded', 'SOL', { plate: '#000000', scale: 0.56 }),
  BNB: w3('tokens/background', 'BNB'), AVAX: w3('tokens/background', 'AVAX'), LTC: w3('tokens/background', 'LTC'), BCH: w3('tokens/background', 'BCH'), XLM: w3('tokens/background', 'XLM'),
  XRP: w3('tokens/background', 'XRP'), TRX: w3('tokens/background', 'TRX'), SUI: w3('tokens/background', 'SUI'), TON: w3('tokens/background', 'TON'), DOT: w3('tokens/background', 'DOT'),
  POL: w3('tokens/background', 'POL'), ADA: w3('tokens/branded', 'ADA', { plate: '#ffffff', scale: 0.7 }), APT: w3('networks/background', 'aptos'), NEAR: w3('networks/background', 'near-protocol'),
  DOGE: { lic: 'cci', url: `${RAW}spothq/cryptocurrency-icons/master/svg/color/doge.svg`, verified: 'native coin: ticker match, compared by eye with the Trust Wallet chain logo' },
  ATOM: cr('cosmoshub/images/atom.svg', 'published by the Cosmos Hub in the chain registry'),
  HYPE: lifi('chains/hyperliquid.svg', 'Hyperliquid chain icon; same mark as the Trust Wallet HyperEVM chain logo'),
  MNT: w3('tokens/background', 'MNT', { verified: 'ticker match, same mark as Trust Wallet for contract 0x3c3a81e81dc49A522A592e7622A7E711c06bf354 on ethereum' }),
  HNT: w3('tokens/background', 'HNT', { verified: 'ticker match, same mark as Trust Wallet for the registry mint on solana' }),
  JUP: lifi('exchanges/jupiter.svg', 'Jupiter exchange icon; same mark as Trust Wallet for the registry mint on solana'),
  USDT0: lifi('tokens/USDT0.svg', 'USDT0 token icon; same mark as Trust Wallet for the registry contract on optimism'),
  // tokens, by contract address (vector)
  ...Object.fromEntries(['USDC', 'USDT', 'PYUSD', 'DAI', 'USDS', 'USDe', 'FDUSD', 'EURC', 'RLUSD', 'LINK', 'UNI', 'AAVE', 'LDO', 'WBTC', 'WETH', 'PAXG', 'SHIB', 'frxUSD', 'USDD', 'cbBTC', 'wstETH', 'rETH', 'cbETH', 'weETH', 'MKR', 'SKY', 'COMP', 'SNX', 'PENDLE', 'ENA', 'MORPHO'].map((s) => [s, smol(s, 'ethereum')])),
  ARB: smol('ARB', 'arbitrum'), GMX: smol('GMX', 'arbitrum'), OP: smol('OP', 'optimism'), VELO: smol('VELO', 'optimism'), CAKE: smol('CAKE', 'bsc'), PYTH: smol('PYTH', 'solana'),
  ...Object.fromEntries(['cbXRP', 'cbDOGE', 'cbLTC', 'cbADA', 'AERO', 'DEGEN'].map((s) => [s, smol(s, 'base')])),
  // tokens, by contract address (raster: no vector original found, or the vector is heavier than the raster)
  ...Object.fromEntries(['PEPE', 'crvUSD', 'tBTC', 'CRV', 'USDG', 'GHO', 'ONDO', 'EIGEN'].map((s) => [s, tw(s, 'ethereum')])),
  ...Object.fromEntries(['RENDER', 'BONK', 'JTO', 'ORCA', 'jitoSOL', 'bSOL', 'mSOL', 'RAY'].map((s) => [s, tw(s, 'solana')])),
  BRETT: tw('BRETT', 'base'), TOSHI: tw('TOSHI', 'base'), JOE: tw('JOE', 'avalanche'),
  // representations without a mark of their own
  'USDC.e': { of: 'USDC', note: 'bridged USDC: the address-keyed logos (Trust Wallet, polygon/arbitrum/optimism/avalanche) are the USDC mark' },
  'LINK.e': { of: 'LINK', note: 'Avalanche Bridge LINK: the address-keyed logo (Trust Wallet, avalanche) is the LINK mark' },
  'WETH.e': { of: 'WETH', note: 'Avalanche Bridge WETH: no address-keyed logo found' },
  'BTC.b': { of: 'BTC', note: 'Avalanche Bridge BTC: no address-keyed logo found' },
  BTCB: { of: 'BTC', note: 'Binance-Peg BTC: the address-keyed logo (Trust Wallet, bsc) is the Bitcoin mark' },
  WBNB: { of: 'BNB', note: 'wrapper contract: the address-keyed logo (Trust Wallet, bsc) is the BNB mark' },
  WAVAX: { of: 'AVAX', note: 'wrapper contract: the address-keyed logo (Trust Wallet, avalanche) is the AVAX mark' },
  WPOL: { of: 'POL', note: 'wrapper contract: the address-keyed logo (Trust Wallet, polygon) is the POL mark' },
  WHYPE: { of: 'HYPE', note: 'wrapper contract: no address-keyed logo found' },
};
/** network id → its own logo, or the logo of an asset (`asset`) when the network's mark is its coin's mark. */
const NETWORKS: Record<string, Src | { asset: string }> = {
  ethereum: { asset: 'ETH' }, base: w3('networks/branded', 'base', { plate: '#ffffff', scale: 0.6, verified: 'network name match, compared by eye with the Trust Wallet chain logo' }),
  arbitrum: w3('networks/background', 'arbitrum-one', { verified: 'network name match, compared by eye with the Trust Wallet chain logo' }),
  optimism: w3('networks/background', 'optimism', { verified: 'network name match, compared by eye with the Trust Wallet chain logo' }),
  polygon: { asset: 'POL' }, bsc: { asset: 'BNB' }, avalanche: { asset: 'AVAX' }, hyperevm: { asset: 'HYPE' }, bitcoin: { asset: 'BTC' }, litecoin: { asset: 'LTC' }, dogecoin: { asset: 'DOGE' },
  bitcoincash: { asset: 'BCH' }, solana: { asset: 'SOL' }, stellar: { asset: 'XLM' }, xrpl: { asset: 'XRP' }, tron: { asset: 'TRX' }, aptos: { asset: 'APT' }, cosmos: { asset: 'ATOM' }, sui: { asset: 'SUI' },
  near: { asset: 'NEAR' }, ton: { asset: 'TON' }, cardano: { asset: 'ADA' }, polkadot: { asset: 'DOT' },
};
const VENUES: Record<string, Src | { asset: string } | { fallback: string }> = {
  edgex: { fallback: 'no official edgeX mark was found in a licensed, address- or project-keyed registry on 2026-11-15 (Web3Icons has a ticker-keyed EDGE token logo whose owner could not be verified; edgeX publishes no brand kit under a redistribution licence): the venue is shown with its initials' },   // v11
  hyperliquid: { asset: 'HYPE' }, gmx: { asset: 'GMX' },
  dydx: cr('dydx/images/dydx-circle.svg', 'published by the dYdX chain in the chain registry'),
};
const PROVIDERS: Record<string, Src | { asset: string }> = {
  kyberswap: lifi('exchanges/kyberswap.svg', 'KyberSwap exchange icon'), jupiter: { asset: 'JUP' }, cctp: lifi('bridges/circle.svg', 'Circle (CCTP) bridge icon'),
  thorchain: cr('thorchain/images/rune.svg', 'published by THORChain in the chain registry', { plate: '#0e1116', scale: 0.6 }),
  lifi: lifi('bridges/lifi.svg', 'LI.FI own icon'), debridge: lifi('bridges/debridge.svg', 'deBridge bridge icon'),
  maya: cr('mayachain/images/maya.png', 'published by Maya Protocol in the chain registry'),
};

const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const cache = join(tmpdir(), 'spw-icon-cache'); mkdirSync(cache, { recursive: true });
async function download(url: string): Promise<Buffer> {
  const f = join(cache, createHash('sha256').update(url).digest('hex').slice(0, 24));
  if (existsSync(f)) return readFileSync(f);
  const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`);
  const b = Buffer.from(await r.arrayBuffer()); writeFileSync(f, b); return b;
}
function toWebp(png: Buffer): Buffer | null {
  try { const a = join(cache, 'in.png'), b = join(cache, 'out.webp'); writeFileSync(a, png); execFileSync('cwebp', ['-quiet', '-q', '88', '-m', '6', '-resize', '192', '192', a, '-o', b]); return readFileSync(b); } catch { return null; }
}
async function store(kind: string, id: string, s: Src) {
  const raw = await download(s.url); let ext: string, body: Buffer;
  if (s.url.endsWith('.svg')) {
    const svg = cleanSvg(raw.toString('utf8')); const bad = unsafeReason(svg);
    if (bad) throw new Error(`${kind}/${id}: refused (${bad}) — ${s.url}`);
    ext = 'svg'; body = Buffer.from(svg);
  } else {
    const dim = rasterSize(raw); if (!dim || dim.w < 128 || dim.h < 128) throw new Error(`${kind}/${id}: raster too small or unknown — ${s.url}`);
    const webp = dim.type === 'png' && Math.min(dim.w, dim.h) >= 192 ? toWebp(raw) : null;
    ext = webp && webp.length < raw.length ? 'webp' : dim.type; body = ext === 'webp' ? webp! : raw;
  }
  const file = `${kind}/${slug(id)}.${ext}`;
  mkdirSync(join(OUT, kind), { recursive: true }); writeFileSync(join(OUT, file), body);
  return { file, source: s.url, licence: `${LICENCES[s.lic].licence} — ${LICENCES[s.lic].name}`, verified: s.verified, ...(s.plate ? { plate: s.plate } : {}), ...(s.scale ? { scale: s.scale } : {}) };
}

const only = new Set(process.argv.slice(2));
const path = join(OUT, 'icons.json');
const manifest: any = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
manifest.note = 'Generated by apps/web/scripts/fetch-icons.mts. Logos are trademarks of their owners, shown unmodified to identify the asset, network or service (nominative use).';
manifest.licences = LICENCES;
for (const [key, kind, table] of [['assets', 'asset', ASSETS], ['networks', 'network', NETWORKS], ['venues', 'venue', VENUES], ['providers', 'provider', PROVIDERS]] as const) {
  manifest[key] ??= {};
  for (const [id, s] of Object.entries(table)) {
    if (only.size && !only.has(id)) continue;
    manifest[key][id] = 'url' in s ? { ...(await store(kind, id, s)), retrieved: new Date().toISOString().slice(0, 10) } : s;
    console.log(kind, id, 'url' in s ? manifest[key][id].file : JSON.stringify(s));
  }
}
writeFileSync(path, JSON.stringify(manifest, null, 1) + '\n');
