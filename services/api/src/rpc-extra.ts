/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/rpc-extra.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// Additional RPC endpoints supplied by the operator (v11) — for example the owner's own node — on top of the two public
// endpoints pinned per network in @spw/core. With three or more endpoints a network keeps working when one of them is
// degraded (chains/rpc.ts: the failing endpoint is ejected, the others must still ALL answer and agree).
//
//   SPW_RPC_EXTRA='{"base":["https://my-node.example/base"],"ethereum":["https://..."]}'
//
// An extra endpoint is held to the same rules as the pinned ones: it takes part in every quorum read, so a wrong chain id,
// a wrong nonce or other contract code on it makes the read fail closed (rpc_disagreement) instead of being used.
import { NETWORKS } from '@spw/core';

export function applyRpcExtra(raw: string | undefined = process.env.SPW_RPC_EXTRA): Record<string, string[]> {
  if (!raw) return {};
  let map: Record<string, unknown>;
  try { map = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('SPW_RPC_EXTRA: not valid JSON (expected {"<network>": ["https://…"]})'); }
  const added: Record<string, string[]> = {};
  for (const [id, urls] of Object.entries(map)) {
    const n = NETWORKS[id];
    if (!n) throw new Error(`SPW_RPC_EXTRA: unknown network ${id}`);
    if (!Array.isArray(urls) || urls.some((u) => typeof u !== 'string')) throw new Error(`SPW_RPC_EXTRA: ${id} must be a list of URLs`);
    for (const u of urls as string[]) {
      let p: URL; try { p = new URL(u); } catch { throw new Error(`SPW_RPC_EXTRA: ${id}: invalid URL`); }
      if (p.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname)) throw new Error(`SPW_RPC_EXTRA: ${id}: only https (or a loopback address) is accepted`);
      if (!n.rpc.includes(u)) { n.rpc = [...n.rpc, u]; (added[id] ??= []).push(u); }
    }
  }
  return added;
}
