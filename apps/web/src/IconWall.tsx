/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/IconWall.tsx
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-19
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

// Development only (main.tsx mounts it at /__icons when import.meta.env.DEV; the production bundle does not contain it):
// every logo of the set on one page, to LOOK at them — recognisable, centred, not clipped, readable on both themes.
// tests/e2e/v9-icon-wall.mts screenshots it at phone and desktop sizes, light and dark.
import { ASSET_ICONS, NETWORK_ICONS, PROVIDER_ICONS, VENUE_ICONS } from './icons.gen';
import { AssetIcon, NetworkIcon, ProviderIcon, VenueIcon } from './icons';

const VARIANTS: [string, string][] = [['ETH', 'ethereum'], ['ETH', 'base'], ['ETH', 'arbitrum'], ['ETH', 'optimism'], ['ETH', 'bsc'], ['WETH', 'ethereum'], ['WETH.e', 'avalanche'],
  ['BTC', 'bitcoin'], ['WBTC', 'ethereum'], ['cbBTC', 'base'], ['tBTC', 'ethereum'], ['BTCB', 'bsc'], ['BTC.b', 'avalanche'],
  ['USDC', 'ethereum'], ['USDC', 'base'], ['USDC', 'solana'], ['USDC', 'bsc'], ['USDC.e', 'polygon'], ['USDC.e', 'arbitrum'], ['USDT', 'ethereum'], ['USDT', 'tron'], ['USDT', 'base'], ['USDT0', 'arbitrum'],
  ['BNB', 'bsc'], ['WBNB', 'bsc'], ['AVAX', 'avalanche'], ['WAVAX', 'avalanche'], ['POL', 'polygon'], ['WPOL', 'polygon'], ['HYPE', 'hyperevm'], ['WHYPE', 'hyperevm'], ['SOL', 'solana'], ['SOL', 'bsc'], ['KPEPE', ''], ['FARTCOIN', '']];

export function IconWall() {
  const cell = (key: string, icon: React.ReactNode, label: string, sub?: string) => <li key={key} className="flex w-[76px] flex-col items-center gap-1.5 text-center"><span className="grid h-14 place-items-center">{icon}</span><span className="w-full truncate text-[0.6875rem] font-semibold">{label}</span>{sub && <span className="-mt-1.5 w-full truncate text-[0.625rem] text-mute">{sub}</span>}</li>;
  const section = (title: string, n: number, children: React.ReactNode) => <section className="card p-5"><h2 className="mb-4 text-[0.9375rem] font-semibold">{title} <span className="font-normal text-mute">· {n}</span></h2><ul className="flex flex-wrap gap-x-2 gap-y-4">{children}</ul></section>;
  const assets = Object.keys(ASSET_ICONS);
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4" data-testid="icon-wall">
      <h1 className="t-title">Icon wall</h1>
      {section('Assets (48 px)', assets.length, assets.map((s) => cell(s, <AssetIcon sym={s} size={48} />, s)))}
      {section('Variants that must not be confused (44 px, with network badge)', VARIANTS.length, VARIANTS.map(([s, n]) => cell(s + n, <AssetIcon sym={s} net={n || undefined} size={44} />, s, n || 'fallback')))}
      {section('Sizes 20 – 96', 6, [20, 28, 36, 44, 64, 96].map((z) => <li key={z} className="flex flex-col items-center gap-2 px-2"><span className="flex items-end gap-3"><AssetIcon sym="USDC" net="base" size={z} /><AssetIcon sym="ETH" net="arbitrum" size={z} /><AssetIcon sym="cbBTC" net="base" size={z} /></span><span className="text-[0.6875rem] text-mute">{z}px</span></li>))}
      {section('Networks', Object.keys(NETWORK_ICONS).length, Object.keys(NETWORK_ICONS).map((n) => cell(n, <NetworkIcon net={n} size={44} />, n)))}
      {section('Networks at badge size (16 / 20 px)', Object.keys(NETWORK_ICONS).length, Object.keys(NETWORK_ICONS).map((n) => <li key={n} className="flex items-center gap-1.5 text-[0.75rem]"><NetworkIcon net={n} size={16} /><NetworkIcon net={n} size={20} />{n}</li>))}
      {section('Derivative venues', Object.keys(VENUE_ICONS).length, Object.keys(VENUE_ICONS).map((n) => cell(n, <VenueIcon venue={n} size={44} />, n)))}
      {section('Swap providers', Object.keys(PROVIDER_ICONS).length, Object.keys(PROVIDER_ICONS).map((n) => cell(n, <ProviderIcon provider={n} size={44} />, n)))}
    </main>
  );
}
