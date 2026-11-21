/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/icons.test.ts
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

// v9: the logo set. Every registry asset and network resolves to an existing, sanitised, self-hosted file (or a declared
// fallback); the sanitiser refuses what an SVG must never carry; variants that must not be confused are told apart.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../../../packages/core/src/networks.ts';
import { build, checkIcons, ICON_DIR, PROVIDER_IDS, readManifest, registry, UPCOMING_NETWORKS, VENUE_IDS } from '../scripts/gen-icons.mts';
import { cleanSvg, rasterSize, unsafeReason } from '../scripts/svg-sanitize.mts';
import { ASSET_ICONS, ICON_FALLBACKS, NETWORK_ICONS, PROVIDER_ICONS, VENUE_ICONS } from '../src/icons.gen.ts';

const SVG = (inner: string, attrs = 'viewBox="0 0 24 24"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('logo set', () => {
  it('passes the build check: nothing missing, nothing unsanitised, nothing undeclared, generated map up to date', () => {
    expect(checkIcons()).toEqual([]);
  });
  it('every registry symbol and every network (plus Cardano and Polkadot, which are landing) has a logo or a declared fallback', () => {
    const reg = registry();
    expect(reg.symbols.length).toBeGreaterThanOrEqual(95);
    for (const s of [...reg.symbols, 'ADA', 'DOT']) expect(ASSET_ICONS[s] ?? (ICON_FALLBACKS.includes(s) ? {} : undefined), `asset ${s}`).toBeDefined();
    for (const n of [...Object.keys(NETWORKS), ...UPCOMING_NETWORKS]) expect(NETWORK_ICONS[n], `network ${n}`).toBeDefined();
    for (const v of VENUE_IDS) expect(VENUE_ICONS[v] ?? (ICON_FALLBACKS.includes(`venue:${v}`) ? {} : undefined), `venue ${v}`).toBeDefined();   // v11: edgeX is a declared fallback
    for (const p of PROVIDER_IDS) expect(PROVIDER_ICONS[p], `provider ${p}`).toBeDefined();
  });
  it('every file exists, is a sanitised SVG or a raster of at least 128 px, and records its source, licence and date', () => {
    const m = readManifest(); let files = 0;
    for (const e of [...Object.values(m.assets), ...Object.values(m.networks), ...Object.values(m.venues), ...Object.values(m.providers)]) {
      if (!e.file) continue; files++;
      const p = join(ICON_DIR, e.file); expect(existsSync(p), e.file).toBe(true);
      const b = readFileSync(p);
      if (e.file.endsWith('.svg')) { const s = b.toString('utf8'); expect(unsafeReason(s), e.file).toBeNull(); expect(cleanSvg(s), e.file).toBe(s); }
      else { const d = rasterSize(b); expect(d, e.file).not.toBeNull(); expect(Math.min(d!.w, d!.h), e.file).toBeGreaterThanOrEqual(128); }
      expect(e.source, e.file).toMatch(/^https:\/\/raw\.githubusercontent\.com\//); expect(e.licence, e.file).toMatch(/MIT|CC0|Apache|CC-BY/); expect(e.retrieved, e.file).toMatch(/^\d{4}-\d\d-\d\d$/);
    }
    expect(files).toBeGreaterThanOrEqual(90);
    for (const kind of ['asset', 'network', 'venue', 'provider']) for (const f of readdirSync(join(ICON_DIR, kind))) expect(/\.(svg|webp|png)$/.test(f), f).toBe(true);
  });
  it('the app never points at a remote host for a logo', () => {
    const gen = readFileSync(join(ICON_DIR, '../icons.gen.ts'), 'utf8'), cmp = readFileSync(join(ICON_DIR, '../icons.tsx'), 'utf8');
    expect(gen).not.toMatch(/https?:\/\//); expect(cmp.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/https?:\/\//);
    for (const d of [...Object.values(ASSET_ICONS), ...Object.values(NETWORK_ICONS), ...Object.values(VENUE_ICONS), ...Object.values(PROVIDER_ICONS)]) expect(d.file).toMatch(/^(asset|network|venue|provider)\/[a-z0-9-]+\.(svg|webp|png)$/);
  });
  it('a missing logo, an unsanitised file or an undeclared file fails the check', () => {
    const m = readManifest();
    const { USDC: _gone, ...rest } = m.assets;
    expect(build({ ...m, assets: rest }).errors.join('\n')).toMatch(/asset USDC: in the registry, no logo and no declared fallback/);
    expect(build({ ...m, assets: rest }).errors.join('\n')).toMatch(/asset\/usdc\.svg: file not declared/);
    expect(build({ ...m, assets: { ...m.assets, USDC: { ...m.assets.USDC!, file: 'asset/nope.svg' } } }).errors.join('\n')).toMatch(/asset\/nope\.svg: file missing/);
    expect(build({ ...m, networks: { ...m.networks, base: { fallback: 'no legitimate source' } } }).stats.fallbacks).toContain('network:base');
  });
});

describe('variants that must not be confused', () => {
  it('distinct issuers keep distinct marks', () => {
    const files = ['BTC', 'WBTC', 'cbBTC', 'tBTC'].map((s) => ASSET_ICONS[s]!.file);
    expect(new Set(files).size).toBe(4);
    expect(new Set(['USDC', 'USDT', 'USDT0', 'USDe', 'USDS', 'USDG', 'USDD'].map((s) => ASSET_ICONS[s]!.file)).size).toBe(7);
    expect(new Set(['ETH', 'WETH', 'wstETH', 'rETH', 'cbETH', 'weETH'].map((s) => ASSET_ICONS[s]!.file)).size).toBe(6);
  });
  it('a representation without its own mark shows the underlying and is flagged to ALWAYS carry a network badge', () => {
    for (const [s, under] of [['USDC.e', 'USDC'], ['BTC.b', 'BTC'], ['BTCB', 'BTC'], ['WETH.e', 'WETH'], ['LINK.e', 'LINK'], ['WBNB', 'BNB'], ['WAVAX', 'AVAX'], ['WPOL', 'POL'], ['WHYPE', 'HYPE']] as const) {
      expect(ASSET_ICONS[s]!.of, s).toBe(under); expect(ASSET_ICONS[s]!.file).toBe(ASSET_ICONS[under]!.file); expect(ASSET_ICONS[s]!.home, s).toBeUndefined();
    }
    expect(ASSET_ICONS.BTCB!.only).toBe('bsc'); expect(ASSET_ICONS['BTC.b']!.only).toBe('avalanche'); expect(ASSET_ICONS.WBNB!.only).toBe('bsc'); expect(ASSET_ICONS['USDC.e']!.only).toBeUndefined();
  });
  it('a coin has no badge on its home network only', () => {
    expect(ASSET_ICONS.BTC!.home).toBe('bitcoin'); expect(ASSET_ICONS.ETH!.home).toBe('ethereum'); expect(ASSET_ICONS.SOL!.home).toBe('solana'); expect(ASSET_ICONS.BNB!.home).toBe('bsc');
    expect(ASSET_ICONS.USDC!.home).toBeUndefined();   // a token: always badged with its network
  });
});

describe('SVG sanitiser', () => {
  it('cleans what a logo does not need and is idempotent', () => {
    const dirty = `<?xml version="1.0"?>\n<!-- made with X -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="32" height="32" inkscape:version="1">\n  <metadata>x</metadata><title>t</title>\n  <path d="M0 0h1"/>\n</svg>`;
    const c = cleanSvg(dirty);
    expect(c).toBe('<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h1"/></svg>\n');
    expect(cleanSvg(c)).toBe(c); expect(unsafeReason(c)).toBeNull();
  });
  it.each([
    ['script', SVG('<script>alert(1)</script>')], ['foreignObject', SVG('<foreignObject><div/></foreignObject>')], ['event handler', SVG('<path d="M0 0" onload="x()"/>')],
    ['remote href', SVG('<use href="https://evil.example/x.svg#a"/>')], ['remote xlink:href', SVG('<use xlink:href="//evil.example/x.svg#a"/>')], ['embedded raster', SVG('<image href="data:image/png;base64,AAAA"/>')],
    ['remote url()', SVG('<path style="fill:url(https://evil.example/p)" d="M0 0"/>')], ['javascript URL', SVG('<a href="javascript:alert(1)"><path d="M0 0"/></a>')], ['css import', SVG('<style>@import "x.css";</style>')],
    ['animation', SVG('<set attributeName="href" to="x"/>')], ['no viewBox', SVG('<path d="M0 0"/>', 'width="10"')], ['iframe', SVG('<iframe src="x"/>')],
  ])('refuses %s', (_name, svg) => { expect(unsafeReason(svg)).not.toBeNull(); });
  it('refuses an entity declaration outright and accepts local references', () => {
    expect(() => cleanSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')).toThrow();
    expect(unsafeReason(SVG('<defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0"/><use href="#g"/>'))).toBeNull();
  });
});
