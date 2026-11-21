/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/hyperliquid/helpers.ts
 * Module           : derivatives
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

// Shared test helpers: fixtures, a replaying fetch, instruments and assets taken from the recorded `meta`.
import { readFileSync } from 'node:fs';
import { sign } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Instrument } from '../../src/index.ts';
import { hlInstrument, hlMeta, signatureFromHex, typedDataDigest, type HlAsset, type HlSignature, type HlTypedData } from '../../src/venues/hyperliquid/index.ts';

export interface Fixture { recordedAt: string; network: 'mainnet' | 'testnet'; request: unknown; status: number; body: any }
export const fx = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../fixtures/hyperliquid/${name}.json`, import.meta.url), 'utf8'));
export const raw = (name: string): any => JSON.parse(readFileSync(new URL(`../fixtures/hyperliquid/${name}`, import.meta.url), 'utf8'));

/** The public test key of the official SDK's tests/signing_test.py — a published test vector, not a wallet. */
export const SDK_TEST_KEY: Hex = '0x0123456789012345678901234567890123456789012345678901234567890123';

/** Signs typed data the way the isolated signer will: EIP-712 digest, secp256k1, { r, s, v }. Test-only. */
export async function signWith(privateKey: Hex, td: HlTypedData): Promise<HlSignature> {
  return signatureFromHex(await sign({ hash: typedDataDigest(td), privateKey, to: 'hex' }));
}
/** SDK vectors print r and s without leading zeros (`to_hex(int)`): compare as integers */
export const sameSig = (a: { r: string; s: string; v: number }, b: { r: string; s: string; v: number }): boolean => BigInt(a.r) === BigInt(b.r) && BigInt(a.s) === BigInt(b.s) && a.v === b.v;

export type Route = { status?: number; body: unknown } | ((body: any) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>);
/** fetch that answers POST /info by request `type` (and POST /exchange under the key 'exchange'), recording every call */
export function replay(routes: Record<string, Route>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    const key = String(url).endsWith('/exchange') ? 'exchange' : body.type;
    const route = routes[key];
    if (!route) throw new Error(`no fixture for ${key}`);
    const r = typeof route === 'function' ? await route(body) : route;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export function universe(network: 'mainnet' | 'testnet' = 'mainnet'): { assets: HlAsset[]; instruments: Map<string, Instrument> } {
  const meta = hlMeta.parse(fx(`${network}-meta`).body);
  const instruments = new Map(meta.universe.map((u) => [u.name, hlInstrument(u)]));
  const assets = meta.universe.map((u, i) => ({ symbol: u.name, asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, isolatedOnly: instruments.get(u.name)!.marginModes.length === 1, delisted: u.isDelisted === true }));
  return { assets, instruments };
}
