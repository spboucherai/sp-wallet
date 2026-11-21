/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/src/graph.ts
 * Module           : swap
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

// Universal liquidity graph. Nodes are (asset, network) pairs from the wallet's verified registry. Capability edges say
// "this provider claims it can convert A to B"; they only select what to quote. An edge becomes a route only through a
// live, validated quote — a pair is never presented as executable because a provider advertises it.
import { NETWORKS, type NetworkDef } from '@spw/core';
import { assetKey, type AssetRef, type SwapProvider } from './types.ts';

export interface GraphNode extends AssetRef { key: string; symbol: string; name: string; decimals: number; networkName: string; native: boolean; hub: boolean }
export interface CapabilityEdge { from: string; to: string; provider: string; crossChain: boolean }
export interface Observation { provider: string; from: string; to: string; amountIn: string; amountOut: string; minAmountOut: string; ms: number; at: number; ok: boolean }

/** Intermediate assets worth routing through: deep, widely quoted. Chosen by identity (registry entry), not by symbol alone. */
const HUB_SYMBOLS = new Set(['USDC', 'USDT']);

export class LiquidityGraph {
  readonly nodes = new Map<string, GraphNode>();
  private out = new Map<string, CapabilityEdge[]>();
  private obs: Observation[] = [];
  constructor(private providers: SwapProvider[]) {
    for (const n of Object.values(NETWORKS) as NetworkDef[]) for (const a of [n.native, ...n.tokens]) {
      const ref = { network: n.id, asset: a.id }, key = assetKey(ref);
      this.nodes.set(key, { ...ref, key, symbol: a.symbol, name: a.name, decimals: a.decimals, networkName: n.name, native: a.id === 'native', hub: a.id === 'native' || HUB_SYMBOLS.has(a.symbol) });
    }
  }
  /** Capability edges out of a node, computed lazily (providers answer locally, no network). */
  edgesFrom(key: string): CapabilityEdge[] {
    let e = this.out.get(key);
    if (e) return e;
    const from = this.nodes.get(key); e = [];
    if (from) for (const p of this.providers) { const cap = p.capabilities(); if (cap.needsKey && !cap.configured) continue;
      for (const to of this.nodes.values()) if (to.key !== key && p.supportsPair(from, to)) e.push({ from: key, to: to.key, provider: p.id, crossChain: from.network !== to.network }); }
    this.out.set(key, e);
    return e;
  }
  /** Is there any advertised way from A to B within `maxHops`? Used to tell "no provider covers this" from "no liquidity right now". */
  reachable(a: AssetRef, b: AssetRef, maxHops = 2): boolean { return this.paths(a, b, maxHops).length > 0; }
  /** Candidate paths A → (hub) → B, direct first; intermediates are hub assets only, never the endpoints again. */
  paths(a: AssetRef, b: AssetRef, maxHops = 2): string[][] {
    const src = assetKey(a), dst = assetKey(b), res: string[][] = [];
    const direct = this.edgesFrom(src).some((e) => e.to === dst);
    if (direct) res.push([src, dst]);
    if (maxHops >= 2) {
      const mids = new Set(this.edgesFrom(src).map((e) => e.to));
      for (const m of mids) { const node = this.nodes.get(m); if (!node?.hub || m === dst || m === src) continue;
        // an intermediate must live on the source or the destination network: no detour through a third chain
        if (node.network !== a.network && node.network !== b.network) continue;
        if (this.edgesFrom(m).some((e) => e.to === dst)) res.push([src, m, dst]); }
    }
    return res;
  }
  observe(o: Observation): void { this.obs.push(o); if (this.obs.length > 5000) this.obs.splice(0, this.obs.length - 5000); }
  observations(): Observation[] { return this.obs; }
}
