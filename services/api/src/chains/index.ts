import { NETWORKS, type NetworkDef } from '@spw/core';
import { aptosAdapter } from './aptos.ts';
import { bchAdapter } from './bch.ts';
import { btcAdapter } from './btc.ts';
import { cosmosAdapter } from './cosmos.ts';
import { evmAdapter } from './evm.ts';
import { solAdapter } from './sol.ts';
import { stellarAdapter } from './stellar.ts';
import { tronAdapter } from './tron.ts';
import { xrplAdapter } from './xrpl.ts';
import type { Adapter } from './rpc.ts';

/** Adapter factories for plugin families (registered by each family's API module). */
export const ADAPTER_FACTORIES: Record<string, (n: NetworkDef) => Adapter> = { evm: evmAdapter, btc: btcAdapter, sol: solAdapter, aptos: aptosAdapter, bch: bchAdapter, cosmos: cosmosAdapter, stellar: stellarAdapter, tron: tronAdapter, xrpl: xrplAdapter };
const make = (n: NetworkDef): Adapter => { const f = ADAPTER_FACTORIES[n.family]; if (!f) throw new Error(`no API adapter for family ${n.family}`); return f(n); };
export const adapters: Record<string, Adapter> = Object.fromEntries((Object.values(NETWORKS) as NetworkDef[]).map((n) => [n.id, make(n)]));
export const adapterFor = (network: string): Adapter => { const a = adapters[network]; if (!a) throw new Error(`unknown network ${network}`); return a; };
export * from './rpc.ts';
